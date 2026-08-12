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
- A statewide fallback exists (`Florida_Statewide_Cadastral` FeatureServer, FDOR annual snapshot) — fast for `PARCEL_ID` lookups but stale for owners; county sources stay authoritative. DOR county numbers if ever needed: Charlotte 18, Lee 36, St. Lucie 66.
- `hazards.fema.gov` has broken IPv6 — [instrumentation.ts](../instrumentation.ts) forces IPv4-first at server boot.
