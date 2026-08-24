# Removes the bitcoin-nostr-bridge Windows service installed by install-service.ps1.
# Usage (elevated PowerShell): .\deploy\windows\uninstall-service.ps1

$ErrorActionPreference = "Stop"
$ServiceName = "bitcoin-nostr-bridge"

$nssm = Get-Command nssm.exe -ErrorAction SilentlyContinue
if (-not $nssm) {
    Write-Error "nssm.exe not found on PATH."
    exit 1
}

& nssm stop $ServiceName
& nssm remove $ServiceName confirm
Write-Host "Service '$ServiceName' removed."
