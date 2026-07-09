# End-to-end smoke probe against the deployed Vercel backend.
# Run AFTER `vercel --prod` (or git push to main) so the Node runtime pin
# on /api/auth/[...nextauth] is live.
#
# Usage:
#   $env:PROBE_EMAIL = "probe+$((Get-Date).Ticks)@example.com"
#   powershell -ExecutionPolicy Bypass -File scripts\probe-vercel.ps1
#
# Override targets with -BaseUrl / -Email / -Password.

[CmdletBinding()]
param(
    [string]$BaseUrl = "https://tenant-backend-eta.vercel.app",
    [string]$Email   = $env:PROBE_EMAIL,
    [string]$Password = "ProbePass123!",
    [string]$FullName = "Probe User"
)

$ErrorActionPreference = "Stop"

if (-not $Email) { $Email = "probe+$((Get-Date).Ticks)@example.com" }

function Step($label, $scriptBlock) {
    Write-Host ""
    Write-Host "== $label ==" -ForegroundColor Cyan
    & $scriptBlock
}

$headers = @{ "Content-Type" = "application/json" }

Step "POST /api/auth/register" {
    $body = @{
        email    = $Email
        password = $Password
        fullName = $FullName
    } | ConvertTo-Json
    $r = Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/auth/register" -Headers $headers -Body $body
    Write-Host ("registered: " + ($r | ConvertTo-Json -Depth 4))
}

Step "POST /api/auth/login" {
    $body = @{ identifier = $Email; password = $Password } | ConvertTo-Json
    $r = Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/auth/login" -Headers $headers -Body $body
    if (-not $r.ok) { throw "login returned ok=false: $($r | ConvertTo-Json)" }
    $script:Token = $r.token
    Write-Host ("token length: " + $r.token.Length)
}

$authHeaders = @{
    "Content-Type"  = "application/json"
    "Authorization" = "Bearer $Token"
}

Step "GET /api/houses" {
    try {
        $r = Invoke-RestMethod -Method GET -Uri "$BaseUrl/api/houses" -Headers $authHeaders
        Write-Host ("houses: " + ($r | ConvertTo-Json -Depth 4))
    } catch {
        $code = $_.Exception.Response.StatusCode.value__
        Write-Host ("houses threw HTTP $code (expected if endpoint shape differs from Flutter; logged for comparison)")
    }
}

Step "GET /api/tenants" {
    try {
        $r = Invoke-RestMethod -Method GET -Uri "$BaseUrl/api/tenants" -Headers $authHeaders
        Write-Host ("tenants: " + ($r | ConvertTo-Json -Depth 4))
    } catch {
        $code = $_.Exception.Response.StatusCode.value__
        Write-Host ("tenants threw HTTP $code (expected if endpoint shape differs from Flutter; logged for comparison)")
    }
}

Write-Host ""
Write-Host "DONE: login + Bearer roundtrip succeeded against $BaseUrl" -ForegroundColor Green
