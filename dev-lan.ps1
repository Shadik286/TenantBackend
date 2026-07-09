# Starts the Next.js dev server bound to all interfaces so a real Android
# device on the same Wi-Fi can reach it (LAN IP). Run from PowerShell:
#
#   PS> E:\Tenant\TenantManagementBackend\dev-lan.ps1
#
# It also runs from the backend directory so `npm` finds the right
# package.json (running `npm run dev` from E:\Tenant produced
# `ENOENT E:\Tenant\package.json`).

$ErrorActionPreference = "Stop"
Set-Location "E:\Tenant\TenantManagementBackend"
Write-Host "[dev-lan] cwd: $(Get-Location)" -ForegroundColor Cyan
& npx next dev -H 0.0.0.0 -p 3000 2>&1 | Tee-Object -FilePath "E:\Tenant\TenantManagementBackend\dev.log"
