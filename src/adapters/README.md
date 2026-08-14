# County adapter registry

One interface ([types.ts](types.ts)), one file per county, fixture tests per
adapter ([adapters.test.ts](adapters.test.ts), recorded live responses in
`__fixtures__/`). Adding a county or a state = adding an adapter file + a
title default row — nothing else changes (design doc §6).

## Launch counties (Florida) — endpoints verified live Aug 12, 2026

| County | Source | Endpoint | Parcel id |
|---|---|---|---|
| St. Lucie | Property Appraiser (PASLC) | `map.paslc.gov/arcgis/rest/services/PROD/SLCPA_PublicParcels/MapServer/0` | `ParcelID`, dashed (`3420-525-0196-000-1`) |
| Lee | Property Appraiser via ArcGIS Online, nightly sync | `services2.arcgis.com/LvWGAAhHwbCJ2GMP/…/Lee_County_Parcels/FeatureServer/0` | `STRAP` (`354426L3121060010`) |
| Charlotte | County GIS "Property Ownership" | `agis.charlottecountyfl.gov/arcgis/rest/services/Essentials/CCGIS_Web_Layers2022/MapServer/17` | `ACCOUNT` (`402125204030`) |

Notes:
- Charlotte returns space-padded strings and stringified numbers; its adapter trims/parses everything and computes sqft from geometry (no stated-area field).
- **Charlotte splits the address across two fields** (found Aug 14, 2026 while building list import): `propertyaddress` is the *street name only* — `"GULFSPRAY CIR"` — and only `FullPropertyAddress` carries the house number, space-padded between the two: `"17200      GULFSPRAY CIR"`. A `LIKE '%17200 GULFSPRAY CIR%'` therefore matches **neither** field, which silently made every address search return zero. Its `searchByAddress` now strips the leading house number, searches the street, and returns up to 500 rows; the caller exact-matches the house number against the trimmed `address` ([lib/lists/address.ts](../lib/lists/address.ts)). Lee and St. Lucie both store the full address in one field and need none of this.
- A statewide fallback exists (`Florida_Statewide_Cadastral` FeatureServer, FDOR annual snapshot) — fast for `PARCEL_ID` lookups but stale for owners; county sources stay authoritative. DOR county numbers if ever needed: Charlotte 18, Lee 36, St. Lucie 66.
- `hazards.fema.gov` has broken IPv6 — [instrumentation.ts](../instrumentation.ts) forces IPv4-first at server boot.

## Adding a county

Counties are the only per-market work. FEMA flood zones and USFWS wetlands are
national layers that already cover the whole US, so a new county needs a parcel
source and nothing else.

1. **Find the county's parcel layer.** Look for an ArcGIS REST endpoint —
   usually the property appraiser or the county GIS. These worked for the three
   launch counties and are the patterns worth trying first:
   - `https://<host>/arcgis/rest/services?f=json` — lists folders and services
   - The county's ArcGIS Hub site (`maps-<county>.hub.arcgis.com`) → its
     `/api/v3/datasets?q=parcels` returns hosted FeatureServer URLs
   - The org id in the Hub page source (`orgId":"..."`), then
     `https://services{N}.arcgis.com/<orgId>/arcgis/rest/services?f=json`

2. **Confirm the layer has what a contract needs** — parcel id, situs address,
   owner of record, legal description, size, and polygon geometry. Query
   `<layer>/0?f=json` to read the field names.

3. **Write the adapter.** Copy the closest existing one; they are ~70 lines.
   Implement `getParcelById` and `searchByAddress`, and map the county's field
   names onto `ParcelRecord`. Watch for fixed-width padding (Charlotte) and
   stated-vs-computed area (some counties have no area field, so size comes from
   the geometry).

4. **Register it** in [registry.ts](registry.ts) and add the key to `CountyKey`
   in [types.ts](types.ts).

5. **Verify it against the live services:**

   ```bash
   npx dotenv -e .env.local -- npx tsx scripts/verify-adapter.ts <county>
   npx dotenv -e .env.local -- npx tsx scripts/verify-adapter.ts <county> <parcelId>
   ```

   The first form does an address search — the quick "is it wired up" check. The
   second pulls one parcel and runs the full chain: every contract field, the
   geometry, a size cross-check against the county's own number, then FEMA and
   NWI. Every line must be ✅ before the county is used.

6. **Record a fixture test.** Save a real response to `__fixtures__/` and assert
   the mapping, as the existing adapters do — that's what catches a county
   silently renaming a field.

7. **Add a title-company default** for the new state, if it isn't Florida.
