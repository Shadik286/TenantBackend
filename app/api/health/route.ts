import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which build is answering.
 *
 * Added because "is the thing I am testing the code I pushed?" was not
 * answerable from outside: every route existed on both the preview and the
 * production URLs, so a stale alias and a fresh deploy looked identical.
 * Vercel injects these at build time, and they are the only thing that tells
 * the two apart from a plain curl.
 */
function buildInfo() {
  return {
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? "local",
    env: process.env.VERCEL_ENV ?? "development",
    deployed_at: process.env.VERCEL_DEPLOYMENT_ID ?? null,
  };
}

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;

    return NextResponse.json({
      ok: true,
      message: "Prisma and database connectivity are available.",
      build: buildInfo(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: "Database connectivity check failed.",
        error: error instanceof Error ? error.message : "Unknown error",
        build: buildInfo(),
      },
      { status: 500 }
    );
  }
}
