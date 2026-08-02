import { NextResponse } from "next/server";
import { v2 as cloudinary } from "cloudinary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public diagnostic endpoint used to verify Cloudinary credentials on
 * the live Vercel deployment. Returns the configured cloud name, which
 * env vars are missing (if any), and either the SDK ping result or the
 * SDK error message. No auth required so we can hit it from curl.
 *
 * This is intentionally a separate path from `/api/uploads/cloudinary`
 * to avoid the question of "did the upload route get rebuilt?". If this
 * endpoint is missing from the build, Vercel genuinely didn't deploy.
 *
 * BUILD MARKER: route-v6
 */
export async function GET() {
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
    const ping = await cloudinary.api.ping();
    return NextResponse.json({
      ok: true,
      cloudName,
      apiKeyPrefix: apiKey!.slice(0, 4),
      apiSecretPrefix: apiSecret!.slice(0, 4),
      ping,
    });
  } catch (e) {
    const raw = e as unknown;
    let message = "Cloudinary ping failed.";
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
    }
    // eslint-disable-next-line no-console
    console.error("[cloudinary] diagnostics ping failed", {
      message,
      raw,
      cloudName,
    });
    return NextResponse.json(
      {
        ok: false,
        reason: "ping_failed",
        cloudName,
        apiKeyPrefix: apiKey!.slice(0, 4),
        apiSecretPrefix: apiSecret!.slice(0, 4),
        message,
      },
      { status: 502 },
    );
  }
}
