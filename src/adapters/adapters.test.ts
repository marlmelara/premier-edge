import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { polygonAreaSqft, type EsriFeature } from "@/lib/gis/arcgis";
import { mapCharlotteFeature } from "./charlotte";
import { mapLeeFeature } from "./lee";
import { getAdapter, isCountyKey, listCounties } from "./registry";
import { mapStLucieFeature } from "./st-lucie";

const fixture = (name: string): EsriFeature =>
  JSON.parse(readFileSync(join(__dirname, "__fixtures__", name), "utf8"));

describe("adapter registry", () => {
  it("registers the three launch counties", () => {
    expect(listCounties().sort()).toEqual(["charlotte", "lee", "st_lucie"]);
    expect(isCountyKey("lee")).toBe(true);
    expect(isCountyKey("texas")).toBe(false);
    expect(getAdapter("lee").countyName).toBe("Lee");
  });
});

describe("mapLeeFeature (recorded live response)", () => {
  const parcel = mapLeeFeature(fixture("lee-parcel.json"));

  it("maps the identity fields", () => {
    expect(parcel.county).toBe("lee");
    expect(parcel.parcelId).toBe("354426L3121060010");
    expect(parcel.ownerNameRaw).toBe("CASTILLO AGUSTIN PONCE");
    expect(parcel.address).toContain("3219 15TH ST SW");
  });

  it("prefers the county's stated sqft and keeps acreage", () => {
    expect(parcel.sqft).toBe(11530);
    expect(parcel.acreage).toBeCloseTo(0.2647, 3);
  });

  it("deep-links the appraiser and converts geometry", () => {
    expect(parcel.appraiserUrl).toContain("leepa.org");
    expect(parcel.geometry?.type).toBe("Polygon");
    expect(parcel.geometry?.coordinates[0].length).toBeGreaterThan(3);
  });

  it("computes a polygon area consistent with the stated sqft", () => {
    // the geometry itself should agree with the county's stated area within ~10%
    const computed = polygonAreaSqft(parcel.geometry);
    expect(computed).toBeGreaterThan(11530 * 0.9);
    expect(computed).toBeLessThan(11530 * 1.1);
  });
});

describe("mapStLucieFeature (recorded live response)", () => {
  const parcel = mapStLucieFeature(fixture("st-lucie-parcel.json"));

  it("maps identity, size, and value", () => {
    expect(parcel.county).toBe("st_lucie");
    expect(parcel.parcelId).toBe("3420-525-0196-000-1");
    expect(parcel.ownerNameRaw).toBeTruthy();
    expect(parcel.sqft).toBeGreaterThan(1000);
    expect(parcel.geometry?.type).toBe("Polygon");
  });
});

describe("mapCharlotteFeature (recorded live response)", () => {
  const parcel = mapCharlotteFeature(fixture("charlotte-parcel.json"));

  it("trims padded strings and parses padded numbers", () => {
    expect(parcel.county).toBe("charlotte");
    expect(parcel.parcelId).toBe("402125204030");
    expect(parcel.ownerNameRaw).not.toMatch(/\s{2,}$/);
    expect(typeof parcel.assessedValue).toBe("number");
  });

  it("computes sqft from geometry since the layer has no stated area", () => {
    expect(parcel.sqft).toBeGreaterThan(1000);
    expect(parcel.sqft).toBeLessThan(1_000_000);
    expect(parcel.appraiserUrl).toContain("ccappraiser.com");
  });
});
