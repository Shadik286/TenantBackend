import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";



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

export async function handleSubscriptionReturn(
  request: NextRequest,
  requestIdFromPath?: string,
) {
  const params = request.nextUrl.searchParams;
  // The path is the reliable one. bdApps returns the user with NO query
  // string at all - observed live: `callback { requestId: '', payload: {} }`
  // - so anything we need on the way back has to be baked into the URL we
  // handed them, not expected as a parameter.
  const requestId =
    requestIdFromPath ||
    params.get("requestId") ||
    params.get("request_id") ||
    "";

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

  // The payment step is over. Whether it went through is NOT decided here.
  //
  // bdApps shows its "success" page whether or not the payment went through,
  // and sends the user here - sometimes more than once, and alongside the
  // app's own visit to this same URL. When this route asked bdApps itself, one
  // trip produced up to three concurrent asks, answers that came back "busy",
  // and OTPs sent twice.
  //
  // So this only records the visit. The app asks bdApps exactly once for the
  // attempt, when the user is back (POST /api/v1/subscription/verify).
  await prisma.subscriptionAuthorization.updateMany({
    where: { request_id: requestId, status: "PENDING" },
    data: { return_payload: payload },
  });

  return page(
    "Payment step finished",
    "Return to the app - it will confirm your subscription and show you the result.",
    true,
  );
}
