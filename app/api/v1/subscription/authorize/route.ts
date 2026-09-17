import { NextRequest, NextResponse } from "next/server";
import { otpResultFlags } from "@/lib/bdapps/otp-probe";
import { requireUserId } from "@/lib/require-user";
import { prisma } from "@/lib/prisma";
import {
  bdappsCredentials,
  buildAuthorizeUrl,
  makeAuthorizeRequest,
} from "@/lib/bdapps/subscription";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// POST /api/v1/subscription/authorize
// ---------------------------------------------------------------------------
//
// Starts a bdApps subscription. Returns the URL the client should open in a
// browser; it does NOT subscribe anyone by itself.
//
// Response: { ok, authorize_url, request_id }
//
// The pending row is written BEFORE the URL is handed back, because the user
// is about to leave for an external site and the only thing that comes back
// with them is the requestId. If that mapping is not already on disk when
// they return, there is no way to tell whose subscription just succeeded.

// ---------------------------------------------------------------------------
// GET /api/v1/subscription/authorize?request_id=...
// ---------------------------------------------------------------------------
//
// How the app finds out what happened. The user completes the flow in a
// browser, so nothing tells the app directly — it asks when it regains focus.
//
// Scoped to the caller's own attempts: a requestId belonging to someone else
// answers NOT_FOUND rather than leaking their subscription state.
export async function GET(request: NextRequest) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;

  const requestId = request.nextUrl.searchParams.get("request_id") ?? "";
  if (!requestId) {
    return NextResponse.json(
      { error: "REQUEST_ID_REQUIRED", message: "request_id is required." },
      { status: 400 },
    );
  }

  const record = await prisma.subscriptionAuthorization.findFirst({
    where: { request_id: requestId, user_id: guard.userId },
    select: {
      status: true,
      plan_name: true,
      completed_at: true,
      otp_result: true,
    },
  });

  if (!record) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "No such subscription attempt." },
      { status: 404 },
    );
  }

  // What asking bdApps did to the number for this attempt - stored on the row
  // by the one verify call that asked.
  const { otpSent, otpLimitReached } = otpResultFlags(record.otp_result);

  return NextResponse.json({
    ok: true,
    data: {
      status: record.status,
      plan_name: record.plan_name,
      completed_at: record.completed_at?.toISOString() ?? null,
      otp_sent: otpSent,
      // bdApps will not send this number any more OTPs today.
      otp_limit_reached: otpLimitReached,
    },
  });
}

export async function POST(request: NextRequest) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const userId = guard.userId;

  // Each attempt writes a row and sends someone to a payment page. Capped per
  // user so a stuck client cannot fill the table or spam the gateway.
  const limited = await enforceRateLimit(
    [`subauth:user:${userId}`],
    RATE_LIMITS.subscriptionAuthorize,
  );
  if (limited) return limited;

  const credentials = bdappsCredentials();
  if (!credentials) {
    // A missing key is a deployment problem, not a user problem — say so
    // plainly in the logs and give the client something it can show.
    console.error(
      "[subscription/authorize] Bkash_API_Key / Bkash_API_Secret are not set",
    );
    return NextResponse.json(
      {
        error: "GATEWAY_NOT_CONFIGURED",
        message: "Payments are not available right now. Please try again later.",
      },
      { status: 503 },
    );
  }

  // Where bdApps is told to send the user back to.
  //
  // In practice bdApps does NOT perform this redirect: its success page says
  // "you will be redirected within 0 seconds" and then sits there. The
  // reference project works around that by hosting its return page on the
  // application's own host — which we cannot do, because that host is not
  // ours to deploy to.
  //
  // So the app drives the return itself: the in-app WebView watches for
  // bdApps' success page and navigates here once it appears (see
  // `_completeIfSuccessPage` in subscription_webview_screen.dart). This URL
  // still has to be correct and signed into the request, because it is where
  // the app sends the user when the payment is done.
  const origin =
    process.env.SUBSCRIPTION_RETURN_ORIGIN?.replace(/\/+$/, "") ??
    request.nextUrl.origin;
  // The requestId goes in the PATH. bdApps returns the user with an empty
  // query string, so a `?requestId=` would come back as nothing and the
  // attempt could never be tied to this user.
  const pending = makeAuthorizeRequest();
  const redirectUrl = `${origin}/api/subscription/return/${pending.requestId}`;

  const authorize = buildAuthorizeUrl(credentials, redirectUrl, pending);

  await prisma.subscriptionAuthorization.create({
    data: {
      user_id: userId,
      request_id: authorize.requestId,
      request_time: authorize.requestTime,
      plan_name: "PRO",
    },
  });

  return NextResponse.json({
    ok: true,
    authorize_url: authorize.url,
    request_id: authorize.requestId,
  });
}
