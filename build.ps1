[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$PrepareOnly,
    [switch]$ToolsOnly,
    [switch]$SkipSystemInstall,
    [string]$Bundles = 'nsis,msi'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location -LiteralPath $PSScriptRoot
$nodeVersion = (Get-Content -LiteralPath '.node-version' -Raw).Trim()
if ($nodeVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid .node-version' }
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'This Windows bootstrap supports native x64 PowerShell. Use an x64 terminal.' }
$nodeDirectory = Join-Path $PSScriptRoot ".build-tools/node/node-v$nodeVersion-win-x64"
$nodeExecutable = Join-Path $nodeDirectory 'node.exe'
$installedNode = Get-Command node.exe -ErrorAction SilentlyContinue
if ($installedNode -and (& $installedNode.Source --version) -eq "v$nodeVersion" -and (& $installedNode.Source -p 'process.arch') -eq 'x64' -and (Test-Path -LiteralPath (Join-Path (Split-Path $installedNode.Source) 'node_modules/npm/bin/npm-cli.js'))) {
    $nodeExecutable = $installedNode.Source
} elseif (!(Test-Path -LiteralPath $nodeExecutable)) {
    if ($Check) { throw "Node $nodeVersion is not prepared. Run .\build.ps1 without -Check to download it." }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    function Get-Download([string]$Uri, [int]$TimeoutSec, [string]$OutFile) {
        try {
            if ($OutFile) { Invoke-WebRequest -UseBasicParsing -TimeoutSec $TimeoutSec -Uri $Uri -OutFile $OutFile }
            else { (Invoke-WebRequest -UseBasicParsing -TimeoutSec $TimeoutSec -Uri $Uri).Content }
        } catch {
            Write-Host "`nBuild stopped: downloading Node failed ($($_.Exception.Message))" -ForegroundColor Red
            Write-Host "Hint: rerun the script; on a company network the proxy may be cutting the connection. Check the address with: Invoke-WebRequest -Method Head $Uri. If it keeps failing, give IT that exact URL."
            exit 1
        }
    }
    $archiveName = "node-v$nodeVersion-win-x64.zip"
    $downloadDirectory = Join-Path $PSScriptRoot '.build-tools/downloads'
    New-Item -ItemType Directory -Force -Path $downloadDirectory | Out-Null
    $archivePath = Join-Path $downloadDirectory $archiveName
    $releaseUrl = "https://nodejs.org/dist/v$nodeVersion"
    Write-Host "Preparing official Node $nodeVersion (SHA-256 verified)..."
    $manifest = Get-Download "$releaseUrl/SHASUMS256.txt" 120
    $escapedName = [regex]::Escape($archiveName)
    $checksumMatch = [regex]::Match($manifest, "(?m)^([a-fA-F0-9]{64})\s+\*?$escapedName\r?$")
    if (!$checksumMatch.Success) { throw 'Node archive is missing from the official checksum manifest' }
    if (!(Test-Path -LiteralPath $archivePath) -or (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $checksumMatch.Groups[1].Value) {
        Get-Download "$releaseUrl/$archiveName" 180 $archivePath
    }
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $checksumMatch.Groups[1].Value) { throw 'Node checksum mismatch. Nothing was executed.' }
    $nodeCache = Join-Path $PSScriptRoot '.build-tools/node'
    New-Item -ItemType Directory -Force -Path $nodeCache | Out-Null
    Expand-Archive -LiteralPath $archivePath -DestinationPath $nodeCache -Force
}
if ((& $nodeExecutable --version) -ne "v$nodeVersion") { throw 'Cached Node version does not match .node-version' }
$env:PATH = "$(Split-Path $nodeExecutable);$env:PATH"
$bootstrapArguments = @('tools/bootstrap/build.mjs', '--bundles', $Bundles)
if ($Check) { $bootstrapArguments += '--check' }
if ($PrepareOnly) { $bootstrapArguments += '--prepare-only' }
if ($ToolsOnly) { $bootstrapArguments += '--tools-only' }
if ($SkipSystemInstall) { $bootstrapArguments += '--skip-system-install' }
& $nodeExecutable @bootstrapArguments
exit $LASTEXITCODE
