# `usgov-hrsa-fqhc` adapter

HRSA Federally Qualified Health Center site locations — public-domain,
US, the second member of Phase 1.6's "adversarial sources" class.

## Why HRSA FQHC?

HRSA's Health Center Service Delivery Site Locations dataset is the
authoritative federal directory of FQHCs and look-alikes. Compared to
gazetteer rows it earns its adversarial-source label on two fronts:

1. **Venue + address co-occurrence**: every row carries a hand-typed
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
the file directly via `csv-parse` in streaming mode; no SQLite step
needed (the national export is ~10K rows).

### Expected columns

| Column                    | Use                                         |
| ------------------------- | ------------------------------------------- |
| `Site ID`                 | Optional. Used in `source_id` when present. |
| `Site Name`               | → `venue` component                         |
| `Site Address`            | Split into `house_number` + `street`        |
| `Site City`               | → `locality` component                      |
| `Site State Abbreviation` | → `region` component (2-char USPS)          |
| `Site Postal Code`        | → `postcode` component                      |

Any other column the HRSA export carries is ignored.

## Output

One `CanonicalRow` per CSV record. Component insertion order is
load-bearing — `venue` is placed first so downstream alignment claims
its surface span before `locality` does its own search. This is the
kryptonite-defending invariant: a row like
`"Buffalo Health Center Inc., 123 Main St, Buffalo, NY 14201"` would
otherwise see alignment grab the first "Buffalo" as locality and
quarantine venue.

`source_id` shape:

- `usgov-hrsa-fqhc-<Site ID>` when the CSV row carries a Site ID
- `usgov-hrsa-fqhc-<content-hash>` otherwise (via `stableSourceId`)

The adapter splits `Site Address` into `(house_number, street)`:

- `"123 Main St"` → `{ house_number: "123", street: "Main St" }`
- `"40-12 Bell Blvd"` → `{ house_number: "40-12", street: "Bell Blvd" }`
- `"PO Box 1234"` → `{ street: "PO Box 1234" }` (no house number)

Suite / floor / unit designators stay on `street` (no separate `unit`
slot for Phase 1; see file-level comment in `adapter.ts`).

## Raw line shape

```
<Site Name>, <house> <street>, <city>, <state> <postcode>
```

Example:

```
Buffalo Health Center Inc., 123 Main St, Buffalo, NY 14201
```

US-conventional addressee-then-address ordering, matching how HRSA
users actually type into geocoders.

## Filtering

Rows are silently dropped when:

- `Site Name` is empty (no venue means no adversarial training signal).
- `Site Address` is empty.
- `Site City` is empty.
- `Site Postal Code` is empty.
- `Site State Abbreviation` is not a recognized USPS abbreviation (50
  states + DC + 5 primary territories).

## License

Every emitted row carries `license: "Public Domain"` per the HRSA Data
Warehouse's federal-government distribution terms.

## Country filter

`--country US` is allowed (no-op since HRSA is US-only). Any other
country value is rejected with a clear error.

## Fixture

`fixtures/usgov-hrsa-fqhc/sample.csv` — 10 hand-crafted rows covering:

- Standard urban addresses with venue prefix
- Suite designators on street
- Saint / honorific prefixes (`"St. Vincent's Outreach Clinic"`,
  `"Saint Mary's FQHC"`)
- Quoted multi-word venues with commas
- Hyphenated NYC-style house numbers
- PO Box + rural-route shapes
- One row missing `Site Name` (silently dropped)
- One row with unrecognized state code `"ZZ"` (silently dropped)

All Site IDs are illustrative; none match a real HRSA record.
