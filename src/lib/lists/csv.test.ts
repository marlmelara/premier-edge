import { describe, expect, it } from "vitest";
import { mapHeaders, normalizeListPhone, parseCsv, parseList } from "./csv";
import { normalizePhone } from "@/lib/sendivo/webhook-schema";

describe("parseCsv", () => {
  it("handles quoted fields containing commas — every land list has them", () => {
    // parseCsv is the raw reader — it splits cells, it does not normalize them.
    const rows = parseCsv('phone,address\n2395550101,"1234 SW 5th Ave, Cape Coral, FL"');
    expect(rows[1]).toEqual(["2395550101", "1234 SW 5th Ave, Cape Coral, FL"]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('a\n"say ""hi"""')[1]).toEqual(['say "hi"']);
  });

  it("survives CRLF and a spreadsheet BOM", () => {
    const rows = parseCsv('﻿phone,name\r\n2395550101,Ana\r\n');
    expect(rows[0]).toEqual(["phone", "name"]);
    expect(rows[1]).toEqual(["2395550101", "Ana"]);
  });

  it("does not invent a row from a trailing newline", () => {
    expect(parseCsv("a,b\n1,2\n")).toHaveLength(2);
  });

  it("keeps empty cells rather than shifting columns", () => {
    expect(parseCsv("a,b,c\n1,,3")[1]).toEqual(["1", "", "3"]);
  });
});

describe("mapHeaders", () => {
  it("recognizes the common provider spellings", () => {
    const { map } = mapHeaders(["Owner Name", "Phone Number", "Situs Address", "APN"]);
    expect(map.name).toBe(0);
    expect(map.phone).toBe(1);
    expect(map.propertyAddress).toBe(2);
    expect(map.parcelId).toBe(3);
  });

  it("gives 'Property City' to the property, not the mailing address", () => {
    const { map } = mapHeaders(["Phone", "Property City", "Mailing City"]);
    expect(map.propertyCity).toBe(1);
    expect(map.mailingCity).toBe(2);
  });

  it("never hands one column to two fields", () => {
    const { map } = mapHeaders(["Phone", "Property Address", "Mailing Address"]);
    expect(map.propertyAddress).toBe(1);
    expect(map.mailingAddress).toBe(2);
  });

  it("reports columns it did not recognize instead of dropping them silently", () => {
    const { unmapped } = mapHeaders(["Phone", "Equity Percent", "Last Sale Date"]);
    expect(unmapped).toEqual(["Equity Percent", "Last Sale Date"]);
  });
});

describe("normalizeListPhone", () => {
  it("accepts the formats a list actually contains", () => {
    expect(normalizeListPhone("(239) 555-0101")).toBe("+12395550101");
    expect(normalizeListPhone("+1 239 555 0101")).toBe("+12395550101");
    expect(normalizeListPhone("+12395550101")).toBe("+12395550101");
  });

  it("rejects anything that isn't a US number", () => {
    expect(normalizeListPhone("555-0101")).toBeNull();
    expect(normalizeListPhone("")).toBeNull();
    expect(normalizeListPhone("n/a")).toBeNull();
  });

  it("agrees exactly with the inbound normalizer", () => {
    // contacts.phone is unique and opt_outs is keyed by phone. If these two
    // ever disagree, one seller becomes two rows and a STOP recorded by SMS
    // stops suppressing the list import — the compliance failure, not a typo.
    for (const raw of ["(239) 555-0101", "239-555-0101", "+1 239 555 0101", "12395550101", "2395550101"]) {
      expect(normalizeListPhone(raw)).toBe(normalizePhone(raw));
    }
  });
});

describe("parseList", () => {
  const csv = [
    "Owner Name,Phone,Property Address,Property City,APN,Equity",
    'Ana Ruiz,(239) 555-0101,"1234 SW 5th Ave",Cape Coral,354426L3121060010,80%',
    "No Phone Guy,,999 Nowhere Rd,Cape Coral,123,10%",
  ].join("\n");

  it("maps a row and keeps the untouched original", () => {
    const parsed = parseList(csv);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      phone: "+12395550101",
      name: "Ana Ruiz",
      propertyAddress: "1234 SW 5th Ave",
      parcelId: "354426L3121060010",
    });
    // Columns we don't model still survive the import.
    expect(parsed.rows[0].raw.Equity).toBe("80%");
  });

  it("drops rows with no usable phone and says how many", () => {
    expect(parseList(csv).skipped).toBe(1);
  });

  it("builds a name from first + last when there's no full-name column", () => {
    const parsed = parseList("First Name,Last Name,Phone\nAna,Ruiz,2395550101");
    expect(parsed.rows[0].name).toBe("Ana Ruiz");
  });
});
