# TokenGo installer for Windows.
#
#   irm https://raw.githubusercontent.com/zxcrf/tokengo-cli/main/install.ps1 | iex
#
# Set $env:VERSION (e.g. "1.18.33-tokengo.1") to install a specific release.
# `tokengo upgrade` re-runs this script with VERSION set.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# Windows PowerShell 5.1 defaults to TLS 1.0, which GitHub rejects.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = "zxcrf/tokengo-cli"
$InstallDir = Join-Path $HOME ".tokengo\bin"

$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$target = switch ($arch) {
    "AMD64" { "x64" }
    "ARM64" { "arm64" }
    default { throw "Unsupported architecture: $arch" }
}
if ($target -eq "x64") {
    # 40 = PF_AVX2_INSTRUCTIONS_AVAILABLE; CPUs without AVX2 need the baseline build.
    $kernel32 = Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(int f);' -Name Kernel32 -Namespace TokenGoInstall -PassThru
    if (-not $kernel32::IsProcessorFeaturePresent(40)) { $target = "x64-baseline" }
}
$filename = "tokengo-windows-$target.zip"

$version = if ($env:VERSION) { $env:VERSION -replace '^v', '' } else {
    (Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/$Repo/releases/latest").tag_name -replace '^v', ''
}
if (-not $version) { throw "Failed to fetch version information" }
$url = "https://github.com/$Repo/releases/download/v$version/$filename"

Write-Host "Installing tokengo $version ($target)"
$tmp = Join-Path ([IO.Path]::GetTempPath()) "tokengo_install_$PID"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile (Join-Path $tmp $filename)
    Expand-Archive -Force -Path (Join-Path $tmp $filename) -DestinationPath $tmp

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $exe = Join-Path $InstallDir "tokengo.exe"
    # A running exe cannot be overwritten but can be renamed, so `tokengo upgrade` can replace itself.
    if (Test-Path $exe) {
        Remove-Item -Force "$exe.old" -ErrorAction SilentlyContinue
        Move-Item -Force $exe "$exe.old"
    }
    Move-Item -Force (Join-Path $tmp "tokengo.exe") $exe
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $InstallDir) {
    [Environment]::SetEnvironmentVariable("Path", (@($InstallDir, $userPath) | Where-Object { $_ }) -join ";", "User")
    Write-Host "Added $InstallDir to your user PATH. Open a new terminal to use tokengo."
}
if ($env:GITHUB_PATH) { Add-Content -Path $env:GITHUB_PATH -Value $InstallDir }

Write-Host ""
Write-Host "TokenGo installed. To start:"
Write-Host "  cd <project>"
Write-Host "  tokengo"
Write-Host ""
Write-Host "More information: https://github.com/$Repo"
