from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PROJECT_NAME = ROOT.name
REGISTRY_PATH = ROOT.parent / "PORT_REGISTRY.json"
HOST = "127.0.0.1"
DEFAULT_PORT = 18765
LOG_DIR = ROOT / "logs"
PID_FILE = LOG_DIR / "server.pid"


def log(message: str) -> None:
    LOG_DIR.mkdir(exist_ok=True)
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}"
    with (LOG_DIR / "launcher.log").open("a", encoding="utf-8") as output:
        output.write(line + "\n")
    print(message)


def url_for(port: int) -> str:
    return f"http://{HOST}:{port}/"


def health(port: int) -> dict | None:
    try:
        with urllib.request.urlopen(f"{url_for(port)}api/health", timeout=1.0) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError):
        return None
    if payload.get("ok") is True and "ffmpeg" in payload:
        return payload
    return None


def is_port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind((HOST, port))
        except OSError:
            return False
    return True


def registry_entries() -> dict[int, dict]:
    if not REGISTRY_PATH.exists():
        return {}
    try:
        payload = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    entries = {}
    for entry in payload.get("ports", []):
        try:
            entries[int(entry["port"])] = entry
        except (KeyError, TypeError, ValueError):
            continue
    return entries


def choose_port() -> int:
    registered = registry_entries()
    default_owner = registered.get(DEFAULT_PORT, {}).get("project")
    if default_owner and default_owner != PROJECT_NAME:
        raise RuntimeError(f"Port {DEFAULT_PORT} is registered to {default_owner}, not {PROJECT_NAME}.")
    if health(DEFAULT_PORT):
        return DEFAULT_PORT
    for port in range(DEFAULT_PORT, DEFAULT_PORT + 50):
        owner = registered.get(port, {}).get("project")
        if owner and owner != PROJECT_NAME:
            continue
        if is_port_free(port):
            return port
    raise RuntimeError("No free local port found.")


def find_ffmpeg() -> str | None:
    candidates = [
        ROOT / "tools" / "ffmpeg" / "ffmpeg.exe",
        Path.home() / "claude" / "ytmp4-simple" / "ffmpeg.exe",
        Path("C:/ffmpeg/bin/ffmpeg.exe"),
        Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
        Path("C:/ProgramData/chocolatey/bin/ffmpeg.exe"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return None


def wait_for_server(port: int, timeout_seconds: float = 8.0) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if health(port):
            return True
        time.sleep(0.25)
    return False


def start_server(port: int) -> subprocess.Popen:
    LOG_DIR.mkdir(exist_ok=True)
    env = os.environ.copy()
    env.setdefault("PYTHONIOENCODING", "utf-8")
    if not env.get("FFMPEG_PATH"):
        ffmpeg = find_ffmpeg()
        if ffmpeg:
            env["FFMPEG_PATH"] = ffmpeg

    log_path = LOG_DIR / "server.log"
    with log_path.open("ab") as server_log:
        process = subprocess.Popen(
            [
                sys.executable,
                str(ROOT / "backend" / "server.py"),
                "--host",
                HOST,
                "--port",
                str(port),
            ],
            cwd=str(ROOT),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=server_log,
            stderr=server_log,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )

    PID_FILE.write_text(str(process.pid), encoding="utf-8")
    return process


def browser_candidates() -> list[Path]:
    program_files = [
        os.environ.get("PROGRAMFILES", r"C:\Program Files"),
        os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"),
        os.environ.get("LOCALAPPDATA", ""),
    ]
    relative_paths = [
        ("Google", "Chrome", "Application", "chrome.exe"),
        ("Microsoft", "Edge", "Application", "msedge.exe"),
        ("BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ]
    candidates: list[Path] = []
    for base in program_files:
        if not base:
            continue
        for parts in relative_paths:
            candidates.append(Path(base, *parts))
    return candidates


def find_browser() -> Path | None:
    for candidate in browser_candidates():
        if candidate.exists():
            return candidate
    return None


def open_app_window_and_wait(port: int) -> None:
    app_url = url_for(port)
    browser = find_browser()
    if not browser:
        log("Dedicated browser not found. Opening default browser without auto-stop.")
        webbrowser.open(app_url)
        return

    with tempfile.TemporaryDirectory(prefix="smb-browser-") as profile:
        process = subprocess.Popen(
            [
                str(browser),
                f"--app={app_url}",
                f"--user-data-dir={profile}",
                "--no-first-run",
                "--disable-features=Translate",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        log(f"Opened app window: {app_url}")
        process.wait()


def stop_process(process: subprocess.Popen | None) -> None:
    if not process or process.poll() is not None:
        return
    try:
        process.terminate()
        process.wait(timeout=3)
    except (OSError, subprocess.TimeoutExpired):
        try:
            os.kill(process.pid, signal.SIGTERM)
        except OSError:
            pass


def launch_app_window() -> int:
    port = choose_port()
    existing = health(port)
    server_process = None
    if existing:
        log(f"Using already running server: {url_for(port)}")
    else:
        server_process = start_server(port)
        if not wait_for_server(port):
            stop_process(server_process)
            log("Server did not become ready. Check logs/server.log.")
            return 1
        log(f"Started server: {url_for(port)}")

    try:
        open_app_window_and_wait(port)
    finally:
        if server_process:
            stop_process(server_process)
            log("Closed app window. Server stopped.")
            try:
                PID_FILE.unlink()
            except OSError:
                pass
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Launcher for Suno Mastering Bench.")
    parser.add_argument("--app-window", action="store_true")
    args = parser.parse_args()

    if args.app_window:
        return launch_app_window()

    port = choose_port()
    if not health(port):
        server_process = start_server(port)
        if not wait_for_server(port):
            stop_process(server_process)
            log("Server did not become ready. Check logs/server.log.")
            return 1
    log(f"Running: {url_for(port)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
