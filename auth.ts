import NextAuth, { type NextAuthOptions, getServerSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import type { DefaultSession } from "next-auth";
import { prisma } from "@/lib/prisma";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      id: string;
    };
  }
}


export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        identifier: { label: "Email or Phone", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(rawCredentials) {
        const credentials = (rawCredentials ?? {}) as Record<string, unknown>;
        const idRaw = credentials.identifier ?? credentials.email;
        const identifier = typeof idRaw === "string" ? idRaw.trim() : "";
        const password =
          typeof credentials.password === "string" ? credentials.password : "";

        if (!identifier || !password) {
          return null;
        }

        const looksLikeEmail = identifier.includes("@");
        if (
          looksLikeEmail &&
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)
        ) {
          return null;
        }

        const normalizedPhone = identifier.replace(/[^\d+]/g, "");
        const phoneDigits = normalizedPhone.replace(/[^\d]/g, "");

        let user = null;
        if (looksLikeEmail) {
          user = await prisma.user.findUnique({
            where: { email: identifier.toLowerCase() },
          });
        } else if (phoneDigits.length >= 8) {
          user = await prisma.user.findFirst({
            where: { phone: normalizedPhone },
          });
        }

        if (!user) {
          return null;
        }
        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.full_name,
        };
      },
    }),
  ],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user = {
          ...session.user,
          id: token.id as string,
        };
      }
      return session;
    },
  },
};

// App Router entry: returns the route handlers that respond to GET and POST
// requests for `/api/auth/[...nextauth]`. Next.js 15+ delivers route context
// as `params: Promise<...>`. NextAuth v4 expects a sync object, so we await
// it inside our wrapper before forwarding.
type RouteCtx = { params: Promise<Record<string, string | string[]>> };
async function handler(req: Request, ctx: RouteCtx) {
  const params = await ctx.params;
  return (NextAuth(authOptions) as unknown as (
    r: Request,
    c: { params: Record<string, string | string[]> }
  ) => Promise<Response>)(req, { params });
}

export const handlers = { GET: handler, POST: handler };

// App-Router-friendly way to read the current session in a route handler.
// Wraps NextAuth's `getServerSession` so callers can do `await auth()`.
export async function auth() {
  const session = await getServerSession(authOptions);
  if (process.env.NODE_ENV !== "production" && session) {
    console.log("[auth] session user keys:", Object.keys(session.user), "user.id:", session.user?.id);
  }
  return session;
}

// Placeholder stubs for v5-style API surface.
// `signIn` / `signOut` aren't used by route handlers in this project —
// login uses /api/auth/login instead. Exported so TS stops complaining.
export const signIn = async () => {
  throw new Error("signIn is not implemented; use /api/auth/login instead.");
};
export const signOut = async () => {
  throw new Error("signOut is not implemented; call your own endpoint.");
};
