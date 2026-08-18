import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";

async function main() {
  const db = getDb();
  const rows = await db.execute(sql`
    SELECT c.name, c.phone, cv.state, cv.escalated,
           p.address, p.parcel_id, p.sqft, p.flood_zones, p.wetlands_intersects,
           p.water_source, p.sewer_type, p.utility_detail,
           d.verdict, d.seller_counter
    FROM contacts c
    JOIN deals d ON d.contact_id = c.id
    LEFT JOIN conversations cv ON cv.deal_id = d.id
    LEFT JOIN parcels p ON p.id = d.parcel_id
    WHERE c.phone = '+15617182883'
  `);
  console.log(JSON.stringify(rows, null, 2));
  console.log("escalated threads left:", (await db.execute(sql`SELECT count(*)::int AS n FROM conversations WHERE escalated = true`))[0]);
}
main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
