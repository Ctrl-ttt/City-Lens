<#
.SYNOPSIS
    构建 CityLens 的 Insta360 Link SDK 桥接工具 linkctl.exe

.DESCRIPTION
    Link SDK 只提供 C++ 类库（UVCCamera.dll + UVCCamera.lib），Python 无法直接调用，
    因此用 MSVC 编译一个薄包装命令行工具。

    注意：SDK 预编译库是 Release 版，必须用 /MD 匹配，否则会出现 CRT 堆不匹配导致崩溃。

.PARAMETER Clean
    先删除中间产物与可执行文件再构建。

.EXAMPLE
    pwsh -File tools\linkctl\build.ps1
#>
[CmdletBinding()]
param(
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'

$root      = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # 仓库根目录
$toolDir   = $PSScriptRoot
$sdkDir    = Join-Path $root 'third_party\linksdk\x64'
$includeDir = Join-Path $sdkDir 'include'
$libDir    = Join-Path $sdkDir 'lib'
$binDir    = Join-Path $sdkDir 'bin'
$objDir    = Join-Path $toolDir 'obj'
$exePath   = Join-Path $binDir 'linkctl.exe'

Write-Host '=== CityLens · linkctl 构建 ===' -ForegroundColor Cyan

# --- 前置检查 ---------------------------------------------------------------
$source = Join-Path $toolDir 'linkctl.cc'
if (-not (Test-Path $source))        { throw "找不到源文件: $source" }
if (-not (Test-Path $includeDir))    { throw "找不到 SDK 头文件目录: $includeDir" }
if (-not (Test-Path $libDir))        { throw "找不到 SDK 库目录: $libDir" }
if (-not (Test-Path (Join-Path $binDir 'UVCCamera.dll'))) {
    throw "找不到 UVCCamera.dll: $binDir"
}

if ($Clean) {
    if (Test-Path $objDir)  { Remove-Item -Recurse -Force $objDir }
    if (Test-Path $exePath) { Remove-Item -Force $exePath }
    Write-Host '已清理中间产物' -ForegroundColor DarkGray
}

New-Item -ItemType Directory -Force -Path $objDir, $binDir | Out-Null

# --- 定位 MSVC --------------------------------------------------------------
function Find-VcVars {
    # 1) 已在本机其他位置安装
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $vswhere) {
        $install = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if ($install) {
            $candidate = Join-Path $install 'VC\Auxiliary\Build\vcvars64.bat'
            if (Test-Path $candidate) { return $candidate }
        }
    }

    # 2) 常见路径（本机 VS2022 安装在 D:\vs2022）
    $roots = @('D:\vs2022', 'C:\Program Files\Microsoft Visual Studio\2022\Community',
               'C:\Program Files\Microsoft Visual Studio\2022\Professional',
               'C:\Program Files\Microsoft Visual Studio\2022\Enterprise',
               'C:\Program Files (x86)\Microsoft Visual Studio\2019\Community')
    foreach ($r in $roots) {
        $candidate = Join-Path $r 'VC\Auxiliary\Build\vcvars64.bat'
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

$vcvars = Find-VcVars
if (-not $vcvars) {
    throw @'
未找到 MSVC 工具链（vcvars64.bat）。

Link SDK 只提供 MSVC 格式的 .lib，无法用 MinGW/g++ 链接。
请安装 Visual Studio 2022 的「使用 C++ 的桌面开发」工作负载，然后重新运行本脚本。
'@
}
Write-Host "MSVC: $vcvars" -ForegroundColor DarkGray

# --- 编译 -------------------------------------------------------------------
# /utf-8   必需：源码中的中文错误消息要作为 UTF-8 进入 JSON，否则默认 GBK 会产出非法 UTF-8
# /MD      与预编译的 Release 版 SDK 库保持一致（DLL 导入 MSVCP140.dll，即 Release 运行库）
# /DWIN32  必需，勿删！见下方说明
# /std:c++14 SDK 示例使用 C++11，取超集
#
# 关于 /DWIN32（踩过的坑，务必保留）
# ----------------------------------
# uvc_common.h 用 `#ifdef WIN32` 在两种 UVCCameraInfo 布局之间切换：
#     WIN32 定义   -> { std::string, std::string, int, uint16, uint16 }   72 字节
#     WIN32 未定义 -> { uint32, uint16, uint16, std::string, ... }        80 字节
#
# 注意这里用的是 WIN32 而不是编译器自动定义的 _WIN32。Visual Studio 的 C++ 工程
# 默认会定义 WIN32，所以 SDK 官方示例能正常工作；但直接用 cl 命令行编译时 WIN32
# 是不存在的，于是我们的代码按 80 字节布局解析，而 DLL 按 72 字节写入。
#
# 后果非常隐蔽：std::vector 的 size() 是用 (last - first) / sizeof(T) 算出来的，
# 1 个元素时 72 / 80 == 0，表现为「明明插了相机却枚举到 0 台」，
# 而且不会报错、不会崩溃，只是静默返回空列表。
#
# 验证方法：sizeof(UVCCameraInfo) 必须是 72；若是 80 就说明这个宏漏了。
$clArgs = @(
    '/nologo',
    '/O2', '/MD', '/EHsc', '/std:c++14', '/utf-8', '/W3',
    '/DWIN32',
    '/D_CRT_SECURE_NO_WARNINGS',
    "/I`"$includeDir`"",
    "/Fo:`"$objDir\\`"",
    "/Fe:`"$exePath`"",
    "`"$source`"",
    '/link',
    "/LIBPATH:`"$libDir`"",
    'UVCCamera.lib', 'llog.lib'
)

$cmd = 'call "{0}" >nul 2>&1 && cl.exe {1}' -f $vcvars, ($clArgs -join ' ')

Write-Host '编译中...' -ForegroundColor Cyan
$output = & cmd.exe /c $cmd 2>&1
$exit = $LASTEXITCODE
$output | Where-Object { $_ -notmatch '^\s*$' } | ForEach-Object { Write-Host "  $_" }

if ($exit -ne 0) {
    throw "编译失败（退出码 $exit）"
}

if (-not (Test-Path $exePath)) {
    throw "编译声称成功但未生成 $exePath"
}

$size = [math]::Round((Get-Item $exePath).Length / 1KB, 1)
Write-Host ""
Write-Host "构建成功: $exePath ($size KB)" -ForegroundColor Green
Write-Host "自检命令: & '$exePath' list" -ForegroundColor DarkGray
