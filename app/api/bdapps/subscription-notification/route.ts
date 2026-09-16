import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getDefaultFreePlanId } from "@/lib/plans/get-plan";
import { recordBkashSubscriber, removeBkashSubscriber } from "@/lib/bdapps/subscribers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// POST /api/bdapps/subscription-notification
// ---------------------------------------------------------------------------
//
// bdApps telling us, server to server, that a subscription started or ended.
// This is the confirmation channel the reference app uses
// (`subscription_listener.php`), and its log shows exactly what arrives:
//
//   TimeStamp:20260909034320 |Status:REGISTERED |App Id:APP_140008
//   |SubscriberId8801726002358
//
// It matters because getStatus cannot answer for every subscription. A bKash
// subscriber is invisible to the carrier application's lookup - verified
// against a real paying number, which getStatus reports as E1951 "already
// unregistered" while the bKash registry holds it as subscribed since the day
// they paid. Polling therefore cannot confirm those users, and asking the user
// to prove their own payment is how a cancelled attempt ended up granting PRO.
// A notification is bdApps' own word, unprompted, so it can be trusted.
//
// Register this URL as the application's subscription notification URL in the
// bdApps portal. Until that is done nothing arrives here and nothing breaks;
// the endpoint simply never fires.
//
// UNAUTHENTICATED by necessity - bdApps signs nothing and sends no credential.
// What protects it:
//
//   * It only ever acts on a number that already belongs to a user of ours.
//     An unknown subscriberId is recorded and ignored.
//   * REGISTERED grants the plan the user would have got by paying; it cannot
//     be aimed at someone else's account without knowing their number, and
//     knowing a number is already enough to start a subscription for it.
//   * Set BDAPPS_NOTIFICATION_SECRET to require `?secret=` on the URL you
//     register, and this refuses anything without it.

/** Digits only, normalised to the local 01XXXXXXXXX form we store. */
function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/\D+/g, "");
  if (/^8801[3-9]\d{8}$/.test(digits)) return digits.slice(2);
  if (/^01[3-9]\d{8}$/.test(digits)) return digits;
  if (/^1[3-9]\d{8}$/.test(digits)) return `0${digits}`;
  return null;
}

/**
 * The subscriber id is sometimes a plain MSISDN and sometimes an opaque
 * per-application token (`MWRkZGFj...OnJvYmk=`), as both appear in the
 * reference's own notification log. Only the first kind can be matched to a
 * user; the other is stored so support can correlate it later.
 */
function phoneFromSubscriberId(subscriberId: string): string | null {
  const withoutScheme = subscriberId.replace(/^tel:/i, "");
  return normalisePhone(withoutScheme);
}

type Notification = {
  status: string;
  subscriberId: string;
  applicationId: string | null;
  timeStamp: string | null;
};

async function readNotification(request: NextRequest): Promise<Notification | null> {
  // JSON is what the reference reads off php://input. Form encoding is
  // accepted too, because this is a contract we do not control and arriving
  // in the other shape must not look like "no notification".
  const contentType = request.headers.get("content-type") ?? "";
  let body: Record<string, unknown> = {};

  try {
    if (contentType.includes("application/json")) {
      body = (await request.json()) as Record<string, unknown>;
    } else {
      const text = await request.text();
      if (text.trim().startsWith("{")) {
        body = JSON.parse(text) as Record<string, unknown>;
      } else {
        body = Object.fromEntries(new URLSearchParams(text));
      }
    }
  } catch {
    return null;
  }

  const status = String(body.status ?? body.Status ?? "").toUpperCase();
  const subscriberId = String(body.subscriberId ?? body.subscriber_id ?? "");
  if (!status || !subscriberId) return null;

  return {
    status,
    subscriberId,
    applicationId: body.applicationId ? String(body.applicationId) : null,
    timeStamp: body.timeStamp ? String(body.timeStamp) : null,
  };
}

export async function POST(request: NextRequest) {
  const required = process.env.BDAPPS_NOTIFICATION_SECRET;
  if (required && request.nextUrl.searchParams.get("secret") !== required) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const notification = await readNotification(request);
  if (!notification) {
    // Answer 200 regardless: a gateway that reads a 4xx as "delivery failed"
    // will retry forever, and we cannot act on what we could not parse.
    console.warn("[bdapps/notification] unreadable notification");
    return NextResponse.json({ ok: true, handled: false });
  }

  const phone = phoneFromSubscriberId(notification.subscriberId);
  console.log("[bdapps/notification]", {
    status: notification.status,
    applicationId: notification.applicationId,
    timeStamp: notification.timeStamp,
    // Last 4 only: enough to correlate with the gateway's logs without
    // writing whole subscriber numbers into log retention.
    subscriberSuffix: notification.subscriberId.slice(-4),
    matchedPhone: phone !== null,
  });

  if (!phone) {
    // An opaque subscriber token, or a number we cannot parse. Nothing to act
    // on, but not an error on their side.
    return NextResponse.json({ ok: true, handled: false });
  }

  const user = await prisma.user.findFirst({
    where: { phone, deleted_at: null },
    select: { id: true },
  });

  if (!user) {
    // They are subscribed but have not signed up yet, or signed up with a
    // different number. Keep the registry entry so the check at signup finds
    // it; there is no account to move.
    if (notification.status === "REGISTERED") {
      await recordBkashSubscriber(phone, `notification:${notification.timeStamp ?? ""}`);
    }
    return NextResponse.json({ ok: true, handled: false });
  }

  if (notification.status === "REGISTERED") {
    const proPlan = await prisma.plan.findFirst({
      where: { name: "PRO", is_active: true },
      select: { id: true },
    });
    if (!proPlan) {
      console.error("[bdapps/notification] PRO plan row missing");
      return NextResponse.json({ ok: true, handled: false });
    }

    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() + 30);

    await prisma.subscription.upsert({
      where: { user_id: user.id },
      create: {
        user_id: user.id,
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

    // Settle any attempt this user had open, so the app's poll stops waiting.
    await prisma.subscriptionAuthorization.updateMany({
      where: { user_id: user.id, status: "PENDING" },
      data: { status: "SUCCESS", completed_at: now },
    });

    await recordBkashSubscriber(phone, `notification:${notification.timeStamp ?? ""}`);
    console.log("[bdapps/notification] activated PRO", { userId: user.id });
    return NextResponse.json({ ok: true, handled: true, outcome: "PRO" });
  }

  if (notification.status === "UNREGISTERED") {
    const freePlanId = await getDefaultFreePlanId();
    if (freePlanId) {
      await prisma.subscription.updateMany({
        where: { user_id: user.id },
        data: {
          plan_id: freePlanId,
          status: "CANCELLED",
          cancelled_at: new Date(),
        },
      });
    }
    // Leaving the local record would let a cancelled number keep passing the
    // bKash check.
    await removeBkashSubscriber(phone);
    console.log("[bdapps/notification] moved to FREE", { userId: user.id });
    return NextResponse.json({ ok: true, handled: true, outcome: "FREE" });
  }

  return NextResponse.json({ ok: true, handled: false });
}

// Some gateways probe the URL with a GET before they will save it.
export async function GET() {
  return NextResponse.json({
    ok: true,
    message: "bdApps subscription notification endpoint. POST notifications here.",
  });
}
