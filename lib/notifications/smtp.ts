import nodemailer, { type Transporter } from "nodemailer";
import type { RenderedMessage, SendResult } from "./types";

/**
 * SMTP adapter — the path that can genuinely send from a @gmail.com address.
 *
 * WHY THIS EXISTS ALONGSIDE THE RESEND ADAPTER
 * --------------------------------------------
 * Resend (and every other transactional API) requires you to prove you own the
 * sending domain by publishing SPF and DKIM DNS records. You cannot publish DNS
 * for gmail.com — Google owns it — so `from: rentensoftware@gmail.com` can
 * never be verified there. Since Google and Yahoo tightened bulk-sender rules
 * in 2024, mail that fails SPF/DKIM alignment is rejected or filed as spam.
 *
 * Gmail's own SMTP server is different: you authenticate AS the account, so the
 * From address is legitimately yours and alignment holds automatically.
 *
 * THE TRADE-OFFS, WHICH ARE REAL
 * ------------------------------
 *   * ~500 recipients/day on a free Gmail account (2,000 on Workspace). Every
 *     payment sends a receipt, so this becomes the ceiling well before Resend's
 *     3,000/month would.
 *   * Needs an App Password, which needs 2-Step Verification on the account.
 *     A normal Gmail password will NOT work.
 *   * SMTP holds a TCP connection, so it is slower per send than one HTTPS
 *     request — which is exactly why this runs inside `after()`.
 *   * Gmail rewrites the From header to the authenticated account, so the
 *     configured address must match the credentials.
 *
 * Once a real domain exists, switching back is a matter of setting
 * RESEND_API_KEY instead — see selectTransport() in ./index.ts.
 */

const TIMEOUT_MS = 15_000;

/**
 * Reused across invocations on a warm lambda. Creating a transporter per send
 * means a fresh TLS handshake every time, which on Gmail is most of the cost.
 */
let cached: Transporter | null = null;

export function smtpConfigured(): boolean {
  return Boolean(
    process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD,
  );
}

function transporter(): Transporter {
  if (cached) return cached;

  const port = Number(process.env.SMTP_PORT ?? 587);

  cached = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // 465 is implicit TLS; 587 starts plaintext and upgrades via STARTTLS.
    // Getting this pair wrong is the usual cause of a hang rather than an error.
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });

  return cached;
}

export async function sendViaSmtp(
  to: string,
  message: RenderedMessage,
  replyTo?: string | null,
): Promise<SendResult> {
  const user = process.env.SMTP_USER;
  const from = process.env.SMTP_FROM || user;

  if (!smtpConfigured() || !from) {
    return {
      ok: false,
      error: "NOT_CONFIGURED: SMTP_HOST / SMTP_USER / SMTP_PASSWORD are unset.",
    };
  }

  try {
    const info = await transporter().sendMail({
      from,
      to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      ...(replyTo ? { replyTo } : {}),
    });

    return { ok: true, providerId: info.messageId ?? null };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);

    // Gmail's auth rejection is opaque unless you know what it means, and it is
    // by far the most likely failure here — so translate it once, at the point
    // where the cause is known, rather than leaving a bare 535 in the log.
    const friendly = /invalid login|535|BadCredentials/i.test(raw)
      ? `${raw} — Gmail requires an APP PASSWORD (16 characters, from ` +
        `myaccount.google.com/apppasswords with 2-Step Verification enabled). ` +
        `A normal account password is always rejected here.`
      : raw;

    return { ok: false, error: friendly };
  }
}
