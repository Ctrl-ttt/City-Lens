[CmdletBinding()]
param([switch]$Browser)
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    & ./.venv/Scripts/python.exe -m pytest backend/tests tools/test_x4_export.py tools/test_x4_equirect_unofficial.py -q
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
