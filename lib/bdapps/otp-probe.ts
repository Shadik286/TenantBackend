// Asking bdApps whether a number is subscribed, by way of the OTP request.
//
// WHY NOT getStatus
//
// On the bKash (monthly) application, getStatus answers E1951 "Format of the
// address is invalid Or User Already UnRegistered" for every number - including
// one bdApps itself holds as subscribed. So it cannot confirm anything there.
//
// The OTP request can. Asked about a subscribed number it refuses with
//
//   {"statusCode":"E1351","statusDetail":"user already registered"}
//
// which is bdApps saying the subscription exists. This is also how the
// reference web client settles a login getStatus cannot
// (`resolveLogin` -> `requestOtp` -> `isAlreadyRegistered`).
//
// HOW OFTEN
//
// Once per trip through the payment gateway, with no timing rules on top: the
// answer is bdApps' own and it is immediate. "Once" is enforced on the payment
// attempt itself (see app/api/v1/subscription/verify), not by any window here.
// An earlier version reused answers for ten minutes, which made a new attempt
// inherit the previous attempt's "no".
//
// For a number that is NOT subscribed, this call sends that number an OTP.
// That is the accepted cost of asking.
import { BDAPPS_BASE } from "@/lib/bdapps";

const TIMEOUT_MS = Number(process.env.BDAPPS_TIMEOUT_MS ?? 12000);

export type OtpVerdict = "REGISTERED" | "NOT_REGISTERED" | "UNKNOWN";

/**
 * Read an OTP-request response as a subscription verdict.
 *
 *   E1351 / "already registered"  -> REGISTERED  (bdApps refused: they have one)
 *   E1853 / OTP limit reached     -> NOT_REGISTERED (bdApps checks registration
 *                                    before the limit; no SMS goes out)
 *   an OTP was issued             -> NOT_REGISTERED (bdApps started a new one)
 *   E1301 / E1343                 -> UNKNOWN (operator not provisioned for this
 *                                    application - says nothing about the user)
 *   anything else                 -> UNKNOWN
 */
export function classifyOtpProbe(data: Record<string, unknown>): OtpVerdict {
  const code = String(data.statusCode ?? "");
  const message = String(data.statusDetail ?? data.message ?? "").toLowerCase();

  if (code === "E1351" || message.includes("already registered")) {
    return "REGISTERED";
  }

  // "Maximum number of OTP requests reached for [Renten/tel:...]". Observed
  // live: the same number answered E1853 three times and then E1351 the moment
  // it subscribed, so being throttled means "not registered".
  if (code === "E1853" || message.includes("maximum number of otp")) {
    return "NOT_REGISTERED";
  }

  const issued =
    data.success === true ||
    (typeof data.referenceNo === "string" && data.referenceNo.trim() !== "");
  if (issued) return "NOT_REGISTERED";

  return "UNKNOWN";
}

export type OtpAnswer = {
  verdict: OtpVerdict;
  /**
   * What happened, short: E1351, OTP-ISSUED, E1853, or the failure.
   * Stored on the payment attempt and shown in logs.
   */
  result: string;
  /** An OTP SMS went to the number. */
  otpSent: boolean;
  /** bdApps will not send this number more OTPs today. */
  otpLimitReached: boolean;
};

/** Ask bdApps, once, whether `phone` is subscribed. Never throws. */
export async function askBdappsViaOtp(phone: string): Promise<OtpAnswer> {
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

    if (!response.ok) return unknown(`HTTP ${response.status}`);

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return unknown("UNPARSEABLE");
    }

    const verdict = classifyOtpProbe(data);
    const code = String(data.statusCode ?? "");

    if (verdict === "REGISTERED") {
      return {
        verdict,
        result: code || "E1351",
        otpSent: false,
        otpLimitReached: false,
      };
    }
    if (verdict === "NOT_REGISTERED") {
      const limited = code === "E1853";
      return {
        verdict,
        result: limited ? "E1853" : "OTP-ISSUED",
        otpSent: !limited,
        otpLimitReached: limited,
      };
    }
    return unknown(code || "NO-CODE");
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return unknown(aborted ? "TIMEOUT" : "FAILED");
  } finally {
    clearTimeout(timer);
  }
}

function unknown(result: string): OtpAnswer {
  return { verdict: "UNKNOWN", result, otpSent: false, otpLimitReached: false };
}

/** What a stored `otp_result` means for the app. */
export function otpResultFlags(result: string | null | undefined): {
  otpSent: boolean;
  otpLimitReached: boolean;
} {
  return {
    otpSent: result === "OTP-ISSUED",
    otpLimitReached: result === "E1853",
  };
}
