# Optional helper for running StarCore unattended on Windows, e.g. as the
# Action of a Task Scheduler task set to trigger "At log on" or "At startup".
#
# Task Scheduler action:
#   Program/script:  powershell.exe
#   Arguments:        -ExecutionPolicy Bypass -File "C:\path\to\starcore\deploy\windows\start-starcore.ps1"

$ErrorActionPreference = "Stop"

$EngineDir = Join-Path $PSScriptRoot "..\..\engine"
$Python = Join-Path $EngineDir ".venv\Scripts\python.exe"

Set-Location $EngineDir

if (Test-Path $Python) {
    & $Python -m starcore
} else {
    # no uv-managed venv found; fall back to whatever "python" resolves to
    python -m starcore
}
