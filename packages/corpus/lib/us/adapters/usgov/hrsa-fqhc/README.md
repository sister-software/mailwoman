# `usgov-hrsa-fqhc` adapter

HRSA Federally Qualified Health Center site locations — public-domain,
US, the second member of Phase 1.6's "adversarial sources" class.

## Why HRSA FQHC?

HRSA's Health Center Service Delivery Site Locations dataset is the
authoritative federal directory of FQHCs and look-alikes. Compared to
gazetteer rows it warrants its adversarial-source label on two fronts:

1. **Venue + address co-occurrence**: every row has a hand-typed
   site name (e.g. "Buffalo Health Center Inc.") alongside the postal
   address. The model learns the venue token boundary against real
   facility-name surface forms — not synthesized ones.
2. **Suite + sub-tenant chaos**: HRSA grantees self-report the postal
   address in a single column with whatever suite / building / floor
   designators they choose. The training data accumulates the
   abbreviation drift + sub-tenant addressing the model has to handle
   in production.

## Input

A CSV file the operator pre-downloads from `data.hrsa.gov` (Health
Center Service Delivery Site Locations dataset). The adapter consumes
the file directly via `CSVSpliterator` in streaming mode. A SQLite step is
unnecessary because the national export is ~10K rows.

### Expected columns

| Column                    | Use                                         |
| ------------------------- | ------------------------------------------- |
| `Site ID`                 | Optional. Used in `source_id` when present. |
| `Site Name`               | The `venue` component                       |
| `Site Address`            | Split into `house_number` + `street`        |
| `Site City`               | The `locality` component                    |
| `Site State Abbreviation` | The `region` component (2-char USPS)        |
| `Site Postcode`           | The `postcode` component                    |

The adapter ignores every other column in the HRSA export.

## Output

One `CanonicalRow` per CSV record. Component insertion order is
essential — `venue` is placed first so downstream alignment claims
its surface span before `locality` does its own search. This is the
kryptonite-defending invariant: a row like
`"Buffalo Health Center Inc., 123 Main St, Buffalo, NY 14201"` would
otherwise see alignment grab the first "Buffalo" as locality and
quarantine venue.

`source_id` shape:

- `usgov-hrsa-fqhc-<Site ID>` when the CSV row has a Site ID
- `usgov-hrsa-fqhc-<content-hash>` otherwise (via `stableSourceId`)

The adapter splits `Site Address` with `splitUSStreetLine` (`lib/us/street-unit.ts`):

- `"123 Main St"` → `{ house_number: "123", street: "Main St" }`
- `"40-12 Bell Blvd"` → `{ house_number: "40-12", street: "Bell Blvd" }`
- `"PO Box 1234"` → `{ po_box: "PO Box 1234" }`

A secondary unit at the end of the line moves to `unit` through
`splitTrailingUnit` (`lib/us/street-unit.ts`), the same split the
`usgov-nppes` adapter applies:

- `"456 SE Hawthorne Blvd Suite 200"` → `{ house_number: "456", street: "SE Hawthorne Blvd", unit: "Suite 200" }`
- `"789 N Capitol Ave, Suite 102"` → `{ house_number: "789", street: "N Capitol Ave", unit: "Suite 102" }`

## Raw line shape

```
<Site Name>, <house> <street>, <city>, <state> <postcode>
```

Example:

```
Buffalo Health Center Inc., 123 Main St, Buffalo, NY 14201
```

US-conventional addressee-then-address ordering, matching how HRSA
users type into geocoders.

## Row filters

Rows are silently dropped when:

- `Site Name` is empty (no venue means no adversarial training signal).
- `Site Address` is empty.
- `Site City` is empty.
- `Site Postcode` is empty.
- `Site State Abbreviation` is not a recognized USPS abbreviation (50
  states + DC + 5 primary territories).

## License

Every emitted row has `license: "Public Domain"` per the HRSA Data
Warehouse's federal-government distribution terms.

## Country filter

`--country US` is allowed (no-op since HRSA is US-only). Any other
country value is rejected with a clear error.

## Fixture

`fixtures/usgov-hrsa-fqhc/sample.csv` — 10 hand-crafted rows covering:

- Standard urban addresses with venue prefix
- A suite at the end of the line, bare and after a comma, split into `unit`
- Saint / honorific prefixes (`"St. Vincent's Outreach Clinic"`,
  `"Saint Mary's FQHC"`)
- Quoted multi-word venues with commas
- Hyphenated NYC-style house numbers
- PO Box + rural-route shapes
- One row missing `Site Name` (silently dropped)
- One row with unrecognized state code `"ZZ"` (silently dropped)

All Site IDs are illustrative, and none match a real HRSA record.
