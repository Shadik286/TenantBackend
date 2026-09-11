# Function region — why `sin1`

`vercel.json` pins serverless functions to **`sin1` (Singapore)**. It is a
one-line file because `vercel.json` is schema-validated and rejects any
property it does not recognise, comment-shaped or not — so the reasoning lives
here instead.

## The problem it fixes

Vercel defaults functions to **`iad1` (Washington DC)**. The Supabase database
is in **`ap-southeast-1` (Singapore)** — about 15,000 km away, roughly **230 ms
per round trip**.

`connection_limit=1` (required for the Supabase pooler on serverless) means
Prisma serialises queries onto a single connection, so round trips **add up**
rather than overlap:

| Route | DB round trips | Latency floor |
|---|---|---|
| `/api/auth/login` | 6 | ~1.4 s |
| `/api/tenants` | 9 | ~2.1 s |
| `/api/payments` | 11 | ~2.5 s |

Measured before the change: **`/api/health` — a single `SELECT 1` — took
1.6–1.7 s of server time.** The query is trivial; the distance is not. Cold
instances paid another ~0.7–1 s on connection setup, because the TCP handshake,
the TLS handshake and Postgres authentication are each a round trip to
Singapore.

## The rule

**Region follows the DATABASE, not the users.** One request makes 6–11 trips to
the database and exactly one to the user, so co-locating with Postgres wins by
an order of magnitude. Singapore also happens to be far closer to users in
Bangladesh than Washington DC, so there is no trade-off here.

## If a database moves, change this file

| Environment | Database region | Correct function region |
|---|---|---|
| Preview / dev | `ap-southeast-1` (Singapore) | `sin1` ✅ co-located |
| **Production** | `ap-northeast-1` (Tokyo) | ⚠️ still ~70 ms per query from `sin1` |

Production is the loose end: its database is in Tokyo, so it does not get the
full benefit. Moving it to `ap-southeast-1` would put both environments on the
same footing. Until then `sin1` is still the better compromise — 70 ms beats
230 ms, and preview gets the full win.

## Verify after deploying

`vercel.json` regions can be overridden by the project setting on some plans.
Confirm under **Vercel → Settings → Functions**, or check the build output for
the region tag beside each lambda (`λ index (1.02MB) [sin1]`).
