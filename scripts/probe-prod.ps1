$base = 'https://tenant-backend.vercel.app'
$ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$email = "probe+$ts@probe.local"
$pw = 'ProbePass123!'

Write-Host "== BASE ==" $base -ForegroundColor Cyan
try {
  $health = Invoke-WebRequest -UseBasicParsing -Uri "$base/api/health" -TimeoutSec 10
  Write-Host "HEALTH code=$($health.StatusCode) body=$($health.Content)"
} catch {
  Write-Host "HEALTH err=$($_.Exception.Message)"
}

Write-Host ""
Write-Host "== REGISTER ==" -ForegroundColor Cyan
$body = @{ email = $email; password = $pw; fullName = 'Probe User' } | ConvertTo-Json
try {
  $r = Invoke-WebRequest -UseBasicParsing -Method POST -Uri "$base/api/auth/register" `
    -ContentType 'application/json' -Body $body -TimeoutSec 15
  Write-Host "REGISTER code=$($r.StatusCode) body=$($r.Content)"
} catch {
  Write-Host "REGISTER err=$($_.Exception.Message)"
  if ($_.Exception.Response) {
    $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    Write-Host "REGISTER body=$($sr.ReadToEnd())"
  }
}

Write-Host ""
Write-Host "== LOGIN ==" -ForegroundColor Cyan
$login = @{ identifier = $email; password = $pw } | ConvertTo-Json
try {
  $r = Invoke-WebRequest -UseBasicParsing -Method POST -Uri "$base/api/auth/login" `
    -ContentType 'application/json' -Body $login -TimeoutSec 15
  Write-Host "LOGIN code=$($r.StatusCode) body=$($r.Content)"
} catch {
  Write-Host "LOGIN err=$($_.Exception.Message)"
  if ($_.Exception.Response) {
    $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    Write-Host "LOGIN body=$($sr.ReadToEnd())"
  }
}
