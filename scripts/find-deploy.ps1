$headers = @{
  'user-agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TenantMgmt/1.0'
  'accept'     = 'application/json'
}
$candidates = @(
  'https://tenant-backend-eta.vercel.app',
  'https://tenant-backend-3n5pmqjk1-shadik286s-projects.vercel.app',
  'https://tenant-backend-shadik286s-projects.vercel.app',
  'https://tenant-management-backend.vercel.app',
  'https://tenant-backend.vercel.app'
)
foreach ($u in $candidates) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "$u/api/health" -Headers $headers -TimeoutSec 8
    Write-Host ("{0}/api/health -> HTTP {1}" -f $u, $r.StatusCode)
  } catch {
    if ($_.Exception.Response) {
      $code = $_.Exception.Response.StatusCode.value__
      Write-Host ("{0}/api/health -> HTTP {1}" -f $u, $code)
    } else {
      Write-Host ("{0}/api/health -> TIMEOUT/DNS" -f $u)
    }
  }
}
