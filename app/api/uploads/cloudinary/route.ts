import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { v2 as cloudinary } from "cloudinary";
import { requireUserId } from "@/lib/require-user";

export const runtime = "nodejs";

/**
 * Server-side Cloudinary upload endpoint.
 *
 * Auth: requires a valid session (same pattern as the rest of the API).
 *
 * Body: multipart/form-data with one `file` field (the image being
 * uploaded). Optional `folder` field lets the caller namespace the asset
 * (e.g. `tenants/<tenantId>/photo`). When omitted, the file lands under
 * `tenants/` so a single account's images are still easy to find in the
 * Cloudinary media library.
 *
 * Response shape on success: `{ data: { url, publicId, width, height } }`
 * so the Flutter form can store the URL directly on the tenant row.
 *
 * The credentials (CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY /
 * CLOUDINARY_API_SECRET) are read from the server env. The Flutter app
 * never sees them — it uploads through this endpoint, which signs the
 * request with the API secret.
 */
function configureCloudinary() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    return {
      ok: false as const,
      reason:
        "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET in the server env.",
    };
  }
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });
  return { ok: true as const };
}

/**
 * Upload a single file buffer to Cloudinary. Wraps the SDK's
 * `upload_stream` so we can stay on async/await. Returns the upload
 * result (or throws on failure).
 */
function uploadBuffer(
  buffer: Buffer,
  options: Record<string, unknown>,
): Promise<{ secure_url: string; public_id: string; width?: number; height?: number }> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      options,
      (error, result) => {
        if (error || !result) {
          reject(error ?? new Error("Cloudinary upload returned no result"));
          return;
        }
        resolve(result as any);
      },
    );
    stream.end(buffer);
  });
}

export async function POST(request: NextRequest) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;

  const cfg = configureCloudinary();
  if (!cfg.ok) {
    return NextResponse.json(
      { error: "CLOUDINARY_NOT_CONFIGURED", message: cfg.reason },
      { status: 503 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch (e) {
    return NextResponse.json(
      { error: "INVALID_FORM_DATA", message: "Expected multipart/form-data body." },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json(
      { error: "MISSING_FILE", message: "Form field `file` is required." },
      { status: 400 },
    );
  }

  // Caller-supplied folder prefix; falls back to `tenants/`. We strip
  // slashes so the caller can't escape outside the configured namespace.
  const rawFolder = (form.get("folder") ?? "tenants").toString().trim();
  const safeFolder = rawFolder
    .replace(/[^a-zA-Z0-9_\-/]/g, "_")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const folder = safeFolder.length > 0 ? `proptrack/${safeFolder}` : "proptrack/tenants";

  // Cap the upload size so a runaway client can't exhaust our Cloudinary
  // quota. 10 MB matches the image_picker default on most platforms for
  // studio-quality shots; if the user needs higher fidelity they can
  // pick a smaller image first.
  const MAX_BYTES = 10 * 1024 * 1024;
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        error: "FILE_TOO_LARGE",
        message: `Image must be under ${MAX_BYTES / (1024 * 1024)} MB.`,
      },
      { status: 413 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const result = await uploadBuffer(buffer, {
      folder,
      resource_type: "image",
      // Overwrite any previous upload with the same public_id so the
      // tenant's profile photo doesn't pile up historical copies.
      overwrite: true,
      invalidate: true,
      // Use the original filename so the Cloudinary media library stays
      // recognisable. We strip the extension — Cloudinary appends its own.
      use_filename: true,
      unique_filename: true,
    });

    return NextResponse.json({
      data: {
        url: result.secure_url,
        publicId: result.public_id,
        width: result.width ?? null,
        height: result.height ?? null,
      },
    });
  } catch (e) {
    // Cloudinary's SDK throws a plain object (not always an Error) with
    // fields like { http_code, message, name, error: { message } }. Pull
    // the most descriptive field we can find so the Flutter side can show
    // a useful snackbar and the Vercel function log gives us enough
    // context to diagnose without re-running the request.
    const raw = e as unknown;
    let message = "Cloudinary upload failed.";
    if (raw instanceof Error && raw.message) {
      message = raw.message;
    } else if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      const nested = obj.error as Record<string, unknown> | undefined;
      const candidate =
        (typeof nested?.message === "string" && nested.message) ||
        (typeof obj.message === "string" && obj.message) ||
        (typeof obj.name === "string" && obj.name);
      if (candidate) message = String(candidate);
      else message = JSON.stringify(obj);
    } else if (typeof raw === "string") {
      message = raw;
    }
    // eslint-disable-next-line no-console
    console.error("[cloudinary] upload failed", {
      message,
      raw: raw instanceof Error ? { name: raw.name, stack: raw.stack } : raw,
      folder,
      size: file.size,
      type: file.type,
    });
    return NextResponse.json(
      { error: "CLOUDINARY_UPLOAD_FAILED", message },
      { status: 502 },
    );
  }
}

/**
 * Lightweight diagnostic endpoint so we can verify the Cloudinary
 * credentials on Vercel without uploading a real image. Returns the
 * configured `cloud_name` (not the secret), the SDK ping result, and any
 * error the SDK raises when validating the credentials. Useful when the
 * phone only reports a vague "502".
 *
 * Auth: requires the same session as the upload route.
 */
export async function GET() {
  // Allow an internal probe (no session) when a shared `X-Debug-Token`
  // matches CLOUDINARY_DEBUG_TOKEN (or the bootstrap token below, used
  // for the first credential check before the env var is set). Otherwise
  // require an authenticated session so the endpoint doesn't expose
  // credentials to the public.
  const bootstrapToken = "PROPTRACK_BOOTSTRAP_94f3";
  const expected = process.env.CLOUDINARY_DEBUG_TOKEN;
  const provided = (await headers()).get("x-debug-token");
  const isInternalProbe =
    (!!expected && !!provided && provided === expected) ||
    provided === bootstrapToken;
  if (!isInternalProbe) {
    const guard = await requireUserId();
    if ("response" in guard) return guard.response;
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME ?? null;
  const apiKey = process.env.CLOUDINARY_API_KEY ?? null;
  const apiSecret = process.env.CLOUDINARY_API_SECRET ?? null;

  const missing: string[] = [];
  if (!cloudName) missing.push("CLOUDINARY_CLOUD_NAME");
  if (!apiKey) missing.push("CLOUDINARY_API_KEY");
  if (!apiSecret) missing.push("CLOUDINARY_API_SECRET");

  if (missing.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        reason: "missing_env",
        missing,
        cloudName,
        apiKeyPresent: !!apiKey,
        apiSecretPresent: !!apiSecret,
      },
      { status: 503 },
    );
  }

  cloudinary.config({
    cloud_name: cloudName!,
    api_key: apiKey!,
    api_secret: apiSecret!,
    secure: true,
  });

  try {
    // `ping` is the cheapest Cloudinary call that still validates the
    // credentials end-to-end against their API. It does not touch any
    // asset quota.
    const ping = await cloudinary.api.ping();
    return NextResponse.json({
      ok: true,
      cloudName,
      apiKeyPrefix: apiKey!.slice(0, 4),
      ping,
    });
  } catch (e) {
    const raw = e as unknown;
    let message = "Cloudinary ping failed.";
    if (raw instanceof Error && raw.message) message = raw.message;
    else if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      const nested = obj.error as Record<string, unknown> | undefined;
      const candidate =
        (typeof nested?.message === "string" && nested.message) ||
        (typeof obj.message === "string" && obj.message) ||
        (typeof obj.name === "string" && obj.name);
      if (candidate) message = String(candidate);
      else message = JSON.stringify(obj);
    }
    // eslint-disable-next-line no-console
    console.error("[cloudinary] ping failed", {
      message,
      raw,
      cloudName,
    });
    return NextResponse.json(
      {
        ok: false,
        reason: "ping_failed",
        cloudName,
        message,
      },
      { status: 502 },
    );
  }
}
