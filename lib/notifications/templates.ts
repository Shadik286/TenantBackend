import type {
  AssignmentPayload,
  NotificationPayload,
  PaymentReceiptPayload,
  RecipientContext,
  RenderedMessage,
  SenderContext,
} from "./types";

/**
 * Bilingual templates (en-US / bn-BD), chosen from the LANDLORD's
 * `UserPreference.language`.
 *
 * Using the landlord's preference is a deliberate approximation: we store no
 * language for tenants, and a landlord who runs the app in Bengali almost
 * certainly has Bengali-speaking tenants. If a tenant language field is added
 * later, this is the only place that needs to change.
 */

function isBengali(language: string): boolean {
  return language.toLowerCase().startsWith("bn");
}

/**
 * Money for display. Deliberately NOT Intl.NumberFormat with the Bengali
 * locale: that renders Bengali numerals (১,০০০), which look wrong on a
 * financial receipt someone may need to reconcile against a bank statement or
 * read out over the phone. Western digits with a currency symbol are
 * unambiguous in both languages.
 */
function money(amount: string, currency: string): string {
  const n = Number(amount);
  const safe = Number.isFinite(n) ? n : 0;
  const formatted = safe.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const symbol = currency === "BDT" ? "৳" : `${currency} `;
  return `${symbol}${formatted}`;
}

function formatDate(date: Date, language: string): string {
  return date.toLocaleDateString(isBengali(language) ? "en-GB" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "2026-09" -> "September 2026". */
function monthLabel(dueMonth: string): string {
  const [y, m] = dueMonth.split("-").map(Number);
  if (!y || !m) return dueMonth;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/** Escapes interpolated values — tenant and property names are free text. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Shared shell. Inline styles only — Gmail and Outlook strip <style> blocks,
 * and a table-based layout is what survives both.
 */
function wrap(bodyHtml: string, footerHtml: string): string {
  return `<!-- rendered by Renten -->
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#f8f9fb;padding:24px 12px;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;border:1px solid #e5e7eb;">
    <tr><td style="padding:28px 28px 8px 28px;">${bodyHtml}</td></tr>
    <tr><td style="padding:16px 28px 24px 28px;border-top:1px solid #f3f4f6;color:#6b7280;font-size:12px;line-height:1.6;">${footerHtml}</td></tr>
  </table>
</div>`;
}

/**
 * Every message says who sent it and why.
 *
 * The tenant never signed up for this app — the landlord typed their address
 * in — so an unexplained email is indistinguishable from spam. Naming the
 * landlord and the property is what makes it legible, and it is also what a
 * Play Data Safety declaration expects of unsolicited mail.
 */
function footer(sender: SenderContext, bengali: boolean): string {
  const who = esc(sender.landlordName);
  return bengali
    ? `এই বার্তাটি <strong>${who}</strong> পাঠিয়েছেন Renten-এর মাধ্যমে, কারণ আপনি তাঁর একজন ভাড়াটিয়া হিসেবে তালিকাভুক্ত। কোনো প্রশ্ন থাকলে সরাসরি তাঁর সঙ্গে যোগাযোগ করুন।`
    : `Sent by <strong>${who}</strong> via Renten because you are listed as their tenant. For any questions, please contact them directly.`;
}

function renderAssignment(
  p: AssignmentPayload,
  recipient: RecipientContext,
  sender: SenderContext,
): RenderedMessage {
  const bn = isBengali(sender.language);
  const name = esc(recipient.tenantName);
  const place = `${esc(p.unitName)}, ${esc(p.houseName)}`;
  const moveIn = formatDate(p.moveInDate, sender.language);
  const rent = p.monthlyRent ? money(p.monthlyRent, sender.currency) : null;
  const deposit = p.securityDeposit
    ? money(p.securityDeposit, sender.currency)
    : null;

  const rows: string[] = [];
  const row = (k: string, v: string) =>
    `<tr><td style="padding:6px 0;color:#6b7280;font-size:14px;">${k}</td><td style="padding:6px 0;color:#111827;font-size:14px;font-weight:600;text-align:right;">${v}</td></tr>`;

  rows.push(row(bn ? "ইউনিট" : "Unit", place));
  rows.push(row(bn ? "উঠার তারিখ" : "Move-in date", moveIn));
  if (rent) rows.push(row(bn ? "মাসিক ভাড়া" : "Monthly rent", rent));
  if (deposit) rows.push(row(bn ? "জামানত" : "Security deposit", deposit));

  const subject = bn
    ? `আপনার ভাড়ার তথ্য — ${p.unitName}`
    : `Your tenancy details — ${p.unitName}`;

  const heading = bn ? "আপনার ভাড়া নিশ্চিত হয়েছে" : "Your tenancy is confirmed";
  const intro = bn
    ? `প্রিয় ${name},<br><br>আপনাকে নিচের ইউনিটে ভাড়াটিয়া হিসেবে যুক্ত করা হয়েছে।`
    : `Hello ${name},<br><br>You have been added as the tenant for the unit below.`;

  const html = wrap(
    `<h1 style="margin:0 0 14px 0;font-size:20px;color:#111827;">${heading}</h1>
     <p style="margin:0 0 18px 0;font-size:14px;line-height:1.6;color:#374151;">${intro}</p>
     <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows.join("")}</table>`,
    footer(sender, bn),
  );

  const textLines = [
    heading,
    "",
    bn ? `প্রিয় ${recipient.tenantName},` : `Hello ${recipient.tenantName},`,
    bn
      ? "আপনাকে নিচের ইউনিটে ভাড়াটিয়া হিসেবে যুক্ত করা হয়েছে।"
      : "You have been added as the tenant for the unit below.",
    "",
    `${bn ? "ইউনিট" : "Unit"}: ${p.unitName}, ${p.houseName}`,
    `${bn ? "উঠার তারিখ" : "Move-in date"}: ${moveIn}`,
    rent ? `${bn ? "মাসিক ভাড়া" : "Monthly rent"}: ${rent}` : null,
    deposit ? `${bn ? "জামানত" : "Security deposit"}: ${deposit}` : null,
    "",
    bn
      ? `পাঠিয়েছেন ${sender.landlordName} — Renten`
      : `Sent by ${sender.landlordName} via Renten`,
  ].filter(Boolean) as string[];

  return { subject, html, text: textLines.join("\n") };
}

function renderPaymentReceipt(
  p: PaymentReceiptPayload,
  recipient: RecipientContext,
  sender: SenderContext,
): RenderedMessage {
  const bn = isBengali(sender.language);
  const name = esc(recipient.tenantName);
  const paidAmount = money(p.amountPaid, sender.currency);
  const remaining = money(p.remaining, sender.currency);
  const due = money(p.amountDue, sender.currency);
  const total = money(p.totalPaid, sender.currency);
  const when = formatDate(p.datePaid, sender.language);
  const month = monthLabel(p.dueMonth);
  const settled = p.status === "PAID";

  // The branch that matters. A partial payment described as "paid in full"
  // is a worse outcome than no email, so the two states get different
  // headings, different body copy, and a different banner colour.
  const subject = settled
    ? bn
      ? `ভাড়া পরিশোধিত — ${month}`
      : `Rent paid in full — ${month}`
    : bn
      ? `আংশিক পরিশোধ গৃহীত — ${month}`
      : `Partial payment received — ${month}`;

  const heading = settled
    ? bn
      ? "ধন্যবাদ — ভাড়া সম্পূর্ণ পরিশোধিত"
      : "Thank you — rent fully paid"
    : bn
      ? "আংশিক পরিশোধ গৃহীত হয়েছে"
      : "Partial payment received";

  const lead = settled
    ? bn
      ? `${month} মাসের ভাড়া সম্পূর্ণ পরিশোধিত হয়েছে। ${when} তারিখে ${paidAmount} গ্রহণ করা হয়েছে।`
      : `Rent for ${month} is fully paid. ${paidAmount} received on ${when}.`
    : bn
      ? `${when} তারিখে ${paidAmount} গ্রহণ করা হয়েছে। ${month} মাসের জন্য এখনও ${remaining} বকেয়া রয়েছে।`
      : `${paidAmount} received on ${when}. ${remaining} is still outstanding for ${month}.`;

  const banner = settled
    ? { bg: "#dcfce7", fg: "#15803d" }
    : { bg: "#fef3c7", fg: "#b45309" };

  const row = (k: string, v: string, strong = false) =>
    `<tr><td style="padding:6px 0;color:#6b7280;font-size:14px;">${k}</td><td style="padding:6px 0;color:${strong ? banner.fg : "#111827"};font-size:14px;font-weight:${strong ? 700 : 600};text-align:right;">${v}</td></tr>`;

  const rows = [
    row(bn ? "ইউনিট" : "Unit", `${esc(p.unitName)}, ${esc(p.houseName)}`),
    row(bn ? "মাস" : "For month", month),
    row(bn ? "এই পরিশোধ" : "This payment", paidAmount, true),
    row(bn ? "পদ্ধতি" : "Method", esc(p.method.replace(/_/g, " "))),
    row(bn ? "মোট প্রাপ্য" : "Total due", due),
    row(bn ? "মোট পরিশোধিত" : "Total paid", total),
    settled ? "" : row(bn ? "বকেয়া" : "Outstanding", remaining, true),
    p.referenceNo
      ? row(bn ? "রেফারেন্স" : "Reference", esc(p.referenceNo))
      : "",
  ].join("");

  const html = wrap(
    `<div style="background:${banner.bg};color:${banner.fg};padding:10px 14px;border-radius:10px;font-size:13px;font-weight:700;display:inline-block;margin-bottom:14px;">
       ${settled ? (bn ? "সম্পূর্ণ পরিশোধিত" : "PAID IN FULL") : bn ? "আংশিক" : "PARTIAL"}
     </div>
     <h1 style="margin:0 0 12px 0;font-size:20px;color:#111827;">${heading}</h1>
     <p style="margin:0 0 18px 0;font-size:14px;line-height:1.6;color:#374151;">
       ${bn ? `প্রিয় ${name},` : `Hello ${name},`}<br><br>${lead}
     </p>
     <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows}</table>`,
    footer(sender, bn),
  );

  const textLines = [
    heading,
    "",
    bn ? `প্রিয় ${recipient.tenantName},` : `Hello ${recipient.tenantName},`,
    lead.replace(/<[^>]+>/g, ""),
    "",
    `${bn ? "ইউনিট" : "Unit"}: ${p.unitName}, ${p.houseName}`,
    `${bn ? "মাস" : "For month"}: ${month}`,
    `${bn ? "এই পরিশোধ" : "This payment"}: ${paidAmount}`,
    `${bn ? "পদ্ধতি" : "Method"}: ${p.method.replace(/_/g, " ")}`,
    `${bn ? "মোট প্রাপ্য" : "Total due"}: ${due}`,
    `${bn ? "মোট পরিশোধিত" : "Total paid"}: ${total}`,
    settled ? null : `${bn ? "বকেয়া" : "Outstanding"}: ${remaining}`,
    p.referenceNo ? `${bn ? "রেফারেন্স" : "Reference"}: ${p.referenceNo}` : null,
    "",
    bn
      ? `পাঠিয়েছেন ${sender.landlordName} — Renten`
      : `Sent by ${sender.landlordName} via Renten`,
  ].filter(Boolean) as string[];

  return { subject, html, text: textLines.join("\n") };
}

export function renderNotification(
  payload: NotificationPayload,
  recipient: RecipientContext,
  sender: SenderContext,
): RenderedMessage {
  return payload.kind === "ASSIGNMENT"
    ? renderAssignment(payload, recipient, sender)
    : renderPaymentReceipt(payload, recipient, sender);
}
