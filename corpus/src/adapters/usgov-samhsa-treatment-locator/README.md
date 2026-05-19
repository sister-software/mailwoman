# `usgov-samhsa-treatment-locator` adapter

SAMHSA Behavioral Health Treatment Services Locator — public-domain,
US, the third member of Phase 1.6's "adversarial sources" class.

## Why SAMHSA?

SAMHSA's `findtreatment.gov` directory is the federal index of
substance-use and mental-health treatment facilities. Adversarial-source
value matches HRSA on the venue + address co-occurrence dimension and
adds a distinctive feature: **two-line addresses**. The `street1` /
`street2` split is the SAMHSA-specific training signal:

- `street1` carries the canonical postal address (`"123 Main St"`).
- `street2` carries the suite / floor / sub-tenant designator
  (`"Suite C, behind main building"`, `"2nd Floor"`, `"Adjacent to
pharmacy"`).

The adapter joins them with `", "` into a single `street` component so
the model sees the natural envelope-style surface form humans type into
geocoders.

## Input

A CSV file the operator pre-downloads from the SAMHSA Open Data
Foundry. Streamed via `csv-parse`; no SQLite step needed.

### Expected columns

| Column    | Use                                                                  |
| --------- | -------------------------------------------------------------------- |
| `frid`    | Optional. Used in `source_id` when present.                          |
| `name1`   | Primary facility / program name → `venue`                            |
| `name2`   | Optional parent / organizational name → joined onto `venue` with `-` |
| `street1` | Primary street line                                                  |
| `street2` | Optional secondary line (suite, floor, narrative)                    |
| `city`    | → `locality`                                                         |
| `state`   | → `region` (2-char USPS)                                             |
| `zip`     | → `postcode`                                                         |

Any other column SAMHSA's export carries is ignored.

## Output

One `CanonicalRow` per CSV record. Component insertion order is
load-bearing — `venue` first, same kryptonite-defending invariant as
HRSA: `"Buffalo Treatment Services, …, Buffalo, NY"` would otherwise
mis-label venue's "Buffalo" as locality.

`source_id` shape:

- `usgov-samhsa-treatment-locator-<frid>` when the CSV row carries a frid
- `usgov-samhsa-treatment-locator-<content-hash>` otherwise (via `stableSourceId`)

The adapter:

1. Composes `venue` from `name1` (+ `-` + `name2` when both present).
   When `name1` is empty but `name2` is present, the parent name is
   used as the venue surface form.
2. Joins `street1` + `street2` with `", "` into a single street surface
   form (Phase 1 keeps `unit` as a deferred slot).
3. Splits the joined street into `(house_number, street)` using the
   same regex shape as HRSA / FCC BDC.

## Raw line shape

```
<venue>, <house> <street>, <city>, <state> <postcode>
```

Examples:

```
Cascade Recovery Center, 500 SW Madison St, Suite 300, Portland, OR 97201
Mountain Plains Counseling Services - Catholic Charities of Wyoming, 1500 Capitol Ave, 2nd Floor, Cheyenne, WY 82001
Buffalo Treatment Services, 200 Elmwood Ave, Suite C, behind main building, Buffalo, NY 14222
```

## Filtering

Rows are silently dropped when:

- Both `name1` and `name2` are empty (no venue surface form).
- `street1` (and `street2`) are both empty.
- `city` is empty.
- `zip` is empty.
- `state` is not a recognized USPS abbreviation (50 states + DC + 5
  primary territories).

## License

Every emitted row carries `license: "Public Domain"` per the SAMHSA
Open Data Foundry's federal-government distribution terms.

## Country filter

`--country US` is allowed (no-op since SAMHSA is US-only). Any other
country value is rejected with a clear error.

## Fixture

`fixtures/usgov-samhsa-treatment-locator/sample.csv` — 9 hand-crafted
rows covering:

- Standard urban + suite-bearing addresses
- Parent organization on `name2` (joined onto venue)
- Narrative sub-tenant designators (`"Suite C, behind main building"`)
- Hyphenated NYC-style house numbers
- Saint / honorific prefixes
- Rural-route + PO Box shapes
- One row with empty `name1` but populated `name2` (parent-only venue)
- One row with unrecognized state code `"ZZ"` (silently dropped)

All `frid` values are illustrative; none match a real SAMHSA record.
