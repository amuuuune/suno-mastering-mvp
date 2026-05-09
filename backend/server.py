from __future__ import annotations

import argparse
import cgi
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from functools import lru_cache
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 18765
MAX_UPLOAD_BYTES = 250 * 1024 * 1024


@lru_cache(maxsize=1)
def find_ffmpeg() -> str | None:
    env_path = os.environ.get("FFMPEG_PATH")
    if env_path and Path(env_path).exists():
        return env_path
    project_ffmpeg = ROOT / "tools" / "ffmpeg" / "ffmpeg.exe"
    if project_ffmpeg.exists():
        return str(project_ffmpeg)
    path_ffmpeg = shutil.which("ffmpeg")
    if path_ffmpeg:
        return path_ffmpeg

    home = Path.home()
    candidates = [
        home / "claude" / "ytmp4-simple" / "ffmpeg.exe",
        Path("C:/ffmpeg/bin/ffmpeg.exe"),
        Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
        Path("C:/ProgramData/chocolatey/bin/ffmpeg.exe"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return None


def ffmpeg_version(ffmpeg: str) -> str:
    try:
        result = subprocess.run(
            [ffmpeg, "-version"],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    first_line = result.stdout.splitlines()[0] if result.stdout else ""
    return first_line.strip()


def json_response(handler: SimpleHTTPRequestHandler, status: HTTPStatus, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_cors_headers()
    handler.end_headers()
    handler.wfile.write(body)


def normalize_loudnorm_payload(payload: dict) -> dict:
    number_keys = [
        "input_i",
        "input_tp",
        "input_lra",
        "input_thresh",
        "output_i",
        "output_tp",
        "output_lra",
        "output_thresh",
        "target_offset",
    ]
    normalized = {}
    for key, value in payload.items():
        if key in number_keys:
            try:
                normalized[key] = float(value)
            except (TypeError, ValueError):
                normalized[key] = value
        else:
            normalized[key] = value
    return normalized


def parse_loudnorm_json(stderr: str) -> dict:
    matches = re.findall(r"\{[\s\S]*?\}", stderr)
    if not matches:
      raise ValueError("ffmpeg loudnorm output did not include JSON.")
    return normalize_loudnorm_payload(json.loads(matches[-1]))


def run_loudnorm_analysis(ffmpeg: str, input_path: Path, target_i: float, target_tp: float, target_lra: float) -> dict:
    command = [
        ffmpeg,
        "-hide_banner",
        "-nostats",
        "-i",
        str(input_path),
        "-af",
        f"loudnorm=I={target_i}:TP={target_tp}:LRA={target_lra}:print_format=json",
        "-f",
        "null",
        os.devnull,
    ]
    result = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr[-4000:] or "ffmpeg analysis failed.")
    return parse_loudnorm_json(result.stderr)


def loudnorm_filter_from_analysis(analysis: dict, target_i: float, target_tp: float, target_lra: float) -> str:
    return (
        f"loudnorm=I={target_i}:TP={target_tp}:LRA={target_lra}:"
        f"measured_I={analysis['input_i']}:"
        f"measured_TP={analysis['input_tp']}:"
        f"measured_LRA={analysis['input_lra']}:"
        f"measured_thresh={analysis['input_thresh']}:"
        f"offset={analysis['target_offset']}:"
        "linear=true:print_format=summary"
    )


def run_loudnorm_export(
    ffmpeg: str,
    input_path: Path,
    output_path: Path,
    target_i: float,
    target_tp: float,
    target_lra: float,
    output_format: str,
    bit_depth: int,
) -> dict:
    first_pass = run_loudnorm_analysis(ffmpeg, input_path, target_i, target_tp, target_lra)
    filter_arg = loudnorm_filter_from_analysis(first_pass, target_i, target_tp, target_lra)
    command = [
        ffmpeg,
        "-hide_banner",
        "-nostats",
        "-y",
        "-i",
        str(input_path),
        "-vn",
        "-af",
        filter_arg,
    ]
    if output_format == "mp3":
        command.extend(["-codec:a", "libmp3lame", "-b:a", "320k", "-id3v2_version", "3"])
    else:
        codec = "pcm_s16le" if bit_depth == 16 else "pcm_s24le"
        command.extend(["-codec:a", codec])
    command.append(str(output_path))

    result = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=240,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr[-4000:] or "ffmpeg precise export failed.")
    return run_loudnorm_analysis(ffmpeg, output_path, target_i, target_tp, target_lra)


class MasteringHandler(SimpleHTTPRequestHandler):
    server_version = "SunoMasteringBench/0.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format: str, *args) -> None:
        print(f"[server] {self.address_string()} - {format % args}", file=sys.stderr)

    def send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Expose-Headers", "Content-Disposition, X-SMB-LUFS, X-SMB-TRUE-PEAK, X-SMB-LRA")

    def end_headers(self) -> None:
        if not self.path.startswith("/api/"):
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/api/health":
            ffmpeg = find_ffmpeg()
            json_response(
                self,
                HTTPStatus.OK,
                {
                    "ok": True,
                    "ffmpeg": bool(ffmpeg),
                    "ffmpegPath": ffmpeg or "",
                    "version": ffmpeg_version(ffmpeg) if ffmpeg else "",
                },
            )
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path == "/api/analyze":
            self.handle_analyze()
            return
        if self.path == "/api/finalize":
            self.handle_finalize()
            return
        json_response(self, HTTPStatus.NOT_FOUND, {"ok": False, "error": "Unknown API endpoint."})

    def read_upload(self) -> tuple[Path, cgi.FieldStorage, tempfile.TemporaryDirectory]:
        content_length = int(self.headers.get("Content-Length", "0") or "0")
        if content_length <= 0:
            raise ValueError("No upload body was sent.")
        if content_length > MAX_UPLOAD_BYTES:
            raise ValueError("Upload is too large for this MVP.")

        form = cgi.FieldStorage(
            fp=self.rfile,
            headers=self.headers,
            environ={
                "REQUEST_METHOD": "POST",
                "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                "CONTENT_LENGTH": str(content_length),
            },
            keep_blank_values=True,
        )
        audio = form["audio"] if "audio" in form else None
        if audio is None or not getattr(audio, "file", None):
            raise ValueError("Missing audio file field.")

        temp_dir = tempfile.TemporaryDirectory(prefix="suno-mastering-")
        filename = unquote(getattr(audio, "filename", "") or "upload.wav")
        suffix = Path(filename).suffix or ".wav"
        input_path = Path(temp_dir.name) / f"input{suffix}"
        with input_path.open("wb") as output:
            shutil.copyfileobj(audio.file, output)
        return input_path, form, temp_dir

    def handle_analyze(self) -> None:
        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            json_response(self, HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "ffmpeg is not installed or not on PATH."})
            return
        temp_dir = None
        try:
            input_path, form, temp_dir = self.read_upload()
            target_i = float(form.getfirst("targetI", "-14"))
            target_tp = float(form.getfirst("targetTP", "-1"))
            target_lra = float(form.getfirst("targetLRA", "11"))
            analysis = run_loudnorm_analysis(ffmpeg, input_path, target_i, target_tp, target_lra)
            json_response(self, HTTPStatus.OK, {"ok": True, "analysis": analysis})
        except Exception as error:
            json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
        finally:
            if temp_dir:
                temp_dir.cleanup()

    def handle_finalize(self) -> None:
        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            json_response(self, HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "ffmpeg is not installed or not on PATH."})
            return
        temp_dir = None
        try:
            input_path, form, temp_dir = self.read_upload()
            output_format = form.getfirst("format", "wav").lower()
            if output_format not in {"wav", "mp3"}:
                raise ValueError("Unsupported finalize format.")
            bit_depth = 16 if form.getfirst("bitDepth", "24") == "16" else 24
            target_i = float(form.getfirst("targetI", "-14"))
            target_tp = float(form.getfirst("targetTP", "-1"))
            target_lra = float(form.getfirst("targetLRA", "11"))
            extension = ".mp3" if output_format == "mp3" else ".wav"
            output_name = Path(form.getfirst("name", f"master{extension}")).name
            if not output_name.lower().endswith(extension):
                output_name += extension
            output_path = Path(temp_dir.name) / f"output{extension}"
            final_analysis = run_loudnorm_export(
                ffmpeg,
                input_path,
                output_path,
                target_i,
                target_tp,
                target_lra,
                output_format,
                bit_depth,
            )
            payload = output_path.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "audio/mpeg" if output_format == "mp3" else "audio/wav")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Content-Disposition", f'attachment; filename="{output_name}"')
            self.send_header("X-SMB-LUFS", str(final_analysis.get("input_i", "")))
            self.send_header("X-SMB-TRUE-PEAK", str(final_analysis.get("input_tp", "")))
            self.send_header("X-SMB-LRA", str(final_analysis.get("input_lra", "")))
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(payload)
        except Exception as error:
            json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
        finally:
            if temp_dir:
                temp_dir.cleanup()

def main() -> None:
    parser = argparse.ArgumentParser(description="Local backend for Suno Mastering Bench.")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()

    address = (args.host, args.port)
    httpd = ThreadingHTTPServer(address, MasteringHandler)
    print(f"Suno Mastering Bench: http://{args.host}:{args.port}/")
    ffmpeg = find_ffmpeg()
    if ffmpeg:
        print(f"ffmpeg: {ffmpeg}")
    else:
        print("ffmpeg: not found. Precise LUFS/True Peak and MP3 export will be unavailable.")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
