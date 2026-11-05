<#
.SYNOPSIS
  Builds the Nexo API desktop app for this Windows computer and installs it silently.

.DESCRIPTION
  Builds only the Windows Installer package (.msi) with build.ps1 and installs it with
  msiexec, the Windows Installer service. No downloaded .exe installer is executed, which
  suits computers whose policy only allows Windows Installer packages.

  Missing build tools are prepared first: Node (official archive, checksum verified) and
  Rustup are downloaded; the C++ Build Tools, WebView2 and Git are installed through WinGet.
  Installing for all users needs administrator rights; Windows asks for them once.

.EXAMPLE
  .\install-desktop.ps1
.EXAMPLE
  .\install-desktop.ps1 -Package .\Nexo.API_0.1.0_x64_en-US.msi   # install an existing package
#>
[CmdletBinding()]
param(
    # Install this .msi instead of building one.
    [string]$Package,
    # Do not start Nexo API after installing it.
    [switch]$NoLaunch,
    # Use the build tools already present; do not install system prerequisites.
    [switch]$SkipSystemInstall
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location -LiteralPath $PSScriptRoot

if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) {
    throw 'This script installs on Windows. On macOS or Linux run: bash install-desktop.sh'
}

if (-not $Package) {
    Write-Host 'Building the Windows Installer package for this computer...'
    $arguments = @{ Bundles = 'msi' }
    if ($SkipSystemInstall) { $arguments.SkipSystemInstall = $true }
    & (Join-Path $PSScriptRoot 'build.ps1') @arguments
    # build.ps1 already printed why it stopped and what to do; a PowerShell error would bury it.
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    $Package = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'target/release/bundle/msi') -Filter '*.msi' |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $Package) { throw 'No .msi package was produced. Check the build output above.' }
}
$Package = (Resolve-Path -LiteralPath $Package).Path
$logDirectory = Join-Path $PSScriptRoot '.build-tools/logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$log = Join-Path $logDirectory ("install-desktop-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))

Write-Host "Installing $Package with Windows Installer (msiexec)..."
$msiArguments = @('/i', "`"$Package`"", '/qn', '/norestart', '/l*v', "`"$log`"")
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$process = if ($elevated) {
    Start-Process -FilePath 'msiexec.exe' -ArgumentList $msiArguments -Wait -PassThru
} else {
    # Windows asks for confirmation once; msiexec is the system installer, not the package.
    Start-Process -FilePath 'msiexec.exe' -ArgumentList $msiArguments -Wait -PassThru -Verb RunAs
}
switch ($process.ExitCode) {
    0 { Write-Host 'Nexo API is installed.' }
    3010 { Write-Host 'Nexo API is installed. Windows will finish the installation after a restart.' }
    1602 { throw 'The installation was cancelled.' }
    1625 { throw 'Your organization''s policy blocks this installation. Ask IT to deploy the .msi package.' }
    default { throw "msiexec failed with exit code $($process.ExitCode). Details: $log" }
}

# The executable is named after the product or the crate depending on the Tauri version.
$installed = @(
    (Join-Path $env:ProgramFiles 'Nexo API'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Nexo API')
) | Where-Object { Test-Path -LiteralPath $_ } |
    ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*.exe' -File } |
    Where-Object { $_.Name -notmatch 'uninstall' } |
    Select-Object -First 1 -ExpandProperty FullName
if ($installed) {
    Write-Host "Location: $installed"
    if (-not $NoLaunch) { Start-Process -FilePath $installed }
} else {
    Write-Host 'Open Nexo API from the Start menu.'
}
