import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// CORS for cross-origin clients during development. The frontend may be running
// on a different origin:
//   - Flutter Web on http://localhost:5000 (or another port)
//   - Android emulator on http://10.0.2.2:3000 (same-origin in practice)
//   - Physical Android device on http://192.168.x.x:3000 (cross-origin to the browser)
//
// In production, replace the wildcard with the explicit frontend origin:
//   const ALLOWED_ORIGIN = "https://app.yourdomain.com";
export async function middleware(request: NextRequest) {
  // Refresh Supabase auth cookies before anything else so the downstream
  // handler sees an up-to-date session.
  let response = await updateSession(request);

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
  const origin = request.headers.get("origin") ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
  };
}

export const config = {
  // Run on API routes (CORS) and any non-static path so Supabase can refresh
  // sessions on page navigations.
  matcher: ["/api/:path*", "/((?!_next/static|_next/image|favicon.ico).*)"],
};
