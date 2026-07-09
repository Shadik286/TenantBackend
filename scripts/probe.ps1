$ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$email = "smoke$ts@tenant-test.local"

# Read the secret from a sibling file so the literal does not appear in the
# script body (and so it never leaks through the model-visible command line).
$secretFile = Join-Path $PSScriptRoot '.smoke-secret'
if (-not (Test-Path $secretFile)) {
  throw ("Missing {0} - please run probe-setup.ps1 once to create it." -f $secretFile)
}
$pw = (Get-Content -LiteralPath $secretFile -Raw).Trim()

$payload = @{
  email    = $email
  fullName = 'Smoke Tester'
  password = $pw
} | ConvertTo-Json -Compress

Write-Host "EMAIL=$email"

$headers = @{
  'Content-Type' = 'application/json'
  'Accept'       = 'application/json'
}

try {
  $r = Invoke-WebRequest `
    -Uri 'https://tenant-backend-eta.vercel.app/api/auth/register' `
    -Method POST `
    -Headers $headers `
    -Body $payload `
    -TimeoutSec 25 `
    -UseBasicParsing `
    -ErrorAction Stop
  Write-Host "STATUS=$($r.StatusCode)"
  Write-Host "BODY=$($r.Content)"
} catch {
  $we = $_.Exception.Response
  Write-Host "STATUS=$([int]$we.StatusCode)"
  $sr = New-Object System.IO.StreamReader($we.GetResponseStream())
  $b = $sr.ReadToEnd()
  $sr.Close()
  Write-Host ("BODY=" + $b)
}