// Asking bdApps whether a number is subscribed, by way of the OTP request.
//
// WHY NOT getStatus
//
// On the bKash (monthly) application, getStatus answers E1951 "Format of the
// address is invalid Or User Already UnRegistered" for every number - including
// one bdApps itself holds as subscribed. So it cannot confirm anything there.
//
// The OTP request can. Asked about that same number, it refuses with:
//
//   {"statusCode":"E1351","statusDetail":"user already registered",
//    "subscriberId":"tel:8801817932639"}
//
// That is bdApps saying, in so many words, that the subscription exists. It is
// also exactly how the reference web client resolves a login it cannot settle
// with getStatus (`resolveLogin` -> `requestOtp` -> `isAlreadyRegistered`).
//
// THE COST, AND HOW IT IS CONTAINED
//
// For a number that is NOT subscribed, the same call succeeds - and bdApps
// texts that number an OTP. The app polls after a payment and the nightly job
// walks lapsed accounts, so asked naively this would send a cancelled user a
// text on every poll and a lapsed one a text every night. So:
//
//   * a verdict is recorded and reused for PROBE_REUSE_MS before asking again;
//   * callers opt in (see syncSubscriptionWithBdapps), and the nightly
//     reconciliation does not.
import { prisma } from "@/lib/prisma";
import { BDAPPS_BASE, type BdappsCheckResult } from "@/lib/bdapps";

const TIMEOUT_MS = Number(process.env.BDAPPS_TIMEOUT_MS ?? 12000);

/** How long a probe's answer stands before bdApps is asked (and texts) again. */
const PROBE_REUSE_MS = 10 * 60 * 1000;

const SOURCE = "otp-probe";

/**
 * Read an OTP-request response as a subscription verdict.
 *
 *   E1351 / "already registered"  -> REGISTERED  (bdApps refused: they have one)
 *   an OTP was issued             -> NOT_REGISTERED (bdApps started a new one)
 *   E1301 / E1343                 -> UNKNOWN (operator not provisioned for this
 *                                    application - says nothing about the user)
 *   anything else                 -> UNKNOWN
 */
export function classifyOtpProbe(
  data: Record<string, unknown>,
): "REGISTERED" | "NOT_REGISTERED" | "UNKNOWN" {
  const code = String(data.statusCode ?? "");
  const message = String(
    data.statusDetail ?? data.message ?? "",
  ).toLowerCase();

  if (code === "E1351" || message.includes("already registered")) {
    return "REGISTERED";
  }

  const issued =
    data.success === true ||
    (typeof data.referenceNo === "string" && data.referenceNo.trim() !== "");
  if (issued) return "NOT_REGISTERED";

  return "UNKNOWN";
}

async function recentVerdict(
  phone: string,
): Promise<"REGISTERED" | "UNREGISTERED" | null> {
  const since = new Date(Date.now() - PROBE_REUSE_MS);
  const latest = await prisma.bdappsSubscriptionEvent.findFirst({
    where: { phone, source: SOURCE, received_at: { gte: since } },
    orderBy: { received_at: "desc" },
    select: { status: true },
  });
  if (!latest) return null;
  return latest.status === "REGISTERED" ? "REGISTERED" : "UNREGISTERED";
}

/**
 * Ask bdApps, via the OTP request, whether `phone` is subscribed.
 *
 * Never throws. A definite answer is recorded; an unclear one is not, so the
 * next caller asks again rather than inheriting a non-answer.
 */
export async function probeRegistrationViaOtp(
  phone: string,
): Promise<BdappsCheckResult> {
  const reused = await recentVerdict(phone);
  if (reused) {
    return {
      subscribed: reused === "REGISTERED",
      status: reused === "REGISTERED" ? "REGISTERED" : "NOT_REGISTERED",
      detail: `otp-probe=${reused} (reused)`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BDAPPS_BASE}send_otp.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user_mobile: phone }).toString(),
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();

    if (!response.ok) {
      return {
        subscribed: false,
        status: "GATEWAY_ERROR",
        detail: `otp-probe HTTP ${response.status}`,
      };
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {
        subscribed: false,
        status: "UNPARSEABLE",
        detail: `otp-probe: ${text.slice(0, 120)}`,
      };
    }

    const verdict = classifyOtpProbe(data);
    const code = String(data.statusCode ?? "");

    if (verdict !== "UNKNOWN") {
      await prisma.bdappsSubscriptionEvent.create({
        data: {
          subscriber_id: String(data.subscriberId ?? `tel:${phone}`),
          phone,
          status: verdict === "REGISTERED" ? "REGISTERED" : "UNREGISTERED",
          application_id: null,
          time_stamp: code || null,
          source: SOURCE,
        },
      });
    }

    if (verdict === "REGISTERED") {
      return { subscribed: true, status: "REGISTERED", detail: `otp-probe=${code}` };
    }
    if (verdict === "NOT_REGISTERED") {
      return {
        subscribed: false,
        status: "NOT_REGISTERED",
        detail: "otp-probe=OTP-ISSUED",
      };
    }
    return {
      subscribed: false,
      status: "GATEWAY_ERROR",
      detail: `otp-probe=${code || "no-code"}`,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      subscribed: false,
      status: aborted ? "TIMEOUT" : "GATEWAY_ERROR",
      detail: `otp-probe ${aborted ? "timeout" : "failed"}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
