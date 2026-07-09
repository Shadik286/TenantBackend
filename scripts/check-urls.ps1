$urls = @(
  'https://tenant-backend-eta.vercel.app/api/health',
  'https://tenant-backend-3n5pmqjk1-shadik286s-projects.vercel.app/api/health',
  'https://tenant-backend-eta.vercel.app/',
  'https://tenant-backend-3n5pmqjk1-shadik286s-projects.vercel.app/'
)
foreach ($u in $urls) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri $u -TimeoutSec 10
    Write-Host ("{0} -> HTTP {1}" -f $u, $r.StatusCode)
  } catch {
    $code = '?'
    if ($_.Exception.Response) { $code = $_.Exception.Response.StatusCode.value__ }
    Write-Host ("{0} -> ERR code={1} msg={2}" -f $u, $code, $_.Exception.Message)
  }
}
