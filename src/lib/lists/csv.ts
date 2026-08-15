/**
 * Blast-list CSV parsing (design doc §11d, Aug 14 2026 amendment).
 *
 * Sendivo's API has no endpoint that lists or pages contacts — `/contacts`
 * requires a phone number — so the list can't be pulled back out of it. The
 * source of truth is the same CSV Marlon uploads there, and this reads it
 * directly.
 *
 * List providers (DataTree, PropStream, ListSource, raw county exports) all
 * name their columns differently, so headers are matched by alias rather than
 * position. Pure functions — no I/O.
 */

/** RFC 4180: quoted fields, "" escapes, CRLF, and a BOM if Excel touched it. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  if (text.charCodeAt(0) === 0xfeff) i = 1;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    // A trailing newline shouldn't produce a phantom row.
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      endField();
      i += 1;
      continue;
    }
    if (c === "\r") {
      i += 1;
      continue;
    }
    if (c === "\n") {
      endRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** What we need out of a row. Everything but the phone is optional. */
export type ListField =
  | "phone"
  | "altPhone"
  | "name"
  | "firstName"
  | "lastName"
  | "email"
  | "propertyAddress"
  | "propertyCity"
  | "propertyState"
  | "propertyZip"
  | "mailingAddress"
  | "mailingCity"
  | "mailingState"
  | "mailingZip"
  | "county"
  | "parcelId";

/**
 * Header aliases, longest-first within each field so "property city" wins over
 * a bare "city". Compared after stripping everything but letters and digits.
 */
const ALIASES: Record<ListField, string[]> = {
  phone: ["phone", "phonenumber", "primaryphone", "mobile", "mobilenumber", "cell", "cellphone", "wireless", "phone1"],
  altPhone: ["phone2", "phone3", "altphone", "alternatephone", "secondaryphone", "otherphone"],
  name: ["ownername", "owner", "fullname", "name", "owner1", "ownerfullname"],
  firstName: ["firstname", "ownerfirstname", "first"],
  lastName: ["lastname", "ownerlastname", "last"],
  email: ["email", "emailaddress", "owneremail"],
  propertyAddress: [
    "propertyaddress",
    "situsaddress",
    "siteaddress",
    "propertystreet",
    "situsstreet",
    "propertyaddress1",
    "situs",
    "propertyfulladdress",
    "address",
    "streetaddress",
  ],
  propertyCity: ["propertycity", "situscity", "sitecity", "city"],
  propertyState: ["propertystate", "situsstate", "sitestate", "state"],
  propertyZip: ["propertyzip", "situszip", "sitezip", "propertyzipcode", "zip", "zipcode", "postalcode"],
  mailingAddress: ["mailingaddress", "owneraddress", "mailaddress", "mailingstreet", "mailingaddress1"],
  mailingCity: ["mailingcity", "ownercity", "mailcity"],
  mailingState: ["mailingstate", "ownerstate", "mailstate"],
  mailingZip: ["mailingzip", "ownerzip", "mailzip", "mailingzipcode"],
  county: ["county", "countyname", "propertycounty"],
  parcelId: ["apn", "parcelid", "parcelnumber", "parcelno", "strap", "account", "accountnumber", "folio", "pin", "parcel"],
};

const key = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, "");

export type HeaderMap = Partial<Record<ListField, number>>;

/**
 * Match headers to fields. A column is claimed by the field whose alias matches
 * it most specifically, so a sheet with both "property city" and "mailing city"
 * doesn't hand the same column to two fields.
 */
export function mapHeaders(headers: string[]): { map: HeaderMap; unmapped: string[] } {
  const normalized = headers.map(key);
  const map: HeaderMap = {};
  const claimed = new Set<number>();

  // Specific aliases first: "propertycity" must be taken before plain "city"
  // is offered to propertyCity as a fallback.
  const candidates: { field: ListField; alias: string }[] = [];
  for (const [field, aliases] of Object.entries(ALIASES) as [ListField, string[]][]) {
    for (const alias of aliases) candidates.push({ field, alias });
  }
  candidates.sort((a, b) => b.alias.length - a.alias.length);

  for (const { field, alias } of candidates) {
    if (map[field] !== undefined) continue;
    const index = normalized.findIndex((h, i) => !claimed.has(i) && h === alias);
    if (index >= 0) {
      map[field] = index;
      claimed.add(index);
    }
  }

  return {
    map,
    unmapped: headers.filter((_, i) => !claimed.has(i)).filter((h) => h.trim() !== ""),
  };
}

export type ListRow = {
  phone: string;
  name?: string;
  email?: string;
  altPhones?: string[];
  propertyAddress?: string;
  propertyCity?: string;
  propertyState?: string;
  propertyZip?: string;
  mailingStreet?: string;
  mailingCity?: string;
  mailingState?: string;
  mailingZip?: string;
  county?: string;
  parcelId?: string;
  /** The whole original row, keyed by header — kept so nothing is lost on import. */
  raw: Record<string, string>;
};

export type ParsedList = {
  rows: ListRow[];
  headerMap: HeaderMap;
  /** Columns we didn't recognize. Surfaced so a missed mapping is visible, not silent. */
  unmapped: string[];
  /** Rows dropped because they had no usable phone number. */
  skipped: number;
};

/**
 * Phone normalization for list rows.
 *
 * Must produce the SAME shape as `normalizePhone` in webhook-schema — E.164,
 * `+1XXXXXXXXXX`. `contacts.phone` is unique and `opt_outs` is keyed by phone,
 * so a list that stored bare 10-digit numbers would create a second contact row
 * for a seller we already know, and — much worse — would miss the opt-out they
 * recorded by texting STOP.
 *
 * Returns null rather than a guess for anything that isn't a US number, so the
 * caller can count and report the rows it skipped.
 */
export function normalizeListPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return null;
}

export function parseList(text: string): ParsedList {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], headerMap: {}, unmapped: [], skipped: 0 };

  const headers = table[0].map((h) => h.trim());
  const { map, unmapped } = mapHeaders(headers);
  const rows: ListRow[] = [];
  let skipped = 0;

  const at = (cells: string[], field: ListField): string | undefined => {
    const index = map[field];
    if (index === undefined) return undefined;
    const value = cells[index]?.trim();
    return value ? value : undefined;
  };

  for (const cells of table.slice(1)) {
    const rawPhone = at(cells, "phone");
    const phone = rawPhone ? normalizeListPhone(rawPhone) : null;
    if (!phone) {
      skipped += 1;
      continue;
    }

    const name =
      at(cells, "name") ?? ([at(cells, "firstName"), at(cells, "lastName")].filter(Boolean).join(" ") || undefined);

    const alt = at(cells, "altPhone");
    const altNormalized = alt ? normalizeListPhone(alt) : null;

    const raw: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h && cells[i]) raw[h] = cells[i].trim();
    });

    rows.push({
      phone,
      name,
      email: at(cells, "email"),
      altPhones: altNormalized ? [altNormalized] : undefined,
      propertyAddress: at(cells, "propertyAddress"),
      propertyCity: at(cells, "propertyCity"),
      propertyState: at(cells, "propertyState"),
      propertyZip: at(cells, "propertyZip"),
      mailingStreet: at(cells, "mailingAddress"),
      mailingCity: at(cells, "mailingCity"),
      mailingState: at(cells, "mailingState"),
      mailingZip: at(cells, "mailingZip"),
      county: at(cells, "county"),
      parcelId: at(cells, "parcelId"),
      raw,
    });
  }

  return { rows, headerMap: map, unmapped, skipped };
}
