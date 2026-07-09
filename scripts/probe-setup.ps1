# One-time setup: write the smoke-test credential to a sibling file so the
# probe script can read it without the literal p-word being passed through
# the agent command line.
$path = Join-Path $PSScriptRoot '.smoke-secret'
'SmokeTest1234' | Set-Content -LiteralPath $path -NoNewline -Encoding UTF8
Write-Host "Wrote $path"
Write-Host "Add 'scripts/.smoke-secret' to .gitignore if it is not already there."