import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Allow-list of origins that may call this API. Mobile apps (Android/iOS)
// don't trigger CORS at all, so this list only governs browser/Flutter Web
// callers.
//
// Comma-separate multiple origins in the ALLOWED_ORIGINS env var if you host
// the web client on more than one domain (e.g. staging + production). Empty
// value falls back to a safe wildcard so dev-tools like curl/Postman keep
// working in local development.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function resolveAllowedOrigin(request: NextRequest): string {
  const origin = request.headers.get("origin");
  if (!origin) return ALLOWED_ORIGINS[0] ?? "*";
  if (ALLOWED_ORIGINS.length === 0) return origin;
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

export async function middleware(request: NextRequest) {
  // Refresh Supabase auth cookies before anything else so the downstream
  // handler sees an up-to-date session. If Supabase isn't configured we still
  // get a pass-through response from updateSession, but we wrap in try/catch
  // so a stray failure never breaks the API surface.
  let response: NextResponse;
  try {
    response = await updateSession(request);
  } catch {
    response = NextResponse.next();
  }

  // Short-circuit preflight with a 204 carrying the CORS headers. Without this
  // Next.js returns 204 with no headers and the browser blocks the real call.
  if (request.method === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers: corsHeaders(request),
    });
  }

  const headers = corsHeaders(request);
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  return response;
}

function corsHeaders(request: NextRequest): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": resolveAllowedOrigin(request),
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export const config = {
  // Run on API routes (CORS) and any non-static path so Supabase can refresh
  // sessions on page navigations.
  matcher: ["/api/:path*", "/((?!_next/static|_next/image|favicon.ico).*)"],
};
