# `fcc-bdc` adapter

FCC Broadband Data Collection — Fabric-derived BSL address consumer. The
first member of Phase 1.6's "adversarial sources" class.

## Why BDC?

The Mailwoman corpus is dominated by gazetteer rows (WOF, BAN) and
TIGER street-name segments — clean, canonicalized data. A model trained
exclusively on that distribution learns to parse _well-formed_ addresses
but stumbles on the chaos humans actually send geocoders.

The FCC's Broadband Data Collection program publishes the Broadband
Serviceable Location (BSL) Fabric — ~120M US addresses with their
NTIA-conformant fields. Compared to the WOF / TIGER / BAN baseline:

- **Address chaos**: rural routes (`RR 2 Box 67`), highway contracts
  (`HC 1 Box 5`), military PSC numbering, mailing-only PO boxes,
  hand-entered apartment numbering that drifted from postal canon. Every
  major US edge case appears at scale.
- **Volume**: roughly an order of magnitude more US rows than TIGER's
  ADDRFEAT segment file. Per-state granularity if filtering is needed.
- **Provenance**: federal, public-domain, weekly-refreshed.

## Input

A SQLite database the operator pre-builds from the BDC distribution.
The mailwoman side does **not** download the raw FCC ZIPs or parse the
CSVs — that path lives in the upstream `isp-nexus` BDC ETL
(`/srv/isp-nexus/sync/fcc/bdc/`) and produces the SQLite this adapter
consumes. Operators not running isp-nexus can substitute any pipeline
that lands a `bdc_locations` table with the schema below.

### Expected schema

```sql
CREATE TABLE bdc_locations (
  location_id    INTEGER PRIMARY KEY,   -- Stable BSL fabric ID (persistent across vintages)
  address_primary TEXT NOT NULL,        -- "123 Main St" — postal address sans city/state/zip
  city           TEXT NOT NULL,         -- "Portland"
  state          TEXT NOT NULL,         -- 2-char USPS abbreviation, e.g. "OR"
  zip            TEXT NOT NULL,         -- 5-digit ZIP
  zip_suffix     TEXT                   -- Optional 4-digit ZIP+4 extension, or already-joined "94103-1234"
);
```

Column names mirror the upstream `NTIARecord` type
(`isp-nexus/fcc/bdc/data-collection.ts`) so a CSV `.import` from the
raw NTIA distribution lands in the right shape without per-column
renames. The optional `zip_suffix` column tolerates two surface forms:

- bare 4-digit extension (`"1234"`) — joined with `zip` to `"<zip>-1234"`
- already-joined ZIP+4 (`"94103-1234"`) — used as-is

Empty / whitespace-only suffix is treated as missing.

## Output

One `CanonicalRow` per `bdc_locations` row. Unlike `tiger` (multiple
postcode variants per segment) or `wof-admin` (multiple hierarchy
variants per place), BDC records already represent fully specified
addresses, so no adapter-level fan-out is performed. Variant generation
for the adversarial training cases happens in `synthesize.ts`'s
compositional synthesis primitive (Phase 1.6 §2.1), not here.

`source_id` shape: `fcc-bdc-<location_id>`.

The adapter splits `address_primary` into `(house_number, street)`:

- `"123 Main St"` → `{ house_number: "123", street: "Main St" }`
- `"6450 W Indian School Rd"` → `{ house_number: "6450", street: "W Indian School Rd" }`
- `"101A Main St"` → `{ house_number: "101A", street: "Main St" }` (one trailing letter tolerated)
- `"40-12 Bell Blvd"` → `{ house_number: "40-12", street: "Bell Blvd" }` (NYC garden-apartment shape)
- `"PO Box 1234"` → `{ street: "PO Box 1234" }` (no house number — falls back to street-only)
- `"RR 2 Box 67"` → `{ street: "RR 2 Box 67" }` (no leading digit — preserved verbatim)

The "no leading digit" branch preserves the original surface form
verbatim, deferring rural-route / PO-box specific handling to
downstream classifiers and the Phase 1.6 §2.1 synthesis primitive.

## Filtering

Rows are dropped (silently) when:

- `state` is not a recognized USPS 2-letter abbreviation (50 states + DC
  - the five primary territories).
- `city` is empty.
- `zip` is empty.
- `address_primary` is empty.
- `address-formatter` returns an empty `raw` (extremely rare; only on
  degenerate component dicts).
- After `reconcileComponents`, no component value survives in `raw`
  (alignment-pre-flight check, mirrors the other adapters).

The "unrecognized state" case is the most interesting one — it covers
the BDC fixture's `"ZZ"` row and the real-world cases of partial / draft
fabric entries that should not become training rows.

## License

Every emitted row carries `license: "Public Domain"` per the FCC's
federal-government distribution terms for the BDC fabric. The CostQuest
Fabric upstream has its own commercial license; operators substituting
that path should re-stamp `defaultLicense` accordingly.

## Country filter

`--country US` is allowed (no-op since BDC is US-only). Any other
country value is rejected with a clear error.

## Salvage origin

Adapter scaffolding patterned after `tiger` (the closest SQLite-fed
analog). Address shape + column names salvaged from the `NTIARecord`
interface in `/srv/isp-nexus/fcc/bdc/data-collection.ts`. The
upstream isp-nexus BDC ingestion (`/srv/isp-nexus/sync/fcc/bdc/`)
remains the canonical pre-build pipeline for the `bdc_locations` table.

## Fixture

`fixtures/fcc-bdc/fixture.sql` — 12 hand-crafted BSL rows covering:

- Standard urban addresses (with + without ZIP+4)
- Already-joined ZIP+4 surface form in the suffix column
- House numbers with trailing letters
- Hyphenated house numbers
- Directional prefixes
- PO Box + rural-route shapes
- A territory (Puerto Rico)
- One unrecognized state code (`"ZZ"`) — silently dropped

All location_ids are illustrative; none match a real BSL fabric record.
