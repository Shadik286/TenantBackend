import { NextRequest } from "next/server";

import { handleSubscriptionReturn } from "@/lib/bdapps/return-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Waits on the bdApps bridge, which answers in seconds rather than
// milliseconds.
export const maxDuration = 30;

// ---------------------------------------------------------------------------
// GET /api/subscription/return
// ---------------------------------------------------------------------------
//
// The legacy shape, kept because attempts started before the change was
// deployed still carry this URL. It can only work if bdApps echoes a
// requestId, which they do not - see the /[requestId] route.
export async function GET(request: NextRequest) {
  return handleSubscriptionReturn(request);
}
