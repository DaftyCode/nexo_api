<#
.SYNOPSIS
  Installs the Nexo API web version on this computer and starts it.

.DESCRIPTION
  The first run prepares Node, Rust and the dependencies (through build.ps1), builds the
  web site and the API server, starts both in the background and opens the browser.
  Later runs start the installed version directly, rebuilding only when the sources changed.

.EXAMPLE
  .\install-web.ps1            # install if needed, start and open the browser
.EXAMPLE
  .\install-web.ps1 -Stop      # stop the background services
#>
[CmdletBinding()]
param(
    [switch]$Stop,
    [switch]$Status,
    [switch]$Rebuild,
    [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location -LiteralPath $PSScriptRoot

$version = (Get-Content -LiteralPath '.node-version' -Raw).Trim()
function Find-Node {
    $prepared = Join-Path $PSScriptRoot ".build-tools/node/node-v$version-win-x64/node.exe"
    if (Test-Path -LiteralPath $prepared) { return $prepared }
    $system = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($system -and (& $system.Source --version) -eq "v$version" -and
        (Test-Path -LiteralPath (Join-Path (Split-Path $system.Source) 'node_modules/npm/bin/npm-cli.js'))) {
        return $system.Source
    }
    return $null
}

$node = Find-Node
$cargo = Join-Path $env:USERPROFILE '.cargo/bin/cargo.exe'
$ready = $node -and (Test-Path -LiteralPath 'node_modules/.package-lock.json') -and (Test-Path -LiteralPath $cargo)
if (-not $ready -and -not $Stop -and -not $Status) {
    Write-Host 'Preparing Node, Rust and dependencies (first run only)...'
    & (Join-Path $PSScriptRoot 'build.ps1') -PrepareOnly
    if ($LASTEXITCODE) { throw "Preparation failed with exit code $LASTEXITCODE." }
    $node = Find-Node
}
if (-not $node) { throw "Node $version is not available. Run .\build.ps1 -PrepareOnly and try again." }

$arguments = @('tools/install/web.mjs')
if ($Stop) { $arguments += '--stop' }
if ($Status) { $arguments += '--status' }
if ($Rebuild) { $arguments += '--rebuild' }
if ($NoOpen) { $arguments += '--no-open' }
& $node @arguments
exit $LASTEXITCODE
