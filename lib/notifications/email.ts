import type { RenderedMessage, SendResult } from "./types";

/**
 * Resend adapter.
 *
 * Uses `fetch` against Resend's REST API rather than the `resend` SDK — the
 * whole call is one POST, and a serverless function pays for every byte of
 * bundle on cold start. One fewer dependency to keep current, too.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Give up rather than hold a function open on a slow third party. */
const TIMEOUT_MS = 10_000;

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM);
}

export async function sendEmail(
  to: string,
  message: RenderedMessage,
  replyTo?: string | null,
): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;

  if (!apiKey || !from) {
    // Not an exception: an unconfigured mailer is the normal state in dev and
    // on preview. The caller records it and carries on.
    return {
      ok: false,
      error: "NOT_CONFIGURED: RESEND_API_KEY / RESEND_FROM are unset.",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: message.subject,
        html: message.html,
        // Both parts, always. A text alternative is what keeps a message out
        // of spam filters that penalise HTML-only mail, and it is what the
        // tenant sees on a client that blocks rich content.
        text: message.text,
        // Replies reach the landlord rather than a no-reply void. The tenant's
        // most likely response to a rent receipt is a question about it.
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
      signal: controller.signal,
    });

    const bodyText = await response.text();

    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status}: ${bodyText.slice(0, 300)}`,
      };
    }

    let providerId: string | null = null;
    try {
      providerId = (JSON.parse(bodyText) as { id?: string }).id ?? null;
    } catch {
      // A 2xx with an unparseable body still means it was accepted; we just
      // lose the provider id for correlation.
    }

    return { ok: true, providerId };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: aborted
        ? `TIMEOUT after ${TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
