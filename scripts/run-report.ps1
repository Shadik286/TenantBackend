$ErrorActionPreference = 'Continue'
cd E:\Tenant\TenantManagementBackend
Remove-Item .\scripts\report-resp.json -ErrorAction SilentlyContinue
Remove-Item .\scripts\report-status.txt -ErrorAction SilentlyContinue

$nodeScript = @"
const https = require('https');
const http = require('http');
const { URL } = require('url');

const TOKEN = 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..NlCKE_RpOxFm_r9K.obGAzuEe80pMNdIoIdrLTqssGm6g2tQUlIce129d7zvIwj3Y7r-nD9CFXkyTlRV_trPCkqaFmvNbRapZ92TURRDwxsIFkql3MjvGadG_JxaOFlg1puAZB1wqiP7mu-tTJ9NQ-loznHQDmH5nM7dh08LHVbejBscUlpLm_Kek8LbEs1xKMdtbTi7zrvy3qqS7KjxnYWYx9J_kn6EOIv6C95BaRKmDpcKIzl5FMStprY7C37ILL5hDE1qpWMzwvmMoJK2kqYBmrNp4oUWj0T9IGIVEUMglyMSigg.0EiAQKWtLGX4iQgoU5Z5Sw';
const h = 'b47987d6-adf2-436b-9790-7309be1fa202';
const url = 'http://localhost:3000/api/reports/' + h + '?period=monthly&month=2026-07';

const u = new URL(url);
const opts = {
  hostname: u.hostname,
  port: u.port || 80,
  path: u.pathname + u.search,
  method: 'GET',
  headers: { 'Authorization': 'Bearer ' + TOKEN }
};

const t0 = Date.now();
const req = http.request(opts, (res) => {
  let chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const ms = Date.now() - t0;
    require('fs').writeFileSync('scripts/report-status.txt', 'HTTP ' + res.statusCode + ' in ' + ms + 'ms\n');
    require('fs').writeFileSync('scripts/report-resp.json', body);
    console.log('wrote ' + body.length + ' bytes');
  });
});
req.on('error', (e) => {
  require('fs').writeFileSync('scripts/report-status.txt', 'ERROR: ' + e.message + '\n');
  console.log('ERROR: ' + e.message);
});
req.end();
"@

$nodeScript | Out-File -Encoding utf8 .\scripts\run-report.js
node .\scripts\run-report.js 2>&1
Write-Host '---STATUS---'
Get-Content .\scripts\report-status.txt
Write-Host '---RESP---'
Get-Content .\scripts\report-resp.json