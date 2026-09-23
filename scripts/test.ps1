[CmdletBinding()]
param([switch]$Browser)
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    $venvPython = Join-Path (Get-Location) '.venv/Scripts/python.exe'
    if (!(Test-Path -LiteralPath $venvPython)) { throw 'Python virtual environment is missing. Run .\scripts\setup.ps1 first.' }
    try { & $venvPython --version *> $null; $venvExit = $LASTEXITCODE } catch { $venvExit = 1 }
    if ($venvExit -ne 0) { throw 'Python virtual environment is invalid or points to another computer. Recreate only this project .venv, then rerun the tests.' }
    & $venvPython -m pytest backend/tests tools/test_x4_export.py tools/test_x4_equirect_unofficial.py -q
    if ($LASTEXITCODE -ne 0) { throw 'Backend or video export tool tests failed.' }
    & pnpm --dir frontend test
    if ($LASTEXITCODE -ne 0) { throw 'Frontend tests failed.' }
    & pnpm --dir frontend build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    if ($Browser) {
        & pnpm --dir frontend test:e2e
        if ($LASTEXITCODE -ne 0) { throw 'Browser tests failed. Check the Playwright output for a missing browser, port 8000 conflict, or failed assertion.' }
    }
} finally { Pop-Location }
