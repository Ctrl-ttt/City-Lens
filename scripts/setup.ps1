[CmdletBinding()]
param([string]$Proxy = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
    if (!(Get-Command py -ErrorAction SilentlyContinue)) { throw 'Install Python 3.13 or 3.14 (including the py launcher) first.' }
    if (!(Get-Command pnpm -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24 and pnpm 11.19.0 first.' }
    if (!(Test-Path '.venv/Scripts/python.exe')) {
        & py -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw 'Could not create Python virtual environment.' }
    }
    $pipArgs = @('-m', 'pip', 'install', '-r', 'backend/requirements.txt')
    if ($Proxy) { $pipArgs += @('--proxy', $Proxy) }
    & ./.venv/Scripts/python.exe @pipArgs
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed. If needed, pass -Proxy with your existing proxy URL.' }
    & pnpm --dir frontend install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
    & pnpm --dir frontend build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    if (!(Test-Path '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
    Write-Host 'Setup complete. Sample mode: .\scripts\start.ps1 -Sample'
    Write-Host 'Live mode: configure .env locally, then run .\scripts\start.ps1'
} finally { Pop-Location }
