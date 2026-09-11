import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendEmail, emailConfigured } from "./email";
import { sendViaSmtp, smtpConfigured } from "./smtp";
import { renderNotification } from "./templates";
import type {
  NotificationPayload,
  RecipientContext,
  SenderContext,
} from "./types";

export type { NotificationPayload } from "./types";

/**
 * Tenant notification dispatch.
 *
 * Three guarantees, each of which is a way this feature breaks in production
 * while appearing to work in development:
 *
 * 1. NEVER FAILS THE CALLER. Recording a payment is the critical path; a
 *    bounced invoice is not. Every path here returns rather than throws, and
 *    the scheduled work is wrapped in its own try/catch.
 *
 * 2. NEVER FIRE-AND-FORGET. An un-awaited promise in a serverless function is
 *    killed the moment the response is returned — the mail silently never
 *    leaves. `after()` (native in Next 15.5) is what keeps the invocation
 *    alive until the send completes.
 *
 * 3. NEVER SENDS TWICE. `EmailLog.dedupe_key` is UNIQUE and identifies the
 *    EVENT, not the attempt. This matters concretely: POST /api/payments is
 *    idempotent and returns the EXISTING payment when a key repeats, which is
 *    otherwise indistinguishable from a new payment — and would mail the
 *    tenant a duplicate invoice.
 */

/**
 * Pick the delivery transport.
 *
 * SMTP wins when configured, because it is the only one that can send from a
 * @gmail.com address: Resend requires SPF/DKIM on the sending domain, which is
 * impossible for a domain Google owns. Once a real domain exists, setting
 * RESEND_API_KEY and clearing the SMTP_* vars switches back with no code
 * change — Resend is the better transport at volume (no daily cap, faster, and
 * it reports bounces).
 */
function selectTransport():
  | { name: "SMTP"; send: typeof sendViaSmtp }
  | { name: "RESEND"; send: typeof sendEmail }
  | null {
  if (smtpConfigured()) return { name: "SMTP", send: sendViaSmtp };
  if (emailConfigured()) return { name: "RESEND", send: sendEmail };
  return null;
}

/** Landlord profile + preferences, in one query. */
async function loadSender(
  landlordUserId: string,
): Promise<SenderContext | null> {
  const user = await prisma.user.findUnique({
    where: { id: landlordUserId },
    select: {
      full_name: true,
      email: true,
      preference: { select: { language: true, currency: true } },
    },
  });
  if (!user) return null;
  return {
    landlordUserId,
    landlordName: user.full_name,
    language: user.preference?.language ?? "en-US",
    currency: user.preference?.currency ?? "BDT",
    // Carried through rather than re-queried below: loadSender already reads
    // this row, and a second lookup is another full database round trip on
    // every notification for a value we are holding.
    landlordEmail: user.email,
  };
}

/**
 * Claim the right to send, atomically.
 *
 * Relies on the unique index rather than SELECT-then-INSERT: two concurrent
 * requests would both pass a check-first test. A P2002 here means some other
 * invocation already owns this event, so this one stops — quietly, because a
 * duplicate suppression is the system working, not an error.
 */
async function claim(args: {
  dedupeKey: string;
  landlordUserId: string;
  tenantId: string;
  kind: string;
  toAddress: string;
  subject: string;
}): Promise<string | null> {
  try {
    const row = await prisma.emailLog.create({
      data: {
        dedupe_key: args.dedupeKey,
        user_id: args.landlordUserId,
        tenant_id: args.tenantId,
        kind: args.kind,
        channel: "EMAIL",
        to_address: args.toAddress,
        subject: args.subject,
        status: "PENDING",
      },
      select: { id: true },
    });
    return row.id;
  } catch {
    // Already claimed (unique violation) or the log write failed. Either way
    // there is nothing safe to do but decline to send.
    return null;
  }
}

/**
 * Queue a tenant notification.
 *
 * `dedupeKey` must be derived from the underlying event — the payment id, the
 * lease id — never from a timestamp or random value, or the guarantee is lost.
 *
 * Returns immediately. Safe to call without awaiting inside a route handler,
 * though awaiting costs nothing since the work itself is deferred.
 */
export async function notifyTenant(args: {
  landlordUserId: string;
  recipient: RecipientContext;
  payload: NotificationPayload;
  dedupeKey: string;
}): Promise<void> {
  try {
    // Most tenants in this market have no email on file. Genuinely nothing to
    // do and nothing worth recording, so this is the one true early exit.
    if (!args.recipient.email) return;

    const sender = await loadSender(args.landlordUserId);
    if (!sender) return;

    const message = renderNotification(args.payload, args.recipient, sender);

    const logId = await claim({
      dedupeKey: args.dedupeKey,
      landlordUserId: args.landlordUserId,
      tenantId: args.recipient.tenantId,
      kind: args.payload.kind,
      toAddress: args.recipient.email,
      subject: message.subject,
    });

    // Someone else already owns this event.
    if (!logId) return;

    // Configuration is checked AFTER the claim, deliberately.
    //
    // Checking first would mean no row is written when the mailer is unset —
    // so the dedupe guarantee would be unexercised (and untestable) in exactly
    // the environments where it is easiest to get wrong, and a landlord would
    // have no way to see that a receipt was owed but never sent. Recording
    // SKIPPED keeps the log a complete account of what the system intended.
    const transport = selectTransport();
    if (!transport) {
      await prisma.emailLog
        .update({
          where: { id: logId },
          data: {
            status: "SKIPPED",
            error:
              "No mail transport configured (set SMTP_* for Gmail, or RESEND_* for a verified domain).",
          },
        })
        .catch(() => {});
      console.warn("[notify] no transport configured; recorded as SKIPPED", {
        kind: args.payload.kind,
        tenant_id: args.recipient.tenantId,
      });
      return;
    }

    const landlordEmail = sender.landlordEmail;

    const to = args.recipient.email;

    // Hand the network call to `after()` so the HTTP response is not held open
    // behind a third-party API, while the runtime still keeps the function
    // alive long enough for it to finish.
    after(async () => {
      try {
        const result = await transport.send(
          to,
          message,
          // Synthetic bdapps addresses (bdapps+8801…@tenant.local) are not
          // deliverable, so a reply-to pointing at one would bounce.
          landlordEmail && !landlordEmail.endsWith("@tenant.local")
            ? landlordEmail
            : null,
        );

        await prisma.emailLog.update({
          where: { id: logId },
          data: result.ok
            ? {
                status: "SENT",
                provider_id: result.providerId,
                sent_at: new Date(),
                error: null,
              }
            : { status: "FAILED", error: result.error.slice(0, 1000) },
        });

        if (!result.ok) {
          console.error("[notify] send failed", {
            log_id: logId,
            kind: args.payload.kind,
            error: result.error,
          });
        }
      } catch (err) {
        // Absolute last resort. Nothing below this may escape: an exception
        // escaping `after()` is an unhandled rejection in the runtime.
        console.error("[notify] dispatch threw", {
          log_id: logId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  } catch (err) {
    // The outer guarantee: a notification problem must never surface to the
    // caller, whose write has already succeeded.
    console.error("[notify] skipped after error", {
      kind: args.payload.kind,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Dedupe key for a lease assignment.
 *
 * Keyed on (lease, unit) rather than the lease alone, so a genuine
 * RE-assignment to a different unit does notify the tenant again — that is a
 * new fact they need — while a repeated save of the same assignment does not.
 */
export function assignmentDedupeKey(leaseId: string, unitId: string): string {
  return `ASSIGNMENT:${leaseId}:${unitId}`;
}

/**
 * Dedupe key for a payment receipt: the payment id, which is stable across
 * every retry of the same idempotent request.
 */
export function paymentReceiptDedupeKey(paymentId: string): string {
  return `PAYMENT_RECEIPT:${paymentId}`;
}

/**
 * Assignment notice — the single entry point for ALL THREE lease paths.
 *
 * Leases are created or moved in three different routes:
 *   1. POST /api/leases                  — direct creation
 *   2. POST /api/tenants                 — tenant + lease together (onboarding)
 *   3. PATCH /api/tenants/[tenantId]     — re-assignment to another unit
 *
 * Wiring only the obvious one would leave most real assignments silent, since
 * onboarding is by far the busiest path. Putting the lookups here rather than
 * at each call site means the three cannot drift: they pass ids, this resolves
 * names, rent and address once.
 *
 * Loads the current rent rate itself — none of the three callers has it to
 * hand, and a tenancy notice without the rent is close to useless.
 */
export async function notifyLeaseAssignment(args: {
  landlordUserId: string;
  leaseId: string;
  houseId: string;
  unitId: string;
  tenantId: string;
  moveInDate: Date;
  securityDeposit: string | null;
}): Promise<void> {
  try {
    const [tenant, unit, house, rate] = await Promise.all([
      prisma.tenant.findUnique({
        where: { id: args.tenantId },
        select: { id: true, full_name: true, email: true },
      }),
      prisma.unit.findUnique({
        where: { id: args.unitId },
        select: { name: true },
      }),
      prisma.house.findUnique({
        where: { id: args.houseId },
        select: { name: true },
      }),
      // The open rate (effective_to IS NULL) is the one in force now.
      prisma.rentRate.findFirst({
        where: { unit_id: args.unitId, effective_to: null },
        orderBy: { effective_from: "desc" },
        select: { amount: true },
      }),
    ]);

    // No address on file is the common case in this market, not a failure.
    if (!tenant?.email) return;

    await notifyTenant({
      landlordUserId: args.landlordUserId,
      recipient: {
        tenantId: tenant.id,
        tenantName: tenant.full_name,
        email: tenant.email,
      },
      payload: {
        kind: "ASSIGNMENT",
        houseName: house?.name ?? "",
        unitName: unit?.name ?? "",
        moveInDate: args.moveInDate,
        monthlyRent: rate ? rate.amount.toFixed(2) : null,
        securityDeposit:
          args.securityDeposit && Number(args.securityDeposit) > 0
            ? args.securityDeposit
            : null,
      },
      dedupeKey: assignmentDedupeKey(args.leaseId, args.unitId),
    });
  } catch (err) {
    // Same contract as notifyTenant: the lease write has already committed and
    // must not be undone by a notification problem.
    console.error("[notify] assignment skipped", {
      lease_id: args.leaseId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
