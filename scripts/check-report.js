// One-shot probe for the monthly reports endpoint. Writes the raw response
// body and status to scripts/report-resp.{json,status} so the caller can read
// them without being polluted by the running next dev server's stdout.
const fs = require('fs')
const path = require('path')

const TOKEN =
  'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..NlCKE_RpOxFm_r9K.obGAzuEe80pMNdIoIdrLTqssGm6g2tQUlIce129d7zvIwj3Y7r-nD9CFXkyTlRV_trPCkqaFmvNbRapZ92TURRDwxsIFkql3MjvGadG_JxaOFlg1puAZB1wqiP7mu-tTJ9NQ-loznHQDmH5nM7dh08LHVbejBscUlpLm_Kek8LbEs1xKMdtbTi7zrvy3qqS7KjxnYWYx9J_kn6EOIv6C95BaRKmDpcKIzl5FMStprY7C37ILL5hDE1qpWMzwvmMoJK2kqYBmrNp4oUWj0T9IGIVEUMglyMSigg.0EiAQKWtLGX4iQgoU5Z5Sw'
const HOUSE = 'b47987d6-adf2-436b-9790-7309be1fa202'
const url = `http://localhost:3000/api/reports/${HOUSE}?period=monthly&month=2026-07`

;(async () => {
  const t0 = Date.now()
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } })
    const body = await res.text()
    const ms = Date.now() - t0
    fs.writeFileSync(
      path.join(__dirname, 'report-status.txt'),
      `HTTP ${res.status} in ${ms}ms\n`,
    )
    fs.writeFileSync(path.join(__dirname, 'report-resp.json'), body)
    process.exit(0)
  } catch (e) {
    fs.writeFileSync(
      path.join(__dirname, 'report-status.txt'),
      `ERROR: ${e.message}\n`,
    )
    process.exit(1)
  }
})()