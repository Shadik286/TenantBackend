// The /api/auth/[...nextauth] catch-all is provided by the centralized
// `auth.ts` module. Re-exporting handlers keeps the Credentials provider
// authoritative while still serving /signin, /session, /csrf, /callback/*.
import { handlers } from "@/auth";

// Pin to Node — bcrypt + NextAuth Credentials use APIs that aren't bundled
// into the Edge runtime, and Vercel's default is Edge which produced the
// empty 500 body on /api/auth/* requests.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, POST } = handlers;
