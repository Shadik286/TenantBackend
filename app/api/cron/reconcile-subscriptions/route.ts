import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { syncSubscriptionWithBdapps } from "@/lib/plans/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// GET /api/cron/reconcile-subscriptions
// ---------------------------------------------------------------------------
//
// bdApps is the authority on who is paying; our Subscription table is a cache
// of that. The two drift, because renewals and cancellations happen on the
// operator's side and nothing tells us:
//
//   * A user renews with their carrier -> bdApps says REGISTERED, we still
//     show an expired period and have downgraded them.
//   * A user stops paying -> bdApps says UNREGISTERED, we still grant PRO.
//
// This job reconciles the two for every PRO subscription whose period has
// ended, which is exactly the monthly renewal boundary.
//
// THE CRITICAL RULE: a gateway failure is not a cancellation.
//
// `checkBdappsSubscription` returns TIMEOUT / GATEWAY_ERROR / UNPARSEABLE as
// distinct from NOT_REGISTERED. Only a definite NOT_REGISTERED downgrades
// anyone. Treating an outage as "everybody unsubscribed" would cancel every
// paying customer the first time bdApps had a bad afternoon — the same
// asymmetry `enforceBdappsSubscription` already applies at login.
//
// Protected by CRON_SECRET, sent either as `Authorization: Bearer <secret>`
// (Vercel Cron's own format) or `?secret=`.

/** How many accounts one invocation will touch. Keeps the run inside the
 *  serverless time limit; the rest are picked up on the next pass. */
const BATCH_SIZE = 100;

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  // With no secret configured the endpoint stays shut rather than open —
  // it can downgrade accounts, so failing closed is the only safe default.
  if (!secret) return false;

  const header = request.headers.get("authorization") ?? "";
  if (header === `Bearer ${secret}`) return true;
  return request.nextUrl.searchParams.get("secret") === secret;
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();

  // Who gets checked, and when.
  //
  // A paid subscription is checked ONE MONTH AFTER it was granted, not daily.
  // `current_period_end` is set to +30 days on every grant and renewal, so
  // "period has ended" IS the monthly anniversary of the purchase: buy today,
  // and the next check is this date next month. Between those dates there is
  // nothing to ask — the user has already paid for that window.
  //
  // The second group is narrow on purpose. An earlier version swept every
  // FREE account that had a phone number, which meant a bdApps call per free
  // user per night forever — thousands of requests to answer a question
  // almost none of them had asked. Instead: only FREE accounts that actually
  // TRIED to subscribe recently, which is exactly the population where the
  // return redirect can have been missed or interrupted.
  const recentAttemptCutoff = new Date(now);
  recentAttemptCutoff.setDate(recentAttemptCutoff.getDate() - 7);

  const due = await prisma.subscription.findMany({
    where: {
      OR: [
        // 1. Paid plan whose month is up — renew or downgrade.
        { current_period_end: { lt: now }, plan: { name: { not: "FREE" } } },
        // 2. Free, but started a subscription in the last week. Catches the
        //    "paid and the app never noticed" case without polling everyone.
        {
          plan: { name: "FREE" },
          user: {
            phone: { not: null },
            subscription_auths: {
              some: { created_at: { gte: recentAttemptCutoff } },
            },
          },
        },
      ],
    },
    take: BATCH_SIZE,
    orderBy: { current_period_end: "asc" },
    include: {
      plan: { select: { name: true } },
      user: { select: { id: true, phone: true, provider: true } },
    },
  });

  const summary = {
    examined: due.length,
    upgraded: 0,
    renewed: 0,
    downgraded: 0,
    alreadyCorrect: 0,
    skippedNoPhone: 0,
    skippedGatewayError: 0,
  };

  // The per-user decision lives in lib/plans/sync.ts, shared with the
  // on-demand sync endpoint. Two copies of "should this account be PRO"
  // would eventually disagree, and the disagreement would be about money.
  for (const subscription of due) {
    const result = await syncSubscriptionWithBdapps(subscription.user.id);

    switch (result.outcome) {
      case "UPGRADED":
        summary.upgraded += 1;
        break;
      case "RENEWED":
        summary.renewed += 1;
        break;
      case "DOWNGRADED":
        summary.downgraded += 1;
        break;
      case "ALREADY_CORRECT":
        summary.alreadyCorrect += 1;
        break;
      case "NO_PHONE":
        summary.skippedNoPhone += 1;
        break;
      case "GATEWAY_UNCLEAR":
        summary.skippedGatewayError += 1;
        break;
    }
  }

  console.log("[reconcile] run complete", summary);
  return NextResponse.json({ ok: true, data: summary });
}
