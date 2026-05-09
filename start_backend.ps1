$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

if (-not $env:FFMPEG_PATH) {
  $candidates = @(
    "$ScriptDir\tools\ffmpeg\ffmpeg.exe",
    "$env:USERPROFILE\claude\ytmp4-simple\ffmpeg.exe",
    "C:\ffmpeg\bin\ffmpeg.exe",
    "C:\tools\ffmpeg\bin\ffmpeg.exe",
    "C:\ProgramData\chocolatey\bin\ffmpeg.exe"
  )

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      $env:FFMPEG_PATH = $candidate
      break
    }
  }
}

python .\backend\server.py --host 127.0.0.1 --port 18765
