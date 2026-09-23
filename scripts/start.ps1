[CmdletBinding()]
param([switch]$Sample, [switch]$Realtime, [switch]$Build, [ValidateSet('stairs','sign','empty','unclear')][string]$Scene = 'empty')
$ErrorActionPreference = 'Stop'
if ($Sample -and $Realtime) { throw 'Choose either -Sample or -Realtime.' }
$projectRoot = Split-Path -Parent $PSScriptRoot
$oldProvider = $env:CITYLENS_PROVIDER
$oldScene = $env:CITYLENS_SAMPLE_SCENE
Push-Location $projectRoot
try {
    $venvPython = Join-Path $projectRoot '.venv/Scripts/python.exe'
    if (!(Test-Path -LiteralPath $venvPython)) { throw 'Run .\scripts\setup.ps1 first.' }
    try { & $venvPython --version *> $null; $venvExit = $LASTEXITCODE } catch { $venvExit = 1 }
    if ($venvExit -ne 0) { throw 'Python virtual environment is invalid or points to another computer. Recreate only this project .venv, then rerun .\scripts\setup.ps1.' }
    if ($Build) {
        & pnpm --dir frontend build
        if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    }
    if (!(Test-Path 'frontend/dist/index.html')) { throw 'Run .\scripts\setup.ps1 or add -Build first.' }
    if ($Sample) {
        $env:CITYLENS_PROVIDER = 'sample'
        $env:CITYLENS_SAMPLE_SCENE = $Scene
        Write-Host 'FIXED SAMPLE MODE: no actual visual recognition, no cloud upload.'
    } elseif ($Realtime) {
        $env:CITYLENS_PROVIDER = 'realtime'
        Write-Host 'REALTIME MODE: visual frames over WebSocket; no microphone input.'
    } else {
        $env:CITYLENS_PROVIDER = 'live'
        Write-Host 'LIVE MODE: configure your model key in .env before analysis.'
    }
    Write-Host 'Open http://localhost:8000 . Press Ctrl+C here to stop.'
    & $venvPython -m uvicorn backend.app:app --host 127.0.0.1 --port 8000 --ws-max-size 264192 --ws-max-queue 1
    if ($LASTEXITCODE -ne 0) { throw 'Server stopped with an error. Check whether port 8000 is already in use.' }
} finally {
    $env:CITYLENS_PROVIDER = $oldProvider
    $env:CITYLENS_SAMPLE_SCENE = $oldScene
    Pop-Location
}
