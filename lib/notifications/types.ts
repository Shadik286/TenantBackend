/**
 * Channel-agnostic notification contract.
 *
 * Email is the first adapter, deliberately not the only intended one. In the
 * bdapps market most tenants do not check email daily, while SMS / WhatsApp /
 * imo are near-universal — and `Tenant.email` is nullable precisely because
 * the address is frequently missing. Defining the payload independently of the
 * transport means adding an SMS adapter later is a new file, not a rewrite of
 * every call site.
 */

export type NotificationChannel = "EMAIL" | "SMS" | "WHATSAPP";

export type NotificationKind = "ASSIGNMENT" | "PAYMENT_RECEIPT";

/** Landlord-facing context, so the tenant can tell who is writing to them. */
export type SenderContext = {
  landlordUserId: string;
  landlordName: string;
  /** "en-US" | "bn-BD" — taken from the landlord's UserPreference. */
  language: string;
  /** ISO code, e.g. "BDT". Drives the money formatting in templates. */
  currency: string;
  /**
   * Used as the reply-to, so a tenant's reply reaches the landlord rather than
   * a no-reply void. Null for bdapps accounts, whose synthetic
   * `bdapps+…@tenant.local` address is not deliverable.
   */
  landlordEmail: string | null;
};

export type RecipientContext = {
  tenantId: string;
  tenantName: string;
  /** Null when the landlord never recorded one — the send is skipped. */
  email: string | null;
};

export type AssignmentPayload = {
  kind: "ASSIGNMENT";
  houseName: string;
  unitName: string;
  moveInDate: Date;
  monthlyRent: string | null;
  securityDeposit: string | null;
};

export type PaymentReceiptPayload = {
  kind: "PAYMENT_RECEIPT";
  /** This payment, not the month's running total. */
  amountPaid: string;
  datePaid: Date;
  method: string;
  /** "YYYY-MM". */
  dueMonth: string;
  amountDue: string;
  /** Sum of CONFIRMED payments on the charge, including this one. */
  totalPaid: string;
  /** `amountDue - totalPaid`, floored at zero. */
  remaining: string;
  /**
   * Charge state AFTER this payment. The template branches on it: telling
   * someone who still owes money that their rent is "fully paid" is worse
   * than sending nothing at all.
   */
  status: "PAID" | "PARTIAL" | "UNPAID";
  houseName: string;
  unitName: string;
  referenceNo: string | null;
};

export type NotificationPayload = AssignmentPayload | PaymentReceiptPayload;

export type RenderedMessage = {
  subject: string;
  html: string;
  text: string;
};

export type SendResult =
  | { ok: true; providerId: string | null }
  | { ok: false; error: string };
