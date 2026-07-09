$ErrorActionPreference = "Continue"
Set-Location "E:\Tenant\TenantManagementBackend"
& npx tsx scripts/debug-login.ts testing1@gmail.com "testing1@gmail.com" *>&1 | Tee-Object -FilePath .\debug-out.txt
exit $LASTEXITCODE
