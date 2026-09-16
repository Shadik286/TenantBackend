import { NextRequest } from "next/server";

import { handleSubscriptionReturn } from "@/lib/bdapps/return-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// ---------------------------------------------------------------------------
// GET /api/subscription/return/<requestId>
// ---------------------------------------------------------------------------
//
// Where bdApps sends the user back. The attempt id is in the PATH because the
// query string does not survive the round trip: every observed return arrived
// with no parameters whatsoever, so a requestId passed as `?requestId=` came
// back empty and the attempt could never be matched to a user.
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await context.params;
  return handleSubscriptionReturn(request, requestId);
}
