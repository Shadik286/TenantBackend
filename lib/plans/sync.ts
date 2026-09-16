// Make our Subscription table agree with bdApps.
//
// bdApps is the authority on who is paying; our table is a cache. They drift
// in BOTH directions, and until now only one of them was handled:
//
//   they say REGISTERED, we say FREE   -> user paid and got nothing
//   they say UNREGISTERED, we say PRO  -> user stopped paying, kept PRO
//
// The first case is the one that bites real customers, because it is silent:
// the money left their account and the app never changed. It happens whenever
// the return redirect is missed, mis-parsed, or interrupted — closing the
// browser a second early is enough.
//
// This is shared by the nightly cron and by the "sync now" endpoint so the
// two can never apply different rules.
import { prisma } from "@/lib/prisma";
import { checkBdappsSubscription } from "@/lib/bdapps";
import { checkBkashSubscriber } from "@/lib/bdapps/subscribers";
import { subscriberPhoneFromReturn } from "@/lib/bdapps/subscription";
import { Prisma } from "@prisma/client";

/** How long a confirmed subscription is granted for before it is re-checked. */
const RENEWAL_DAYS = 30;

export type SyncOutcome =
  | "UPGRADED"
  | "RENEWED"
  | "DOWNGRADED"
  | "ALREADY_CORRECT"
  | "NO_PHONE"
  | "GATEWAY_UNCLEAR";

export type SyncResult = {
  outcome: SyncOutcome;
  /** The plan the user is on after this ran. */
  planName: string;
  detail?: string;
};

/**
 * Reconcile one user against bdApps.
 *
 * Never throws — callers are a cron loop and a user-facing endpoint, and
 * neither should fail because one account or one gateway call misbehaved.
 */
export async function syncSubscriptionWithBdapps(
  userId: string,
): Promise<SyncResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      phone: true,
      subscription: { include: { plan: { select: { name: true } } } },
    },
  });

  const currentPlan = user?.subscription?.plan.name ?? "FREE";
  // Hoisted: the phone lookup below no longer narrows `user` for the rest
  // of the function, and every later branch wants this row.
  const subscription = user?.subscription ?? null;

  // The phone is the only key bdApps understands. A Google signup has none on
  // file until the capture screen runs, so before giving up, look at what
  // bdApps itself handed back on the last authorization return - that payload
  // carries the subscribing number, and it is the gateway's word, not the
  // client's.
  const phone = user?.phone ?? (await phoneFromLastAuthorization(userId));

  if (!phone) {
    // Nothing to ask bdApps about. Deliberately NOT a downgrade: a user who
    // paid by some other route must not be cancelled for lacking a number.
    return { outcome: "NO_PHONE", planName: currentPlan };
  }

  // Learned it from the return payload: write it down so the next check (and
  // the nightly reconciliation) does not have to rediscover it.
  if (!user?.phone) {
    try {
      await prisma.user.update({ where: { id: userId }, data: { phone } });
    } catch {
      // Already taken by another account. The check below still runs.
    }
  }

  // bdApps decides. checkBdappsSubscription asks every application we have a
  // bridge for (carrier, and bKash when BDAPPS_BKASH_BASE is set), so a
  // subscriber of either kind is visible here.
  //
  // The bKash registry counts too, because getStatus CANNOT answer for a
  // bKash subscriber. Verified against a real paying number: getStatus
  // reports E1951 "already unregistered" while the registry has held it as a
  // paid bKash subscription since the day it was bought. Requiring getStatus
  // alone therefore leaves every bKash customer on FREE for ever.
  //
  // What makes the registry safe to trust now, when it was not before: the
  // return endpoint used to write the number on arrival and then read that
  // write back as its own proof, so reaching the URL was the whole test.
  // It no longer writes anything until bdApps confirms, and the notification
  // listener (app/api/bdapps/subscription-notification) writes only on
  // bdApps' own REGISTERED message and removes on UNREGISTERED.
  const [carrier, bkash] = await Promise.all([
    checkBdappsSubscription(phone),
    checkBkashSubscriber(phone),
  ]);

  // bdApps outranks our own file. When an application that KNOWS this
  // subscriber says UNREGISTERED, that is the answer, whatever the local
  // bKash list still holds - a list entry outlives the subscription that
  // created it, which is how a cancelled payment kept granting PRO to a
  // number that had subscribed once before.
  //
  // The registry only speaks when bdApps has no opinion (every application
  // answering an E-code, i.e. none of them has heard of the number), which is
  // the normal state of a bKash subscriber.
  // Per-application, not just the merged verdict: two bdApps applications
  // answer differently for the same number (one E1951, the other S1000
  // UNREGISTERED), and knowing which one said what is the difference between
  // diagnosing this in a minute and guessing at it.
  const perApplication = (carrier.detail ?? "")
    .replace(/https?:\/\/[^/]+\//g, "")
    .replace(/\/=/g, "=");
  const sources =
    `carrier=${carrier.status}` +
    (perApplication ? ` [${perApplication}]` : "") +
    ` bkashStore=${
      bkash.reachable
        ? bkash.subscribed
          ? bkash.verified
            ? "verified"
            : "unverified-record"
          : "no-record"
        : "unreachable"
    }`;
  const bdappsSaysNo = carrier.status === "NOT_REGISTERED";

  // bdApps decides, and nothing else does - but they have two ways of saying
  // it, and only one of them is a lookup.
  //
  //   getStatus            carrier billing. Cannot see a bKash subscription
  //                        at all: a paying bKash number answers E1951.
  //   their notification   sent unprompted when a subscription starts or
  //                        ends, and the only signal that covers bKash.
  //
  // A `verified` record is the second one, relayed by the bridge's
  // subscription_listener.php, which sets that flag and nothing else does. An
  // UNVERIFIED record is just someone having reached the return page, and
  // granting on those is what kept a cancelled payment on PRO.
  const subscribed = carrier.subscribed || (bkash.subscribed && bkash.verified);

  // bdApps gave no usable answer, so we do not know: change nothing. An
  // outage must never read as "everybody unsubscribed". The registry's
  // reachability is no longer part of this - it stopped being an authority,
  // so it cannot hold a downgrade up either.
  const carrierDefinite = carrier.subscribed || bdappsSaysNo;
  if (!subscribed && !carrierDefinite) {
    return { outcome: "GATEWAY_UNCLEAR", planName: currentPlan, detail: sources };
  }

  const check = { subscribed, status: subscribed ? "REGISTERED" : "NOT_REGISTERED" };

  const now = new Date();

  if (check.subscribed) {
    const proPlan = await prisma.plan.findFirst({
      where: { name: "PRO", is_active: true },
      select: { id: true },
    });
    if (!proPlan) {
      return {
        outcome: "GATEWAY_UNCLEAR",
        planName: currentPlan,
        detail: "PRO plan row missing",
      };
    }

    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() + RENEWAL_DAYS);

    const wasPro = currentPlan === "PRO";
    const stillValid =
      wasPro &&
      subscription != null &&
      subscription.current_period_end.getTime() > now.getTime() &&
      subscription.status === "ACTIVE";

    // Already correct and not near expiry — leave the period alone rather
    // than silently extending it on every poll.
    if (stillValid) {
      return { outcome: "ALREADY_CORRECT", planName: "PRO", detail: sources };
    }

    await prisma.subscription.upsert({
      where: { user_id: userId },
      create: {
        user_id: userId,
        plan_id: proPlan.id,
        status: "ACTIVE",
        current_period_start: now,
        current_period_end: periodEnd,
      },
      update: {
        plan_id: proPlan.id,
        status: "ACTIVE",
        current_period_start: now,
        current_period_end: periodEnd,
        cancelled_at: null,
      },
    });

    return {
      outcome: wasPro ? "RENEWED" : "UPGRADED",
      planName: "PRO",
      detail: sources,
    };
  }

  // A definite NOT_REGISTERED.
  if (currentPlan === "FREE") {
    return { outcome: "ALREADY_CORRECT", planName: "FREE", detail: sources };
  }

  // Only downgrade once the paid period has actually run out. Someone who
  // cancels mid-month keeps what they paid for until it expires.
  if (
    subscription &&
    subscription.current_period_end.getTime() > now.getTime()
  ) {
    return { outcome: "ALREADY_CORRECT", planName: currentPlan, detail: sources };
  }

  const freePlan = await prisma.plan.findFirst({
    where: { name: "FREE", is_active: true },
    select: { id: true },
  });
  if (!freePlan || !subscription) {
    return { outcome: "GATEWAY_UNCLEAR", planName: currentPlan };
  }

  // Their data is untouched — they simply become over-limit until they trim
  // down or resubscribe. See lib/plans/over-limit.ts.
  await prisma.subscription.update({
    where: { user_id: userId },
    data: { plan_id: freePlan.id, status: "CANCELLED", cancelled_at: now },
  });

  return { outcome: "DOWNGRADED", planName: "FREE", detail: sources };
}

/**
 * The subscribing number bdApps put on the last authorization return.
 *
 * Only settled attempts are considered: a PENDING row has no return payload
 * yet. Newest first, because a user who has paid twice is telling us about
 * the number they used most recently.
 */
async function phoneFromLastAuthorization(userId: string): Promise<string | null> {
  const rows = await prisma.subscriptionAuthorization.findMany({
    where: { user_id: userId, NOT: { return_payload: { equals: Prisma.DbNull } } },
    orderBy: { completed_at: "desc" },
    select: { return_payload: true },
    take: 5,
  });

  for (const row of rows) {
    const payload = row.return_payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (typeof value === "string") params.set(key, value);
    }
    const phone = subscriberPhoneFromReturn(params);
    if (phone) return phone;
  }
  return null;
}
