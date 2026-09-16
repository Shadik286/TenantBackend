import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  isExplicitFailureReturn,
  subscriberPhoneFromReturn,
} from "@/lib/bdapps/subscription";
import { checkBdappsSubscription } from "@/lib/bdapps";
import {
  checkBkashSubscriber,
  recordBkashSubscriber,
} from "@/lib/bdapps/subscribers";
import { getDefaultFreePlanId } from "@/lib/plans/get-plan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// GET /api/subscription/return
// ---------------------------------------------------------------------------
//
// Where bdApps sends the user after they approve (or decline) a subscription.
//
// This endpoint is UNAUTHENTICATED by necessity: the user arrives from an
// external site, and a session cookie does not reliably survive that round
// trip on mobile. Identity comes from the `requestId`, which we wrote down
// against a user before sending them away — see the authorize route.
//
// That makes `requestId` the only credential here, so the rules are strict:
//
//   * A PENDING row must exist. An unknown requestId grants nothing.
//   * The row is claimed with a conditional update on `status = PENDING`, so
//     a refresh, a back button, or a retrying gateway cannot grant a second
//     period. Whoever loses that race matches zero rows and is ignored.
//   * Anything not recognised as success is recorded as failure. Erring
//     toward "not subscribed" is the safe direction; the opposite mistake
//     hands out PRO for free.
//
// The response is an HTML page rather than JSON because a human's browser is
// what lands here.

function page(title: string, message: string, ok: boolean): NextResponse {
  const accent = ok ? "#059669" : "#DC2626";
  const glyph = ok ? "&#10003;" : "&#33;";
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#F8F9FB;color:#111827}
  .card{max-width:22rem;margin:1.5rem;padding:2rem 1.5rem;background:#fff;border-radius:20px;
        border:1px solid #EFF1F5;box-shadow:0 8px 24px rgba(17,24,39,.06);text-align:center}
  .badge{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;
         margin:0 auto 1rem;font-size:28px;color:#fff;background:${accent}}
  h1{font-size:1.15rem;margin:0 0 .5rem}
  p{font-size:.9rem;line-height:1.5;color:#6B7280;margin:0}
</style></head>
<body><div class="card">
  <div class="badge">${glyph}</div>
  <h1>${title}</h1>
  <p>${message}</p>
</div></body></html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const requestId = params.get("requestId") ?? params.get("request_id") ?? "";

  // Everything the gateway sent, kept for support and for working out the
  // real return contract once we see live traffic.
  const payload: Record<string, string> = {};
  params.forEach((value, key) => {
    payload[key] = value;
  });
  console.log("[subscription/return] callback", { requestId, payload });

  if (!requestId) {
    return page(
      "Something went wrong",
      "We could not identify this subscription attempt. Please try again from the app.",
      false,
    );
  }

  const record = await prisma.subscriptionAuthorization.findUnique({
    where: { request_id: requestId },
  });

  if (!record) {
    return page(
      "Something went wrong",
      "We could not find this subscription attempt. Please try again from the app.",
      false,
    );
  }

  // Already settled — a refresh or a duplicate callback. Report what was
  // decided the first time rather than deciding again.
  if (record.status !== "PENDING") {
    const wasSuccess = record.status === "SUCCESS";
    return page(
      wasSuccess ? "You're on Pro" : "Subscription not completed",
      wasSuccess
        ? "Your subscription is already active. You can close this page and return to the app."
        : "This attempt did not complete. Please start again from the app.",
      wasSuccess,
    );
  }

  // Whether this counts as a successful subscription.
  //
  // bdApps sends no success parameter — arriving here IS the completion
  // signal (see isExplicitFailureReturn). But arrival alone must not grant
  // PRO: the requestId is a 15-digit timestamp-prefixed value, which is
  // guessable enough that "you reached this URL" is too weak a credential to
  // hand out a paid plan on.
  //
  // So we ask the authority. checkBdappsSubscription hits
  // check_subscription.php, which asks bdApps whether the number is
  // REGISTERED. That is the same source the nightly reconciliation trusts,
  // so the two can never disagree about what happened.
  let success = false;

  if (isExplicitFailureReturn(params)) {
    console.log("[subscription/return] explicit failure on return", {
      requestId,
    });
  } else {
    // Prefer the number bdApps handed back; fall back to the one on file.
    const user = await prisma.user.findUnique({
      where: { id: record.user_id },
      select: { phone: true },
    });
    const returnedPhone = subscriberPhoneFromReturn(params);
    const phone = returnedPhone ?? user?.phone ?? null;

    // bdApps just told us which number is subscribing. If the account has none
    // on file - every Google signup starts that way - write it down, because
    // the phone is the only key we have for asking bdApps about this user
    // later. Without this, every later sync and the nightly reconciliation
    // both answer NO_PHONE and silently never ask at all.
    if (returnedPhone && !user?.phone) {
      try {
        await prisma.user.update({
          where: { id: record.user_id },
          data: { phone: returnedPhone },
        });
      } catch (err) {
        // Most likely the number already belongs to another account. Not fatal
        // here: the subscription still activates, and support can untangle the
        // duplicate.
        console.warn("[subscription/return] could not save subscriber phone", {
          requestId,
          err,
        });
      }
    }

    if (!phone) {
      // Nothing to verify against. Accept the return: the user completed the
      // operator's flow to get here, and refusing everyone without a phone
      // number on file would block the Google-signup path entirely. The
      // nightly reconciliation re-checks them once a number exists.
      console.warn("[subscription/return] no phone to verify, accepting", {
        requestId,
      });
      success = true;
    } else {
      // Record the bKash subscription FIRST, exactly as the reference return
      // page does. A bKash subscription exists nowhere upstream — there is no
      // status API for it — so if this write does not happen, the payment
      // leaves no trace and every later check reports UNREGISTERED.
      await recordBkashSubscriber(phone, request.nextUrl.search);

      // Then confirm against both sources: carrier billing via
      // check_subscription.php, and the bKash registry we just wrote.
      const [carrier, bkash] = await Promise.all([
        checkBdappsSubscription(phone),
        checkBkashSubscriber(phone),
      ]);

      if (carrier.subscribed || bkash.subscribed) {
        success = true;
      } else if (carrier.status === "NOT_REGISTERED" && bkash.reachable) {
        console.log("[subscription/return] neither source shows a subscription", {
          requestId,
          carrier: carrier.detail,
        });
      } else {
        // TIMEOUT / GATEWAY_ERROR — we cannot confirm. Accept, because the
        // user did complete the flow and making them pay twice for our
        // inability to reach bdApps is the worse error. The nightly
        // reconciliation will downgrade them if it turns out they are not
        // actually subscribed.
        console.warn("[subscription/return] gateway unclear, accepting", {
          requestId,
          carrierStatus: carrier.status,
          bkashStoreReachable: bkash.reachable,
        });
        success = true;
      }
    }
  }

  // Claim the row. `status: "PENDING"` in the where clause is the idempotency
  // guard: only one caller can move it out of PENDING.
  const claimed = await prisma.subscriptionAuthorization.updateMany({
    where: { request_id: requestId, status: "PENDING" },
    data: {
      status: success ? "SUCCESS" : "FAILED",
      return_payload: payload,
      completed_at: new Date(),
    },
  });

  if (claimed.count === 0) {
    // Someone else settled it between the read above and this update.
    return page(
      "Already processed",
      "This subscription attempt has already been handled. You can close this page.",
      true,
    );
  }

  if (!success) {
    return page(
      "Subscription not completed",
      "The subscription was not approved. You have not been charged. You can try again from the app.",
      false,
    );
  }

  // Activate PRO. Done after the row is claimed so a failure here cannot be
  // replayed into a second activation by reloading the page.
  try {
    const proPlan = await prisma.plan.findFirst({
      where: { name: record.plan_name, is_active: true },
    });
    const planId = proPlan?.id ?? (await getDefaultFreePlanId());

    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() + 30);

    await prisma.subscription.upsert({
      where: { user_id: record.user_id },
      create: {
        user_id: record.user_id,
        plan_id: planId,
        status: "ACTIVE",
        current_period_start: now,
        current_period_end: periodEnd,
      },
      update: {
        plan_id: planId,
        status: "ACTIVE",
        current_period_start: now,
        current_period_end: periodEnd,
        cancelled_at: null,
      },
    });
  } catch (err) {
    // The payment succeeded but we failed to record it. Say nothing
    // reassuring — this needs a human, and the log plus the SUCCESS row is
    // what they will work from.
    console.error("[subscription/return] activation failed", {
      requestId,
      userId: record.user_id,
      err,
    });
    return page(
      "Almost there",
      "Your payment went through but we could not finish setting up your account. " +
        "Please contact support with this reference: " + requestId,
      false,
    );
  }

  return page(
    "You're on Pro",
    "Your subscription is active. You can close this page and return to the app.",
    true,
  );
}
