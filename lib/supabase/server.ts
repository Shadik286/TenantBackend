import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Server-side only, so no NEXT_PUBLIC_ prefix is needed. The prefixed names are
// kept as a fallback purely so a deploy that still carries the old Vercel
// variables keeps working during the changeover; drop them once the
// NEXT_PUBLIC_* entries are deleted from every environment.
const supabaseUrl =
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Returns a typed stub when env vars are missing so Server Components using
// this client can still render (e.g. the demo /api health page). The `as any`
// is intentional: the shape matches `@supabase/supabase-js` enough for the
// one or two calls we make, and we never call them when env is missing.
function unconfiguredStub(): any {
  return {
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
    },
    from: () => ({
      select: async () => ({ data: null, error: { message: "Supabase env not configured" } }),
    }),
  };
}

export const createClient = (
  cookieStore: Awaited<ReturnType<typeof cookies>>,
) => {
  if (!supabaseUrl || !supabaseKey) {
    return unconfiguredStub();
  }

  return createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // The `setAll` method was called from a Server Component.
          // This can be ignored if you have middleware refreshing
          // user sessions.
        }
      },
    },
  });
};