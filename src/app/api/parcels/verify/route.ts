import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { isCountyKey, listCounties } from "@/adapters/registry";
import { getDb } from "@/db";
import { verifyParcel } from "@/lib/eligibility/verify-parcel";

const requestSchema = z.object({
  county: z.string(),
  parcelId: z.string().min(1),
  minSqft: z.number().int().positive(),
  allowedFloodZones: z.array(z.string()).default(["X"]),
  wetlandsAllowed: z.boolean().default(false),
});

/** Runs the eligibility pipeline for one parcel. Session-gated (internal tool). */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request", issues: parsed.error.flatten() }, { status: 400 });
  }
  const { county, parcelId, minSqft, allowedFloodZones, wetlandsAllowed } = parsed.data;
  if (!isCountyKey(county)) {
    return NextResponse.json({ error: `unknown county — expected one of ${listCounties().join(", ")}` }, { status: 400 });
  }

  const result = await verifyParcel(getDb(), county, parcelId, { minSqft, allowedFloodZones, wetlandsAllowed });
  if (!result) return NextResponse.json({ error: "parcel not found" }, { status: 404 });
  return NextResponse.json(result);
}
