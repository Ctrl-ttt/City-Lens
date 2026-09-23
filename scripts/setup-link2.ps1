[CmdletBinding()]
param([string]$Proxy = '')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sdkRoot = Join-Path $projectRoot 'work/Link-SDK'
$revision = '2dd2c78186b0335a530042ae49accbef249d6a95'
$gitArgs = @()
if ($Proxy) { $gitArgs = @('-c', "http.proxy=$Proxy") }
if (!(Test-Path "$sdkRoot/.git")) {
    New-Item -ItemType Directory -Force (Join-Path $projectRoot 'work') | Out-Null
    & git @gitArgs clone https://github.com/Insta360Develop/Link-SDK.git $sdkRoot
    if ($LASTEXITCODE -ne 0) { throw 'SDK download failed. Retry with -Proxy if needed.' }
}
if (& git -C $sdkRoot status --porcelain) { throw 'SDK checkout has local edits; preserve them before rebuilding.' }
& git @gitArgs -C $sdkRoot fetch origin $revision
if ($LASTEXITCODE -ne 0) { throw 'Cannot fetch the pinned SDK revision.' }
& git -C $sdkRoot checkout --detach $revision
if ($LASTEXITCODE -ne 0) { throw 'Cannot check out the pinned SDK revision.' }
$vswhere = "${env:ProgramFiles(x86)}/Microsoft Visual Studio/Installer/vswhere.exe"
if (!(Test-Path $vswhere)) { throw 'Install Visual Studio 2022 with Desktop development with C++ and CMake tools.' }
$vsPath = & $vswhere -latest -version '[17.0,18.0)' -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vsPath) { throw 'Visual Studio 2022 C++ x64 build tools are required.' }
$cmakePath = Join-Path $vsPath 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
if (!(Test-Path $cmakePath)) { throw 'Install C++ CMake tools through Visual Studio Installer.' }
$buildRoot = Join-Path $projectRoot 'native/link2/build'
& $cmakePath -S (Join-Path $projectRoot 'native/link2') -B $buildRoot -G 'Visual Studio 17 2022' -A x64 "-DLINK_SDK_ROOT=$sdkRoot"
if ($LASTEXITCODE -ne 0) { throw 'CMake configuration failed.' }
& $cmakePath --build $buildRoot --config Release
if ($LASTEXITCODE -ne 0) { throw 'Link 2 bridge build failed.' }
& (Join-Path $buildRoot 'Release/citylens-link2.exe') list
if ($LASTEXITCODE -ne 0) { throw 'SDK could not enumerate cameras. Check the VC++ x64 runtime and USB connection.' }
Write-Host 'Link 2 SDK ready. Restart CityLens and refresh the camera list.'
