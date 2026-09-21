[CmdletBinding()]
param([switch]$Sample, [switch]$Build, [ValidateSet('bicycle','stairs','sign','empty','unclear')][string]$Scene = 'bicycle')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$oldProvider = $env:CITYLENS_PROVIDER
$oldScene = $env:CITYLENS_SAMPLE_SCENE
Push-Location $projectRoot
try {
    if (!(Test-Path '.venv/Scripts/python.exe')) { throw 'Run .\scripts\setup.ps1 first.' }
    if ($Build) {
        & pnpm --dir frontend build
        if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    }
    if (!(Test-Path 'frontend/dist/index.html')) { throw 'Run .\scripts\setup.ps1 or add -Build first.' }
    if ($Sample) {
        $env:CITYLENS_PROVIDER = 'sample'
        $env:CITYLENS_SAMPLE_SCENE = $Scene
        Write-Host 'FIXED SAMPLE MODE: no actual visual recognition, no cloud upload.'
    } else {
        $env:CITYLENS_PROVIDER = 'live'
        Write-Host 'LIVE MODE: configure your model key in .env before analysis.'
    }
    Write-Host 'Open http://localhost:8000 . Press Ctrl+C here to stop.'
    & ./.venv/Scripts/python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
    if ($LASTEXITCODE -ne 0) { throw 'Server stopped with an error. Check whether port 8000 is already in use.' }
} finally {
    $env:CITYLENS_PROVIDER = $oldProvider
    $env:CITYLENS_SAMPLE_SCENE = $oldScene
    Pop-Location
}
