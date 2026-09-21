[CmdletBinding()]
param([switch]$Browser)
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    & ./.venv/Scripts/python.exe -m pytest backend/tests -q
    if ($LASTEXITCODE -ne 0) { throw 'Backend tests failed.' }
    & pnpm --dir frontend test
    if ($LASTEXITCODE -ne 0) { throw 'Frontend tests failed.' }
    & pnpm --dir frontend build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    if ($Browser) {
        & pnpm --dir frontend test:e2e
        if ($LASTEXITCODE -ne 0) { throw 'Browser tests failed. Stop the existing port 8000 server before retrying.' }
    }
} finally { Pop-Location }
