import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// CORS for cross-origin clients during development. The frontend may be running
// on a different origin:
//   - Flutter Web on http://localhost:5000 (or another port)
//   - Android emulator on http://10.0.2.2:3000 (same-origin in practice)
//   - Physical Android device on http://192.168.x.x:3000 (cross-origin to the browser)
//
// In production, replace the wildcard with the explicit frontend origin:
//   const ALLOWED_ORIGIN = "https://app.yourdomain.com";
//
// The headers below are echoed on EVERY response that flows through the
// matcher, including the OPTIONS preflight and the actual POST/PATCH/DELETE.
export function middleware(request: NextRequest) {
  // Short-circuit preflight with a 204 carrying the CORS headers. Without this
  // Next.js returns 204 with no headers and the browser blocks the real call.
  if (request.method === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers: corsHeaders(request),
    });
  }

  const response = NextResponse.next();
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
  };
}

export const config = {
  // Apply only to API routes so we don't decorate static assets with CORS.
  matcher: "/api/:path*",
};
