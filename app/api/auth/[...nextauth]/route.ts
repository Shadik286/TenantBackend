// The /api/auth/[...nextauth] catch-all is provided by the centralized
// `auth.ts` module. Re-exporting handlers keeps the Credentials provider
// authoritative while still serving /signin, /session, /csrf, /callback/*.
import { handlers } from "@/auth";

export const { GET, POST } = handlers;
