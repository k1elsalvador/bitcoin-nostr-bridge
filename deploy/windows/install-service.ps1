# Installs bitcoin-nostr-bridge as a Windows service via NSSM.
#
# Requires nssm.exe (https://nssm.cc/download) somewhere on PATH. NSSM was
# chosen over an npm-installed service wrapper deliberately: it's a single,
# long-proven native binary with zero Node dependencies of its own — the
# safer choice for production infrastructure on a RAM-constrained machine.
#
# Usage (run from an elevated/Administrator PowerShell prompt):
#   cd path\to\bitcoin-nostr-bridge
#   .\deploy\windows\install-service.ps1

$ErrorActionPreference = "Stop"

$ServiceName = "bitcoin-nostr-bridge"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$LogDir = Join-Path $ProjectRoot "logs"

$nssm = Get-Command nssm.exe -ErrorAction SilentlyContinue
if (-not $nssm) {
    Write-Error "nssm.exe not found on PATH. Download it from https://nssm.cc/download, " `
        "extract the win64\nssm.exe that matches your system, and either add it to PATH " `
        "or place it in this repo's deploy\windows\ folder before re-running this script."
    exit 1
}

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error "node.exe not found on PATH. Install Node.js 18+ first."
    exit 1
}

if (-not (Test-Path (Join-Path $ProjectRoot "config.json"))) {
    Write-Error "config.json not found in $ProjectRoot — copy config.example.json to " `
        "config.json and fill it in before installing the service."
    exit 1
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Write-Host "Installing service '$ServiceName'..."
& nssm install $ServiceName $node.Source
# --max-old-space-size caps V8's heap — a deliberate safety net on a
# RAM-constrained host, well above what this workload actually needs
# (baseline RSS is well under 100MB; see README's memory footprint notes).
& nssm set $ServiceName AppParameters "--max-old-space-size=128 src\index.js"
& nssm set $ServiceName AppDirectory $ProjectRoot
& nssm set $ServiceName AppStdout (Join-Path $LogDir "bridge.log")
& nssm set $ServiceName AppStderr (Join-Path $LogDir "bridge.log")
& nssm set $ServiceName AppRotateFiles 1
& nssm set $ServiceName AppRotateOnline 1
& nssm set $ServiceName AppRotateBytes 10485760
& nssm set $ServiceName Start SERVICE_AUTO_START
& nssm set $ServiceName AppExit Default Restart
& nssm set $ServiceName AppRestartDelay 5000

Write-Host "Starting service..."
& nssm start $ServiceName

Write-Host "`nDone. Live log: Get-Content -Wait '$LogDir\bridge.log'"
Write-Host "Manage the service with: nssm status $ServiceName / nssm stop $ServiceName / nssm restart $ServiceName"
