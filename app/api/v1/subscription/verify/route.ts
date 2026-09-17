import { NextRequest, NextResponse } from "next/server";
import { requireUserId } from "@/lib/require-user";
import { verifyAttempt } from "@/lib/bdapps/verify-attempt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Waits on bdApps, and possibly on another request's answer.
export const maxDuration = 30;

// ---------------------------------------------------------------------------
// POST /api/v1/subscription/verify   { "request_id": "..." }
// ---------------------------------------------------------------------------
//
// Called by the app when the user comes back from the payment gateway. Asks
// bdApps whether the number is now registered - once for this attempt, however
// many times this is called - and settles the attempt from the answer:
//
//   registered      -> PRO, status SUCCESS
//   not registered  -> status FAILED (bdApps texts the number an OTP, or has
//                      hit its daily OTP limit for it)
//   no answer       -> status PENDING, and the next call asks again
//
// Safe to call repeatedly: after the first answer it only reads.

export async function POST(request: NextRequest) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;

  const body = (await request.json().catch(() => null)) as {
    request_id?: unknown;
  } | null;
  const requestId =
    typeof body?.request_id === "string" ? body.request_id.trim() : "";
  if (!requestId) {
    return NextResponse.json(
      { error: "REQUEST_ID_REQUIRED", message: "request_id is required." },
      { status: 400 },
    );
  }

  const result = await verifyAttempt(requestId, guard.userId);
  if (!result) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "No such subscription attempt." },
      { status: 404 },
    );
  }

  return NextResponse.json({
    ok: true,
    data: {
      status: result.status,
      plan_name: result.planName,
      otp_sent: result.otpSent,
      otp_limit_reached: result.otpLimitReached,
      result: result.result,
    },
  });
}
