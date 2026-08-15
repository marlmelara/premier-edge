import { describe, expect, it } from "vitest";
import { parseMessageExport, parseOptOutExport } from "./sendivo-export";

describe("parseOptOutExport", () => {
  it("suppresses only the flagged rows when there's a flag column", () => {
    const csv = [
      "Phone,Name,Opted Out",
      "(239) 555-0101,Ana,true",
      "(239) 555-0102,Bob,false",
      "(239) 555-0103,Cara,yes",
    ].join("\n");
    const parsed = parseOptOutExport(csv);
    expect(parsed.mode).toBe("flag_column");
    expect(parsed.rows.map((r) => r.phone)).toEqual(["2395550101", "2395550103"]);
  });

  it("treats a file with no flag column as an opt-out list", () => {
    const parsed = parseOptOutExport("Phone\n(239) 555-0101\n(239) 555-0102");
    expect(parsed.mode).toBe("every_row");
    expect(parsed.rows).toHaveLength(2);
  });

  it("keeps the opt-out date when the export has one", () => {
    const parsed = parseOptOutExport("Phone,Date\n2395550101,2026-07-14T10:00:00Z");
    expect(parsed.rows[0].optedOutAt?.toISOString()).toBe("2026-07-14T10:00:00.000Z");
  });

  it("ignores an unparseable date rather than inventing one", () => {
    const parsed = parseOptOutExport("Phone,Date\n2395550101,n/a");
    expect(parsed.rows[0].optedOutAt).toBeUndefined();
  });

  it("counts rows with no usable phone instead of dropping them silently", () => {
    expect(parseOptOutExport("Phone\n2395550101\nnot-a-number").skipped).toBe(1);
  });
});

describe("parseMessageExport", () => {
  const csv = [
    "Phone,Name,Direction,Message,Date",
    '(239) 555-0101,Ana Ruiz,inbound,"We will sell it for $19,000",2026-08-01T14:00:00Z',
    "(239) 555-0101,Ana Ruiz,outbound,Thanks — checking with our buyer,2026-08-01T15:00:00Z",
  ].join("\n");

  it("reads direction, body and timestamp", () => {
    const parsed = parseMessageExport(csv);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      phone: "2395550101",
      direction: "inbound",
      body: "We will sell it for $19,000",
      name: "Ana Ruiz",
    });
    expect(parsed.rows[1].direction).toBe("outbound");
  });

  it("accepts the different words exports use for direction", () => {
    const rows = parseMessageExport(
      ["Phone,Direction,Message", "2395550101,Received,hi", "2395550101,Sent,hello"].join("\n"),
    ).rows;
    expect(rows.map((r) => r.direction)).toEqual(["inbound", "outbound"]);
  });

  it("skips a row whose direction it cannot read rather than guessing", () => {
    // Guessing here would file our own message as something the seller said,
    // and the agent would negotiate against it.
    const parsed = parseMessageExport(["Phone,Direction,Message", "2395550101,???,we can do 15"].join("\n"));
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.skipped).toBe(1);
  });

  it("skips rows missing a body", () => {
    expect(parseMessageExport(["Phone,Direction,Message", "2395550101,inbound,"].join("\n")).skipped).toBe(1);
  });
});
