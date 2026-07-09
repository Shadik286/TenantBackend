import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Refreshes the Supabase auth cookie on every request that flows through the
// middleware matcher. Returns the response that should be sent back so the
// refreshed cookies are persisted to the browser.
//
// If the Supabase env vars aren't set (e.g. fresh deploy before Vercel env
// vars were added) this becomes a no-op and returns a pass-through response,
// so the rest of the app still works instead of returning 500 on every page.
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  if (!supabaseUrl || !supabaseKey) {
    return supabaseResponse;
  }

  try {
    const supabase = createServerClient(supabaseUrl, supabaseKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    });

    // Touch the user so Supabase can refresh the session if needed. The result
    // is intentionally unused here; this call only matters for cookie refresh.
    await supabase.auth.getUser();
  } catch {
    // Swallow Supabase init errors so a missing/misconfigured Supabase setup
    // never takes down the API. The request still flows through.
  }

  return supabaseResponse;
}