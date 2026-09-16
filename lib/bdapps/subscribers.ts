// The bKash subscriber store (`subscribers.php`).
//
// WHY THIS EXISTS — and why checking only `check_subscription.php` is wrong.
//
// bdApps has two unrelated ways to be subscribed:
//
//   carrier billing  Robi/Airtel only. Queryable via subscription/getStatus,
//                    which is what check_subscription.php wraps.
//   bKash            Any operator. The SDK guide defines NO status API and no
//                    verified callback, so a bKash subscriber is not visible
//                    upstream AT ALL.
//
// `subscribers.php` is the reference project's answer to the second case: a
// local registry written when a bKash payment returns, read when deciding
// whether someone may log in. Its own header says it plainly —
//
//   "a bKash subscriber cannot be looked up anywhere upstream. This file
//    records them locally so they can log in."
//
// Checking only check_subscription.php therefore reports every bKash
// subscriber as UNREGISTERED, no matter how much they paid. That is exactly
// what left a paying user on the Free plan.
import { BDAPPS_BASE } from "@/lib/bdapps";

const TIMEOUT_MS = 8000;

async function postForm(
  script: string,
  fields: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BDAPPS_BASE}${script}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      console.error("[bdapps/subscribers] HTTP error", {
        script,
        status: response.status,
      });
      return null;
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      console.error("[bdapps/subscribers] non-JSON response", {
        script,
        body: text.slice(0, 200),
      });
      return null;
    }
  } catch (err) {
    console.error("[bdapps/subscribers] request failed", { script, err });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type SubscriberRecord = {
  /** True only when the store positively holds this number. */
  subscribed: boolean;
  method: string | null;
  createdAt: string | null;
  /** False when the store could not be reached — NOT the same as "no". */
  reachable: boolean;
};

/** Is this number in the local bKash subscriber registry? */
export async function checkBkashSubscriber(
  phone: string,
): Promise<SubscriberRecord> {
  const data = await postForm("subscribers.php", {
    action: "check",
    user_mobile: phone,
  });

  if (!data) {
    return { subscribed: false, method: null, createdAt: null, reachable: false };
  }

  return {
    subscribed: data.subscribed === true,
    method: typeof data.method === "string" ? data.method : null,
    createdAt: typeof data.created === "string" ? data.created : null,
    reachable: true,
  };
}

/**
 * Record a bKash subscriber after a successful authorization return.
 *
 * Mirrors what the reference return page does. Without this the payment
 * leaves no trace anywhere we can query, and the user's next status check
 * says UNREGISTERED.
 *
 * `returnParams` is the raw query string bdApps sent back, stored for support
 * and for pinning down their undocumented return contract.
 */
export async function recordBkashSubscriber(
  phone: string,
  returnParams: string,
): Promise<boolean> {
  const data = await postForm("subscribers.php", {
    action: "add",
    user_mobile: phone,
    method: "bkash",
    return_params: returnParams.slice(0, 500),
  });
  return data?.subscribed === true;
}

/** Drop a bKash subscriber. Paired with unsubscribe.php, which only cancels
 *  the carrier side — leaving the local record would let a cancelled user
 *  keep passing the status check. */
export async function removeBkashSubscriber(phone: string): Promise<boolean> {
  const data = await postForm("subscribers.php", {
    action: "remove",
    user_mobile: phone,
  });
  return data !== null;
}

/**
 * bdApps' own last word on this number, from their subscription notification.
 *
 * Null when they have never told us anything about it. This is the only
 * bKash-capable signal that originates with bdApps: getStatus answers for
 * carrier billing only, and the bridge's subscriber file is a local list that
 * anyone who reaches the return URL can append to - which is how a cancelled
 * payment used to confirm itself.
 */
export async function lastBdappsNotification(
  phone: string,
): Promise<"REGISTERED" | "UNREGISTERED" | null> {
  const { prisma } = await import("@/lib/prisma");
  const latest = await prisma.bdappsSubscriptionEvent.findFirst({
    where: { phone },
    orderBy: { received_at: "desc" },
    select: { status: true },
  });
  if (!latest) return null;
  return latest.status === "REGISTERED" ? "REGISTERED" : "UNREGISTERED";
}
