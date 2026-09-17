// Settling one payment attempt by asking bdApps - exactly once.
//
// THE RULE
//
// Every trip through the payment gateway is checked by asking bdApps whether
// the number is registered, and that question is asked ONCE per trip:
//
//   * no time windows or reuse between trips - a new trip always asks, even a
//     minute after the last one;
//   * never twice within a trip - however many times the app checks, and
//     however many requests arrive at once.
//
// "Once" lives on the attempt row. The ask is claimed with a conditional
// update on `verify_started_at`, so only one request can win it; every other
// request waits for that answer. The answer is stored on the row and returned
// as-is from then on.
//
// WHY THE APP DRIVES THIS, NOT THE RETURN URL
//
// bdApps shows its "success" page whether or not the payment went through, and
// sends the user back - sometimes more than once, and alongside the app's own
// visit to the same URL. When the return URL asked bdApps, a single trip
// produced up to three concurrent asks, answers that came back "busy", and
// OTPs sent twice. The app now asks when the user is back, through one call.
import { prisma } from "@/lib/prisma";
import { getDefaultFreePlanId } from "@/lib/plans/get-plan";
import { askBdappsViaOtp, otpResultFlags } from "@/lib/bdapps/otp-probe";

/** How long to wait for another request's answer before reporting "pending". */
const WAIT_FOR_ANSWER_MS = 20_000;

/**
 * An ask that started but never finished (a crashed function) is abandoned
 * after this, so the attempt can be asked about again rather than stay stuck.
 */
const ABANDONED_ASK_MS = 60_000;

export type AttemptVerification = {
  status: "PENDING" | "SUCCESS" | "FAILED";
  planName: string;
  otpSent: boolean;
  otpLimitReached: boolean;
  /** What bdApps answered, for logs. */
  result: string | null;
};

type AttemptRow = {
  id: string;
  user_id: string;
  status: "PENDING" | "SUCCESS" | "FAILED";
  plan_name: string;
  otp_result: string | null;
  verify_started_at: Date | null;
};

function toVerification(row: AttemptRow): AttemptVerification {
  return {
    status: row.status,
    planName: row.plan_name,
    result: row.otp_result,
    ...otpResultFlags(row.otp_result),
  };
}

async function loadAttempt(requestId: string, userId: string) {
  return prisma.subscriptionAuthorization.findFirst({
    where: { request_id: requestId, user_id: userId },
    select: {
      id: true,
      user_id: true,
      status: true,
      plan_name: true,
      otp_result: true,
      verify_started_at: true,
    },
  });
}

/** Put the user on the plan they paid for. */
export async function activatePaidPlan(userId: string, planName: string) {
  const plan = await prisma.plan.findFirst({
    where: { name: planName, is_active: true },
  });
  const planId = plan?.id ?? (await getDefaultFreePlanId());

  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setDate(periodEnd.getDate() + 30);

  await prisma.subscription.upsert({
    where: { user_id: userId },
    create: {
      user_id: userId,
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
}

/**
 * Settle an attempt, asking bdApps at most once for it.
 *
 * Returns null when the attempt does not exist or is not this user's.
 */
export async function verifyAttempt(
  requestId: string,
  userId: string,
): Promise<AttemptVerification | null> {
  const row = await loadAttempt(requestId, userId);
  if (!row) return null;

  // Already answered - by an earlier call in this trip.
  if (row.status !== "PENDING") return toVerification(row);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { phone: true },
  });
  if (!user?.phone) {
    console.warn("[subscription/verify] no phone on file", { requestId });
    return { ...toVerification(row), result: "NO-PHONE" };
  }

  // Claim the ask. Only one request gets count === 1. An ask abandoned by a
  // crashed function (started long ago, never answered) may be reclaimed.
  const abandonedBefore = new Date(Date.now() - ABANDONED_ASK_MS);
  const claimed = await prisma.subscriptionAuthorization.updateMany({
    where: {
      id: row.id,
      status: "PENDING",
      OR: [
        { verify_started_at: null },
        { verify_started_at: { lt: abandonedBefore } },
      ],
    },
    data: { verify_started_at: new Date() },
  });

  if (claimed.count === 0) {
    // Another request is asking right now. Wait for its answer instead of
    // asking too - asking again is what sent the second OTP.
    const deadline = Date.now() + WAIT_FOR_ANSWER_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 700));
      const latest = await loadAttempt(requestId, userId);
      if (latest && latest.status !== "PENDING") return toVerification(latest);
    }
    const latest = await loadAttempt(requestId, userId);
    return latest ? toVerification(latest) : null;
  }

  // We own the one ask for this attempt.
  const answer = await askBdappsViaOtp(user.phone);
  console.log("[subscription/verify] asked bdApps", {
    requestId,
    verdict: answer.verdict,
    result: answer.result,
  });

  if (answer.verdict === "UNKNOWN") {
    // No answer came back (timeout, bridge error). Nothing was decided, so the
    // claim is released and the next check asks again - otherwise a network
    // blip would leave the attempt unanswerable.
    await prisma.subscriptionAuthorization.updateMany({
      where: { id: row.id, status: "PENDING" },
      data: { verify_started_at: null, otp_result: answer.result },
    });
    return {
      status: "PENDING",
      planName: row.plan_name,
      result: answer.result,
      otpSent: false,
      otpLimitReached: false,
    };
  }

  const success = answer.verdict === "REGISTERED";
  if (success) {
    try {
      await activatePaidPlan(userId, row.plan_name);
    } catch (err) {
      // bdApps confirmed but we could not record it: leave the attempt
      // pending so the next check retries the activation, and say so loudly.
      console.error("[subscription/verify] activation failed", {
        requestId,
        userId,
        err,
      });
      await prisma.subscriptionAuthorization.updateMany({
        where: { id: row.id, status: "PENDING" },
        data: { verify_started_at: null, otp_result: answer.result },
      });
      return {
        status: "PENDING",
        planName: row.plan_name,
        result: answer.result,
        otpSent: false,
        otpLimitReached: false,
      };
    }
  }

  await prisma.subscriptionAuthorization.updateMany({
    where: { id: row.id, status: "PENDING" },
    data: {
      status: success ? "SUCCESS" : "FAILED",
      otp_result: answer.result,
      completed_at: new Date(),
    },
  });

  return {
    status: success ? "SUCCESS" : "FAILED",
    planName: row.plan_name,
    result: answer.result,
    otpSent: answer.otpSent,
    otpLimitReached: answer.otpLimitReached,
  };
}
