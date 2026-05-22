# `usgov-samhsa-treatment-locator` adapter

> **Status: DEFERRED (2026-05-22, issue #33).** The bulk CSV this adapter
> was written against is no longer publicly available, and the adapter
> is **not** registered in `BUILTIN_ADAPTERS` (`corpus/src/adapters/index.ts`).
> The factory, named export, fixture, and test suite remain in-tree so
> the adapter can be hand-registered the moment a compatible source
> returns. See [Source availability (deferral)](#source-availability-deferral)
> below for the investigation summary and revisit triggers.

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

## Source availability (deferral)

The README originally pointed operators at "a CSV the operator
pre-downloads from the SAMHSA Open Data Foundry." During Tier 0 corpus
expansion (2026-05-17) we could not locate the export anywhere on the
public web:

- `findtreatment.gov/locator` is an interactive SPA — no "Download all"
  control, no `exportsAsCsv` endpoint. Probing
  `findtreatment.gov/locator/exportsAsCsv` and
  `findtreatment.samhsa.gov/locator/exportsAsCsv` returns the SPA HTML
  shell, not CSV.
- `samhsa.gov/data/data-we-collect/n-sumhss-…` returns 403 on direct
  HTTP fetch (Cloudflare-class blocking); accessible interactively only
  after per-dataset EULA acceptance, and what it ships
  (N-SUMHSS PUF — facility-survey microdata) is a different shape than
  this adapter expects.
- The `catalog.data.gov` substance-abuse-locator dataset entry lists
  only the HTML locator URL, no CSV resource.
- The "Open Data Foundry" itself was deprecated; the bulk-export story
  appears to have migrated into N-SUMHSS without a venue+address
  surface form.

### Decision: defer, do not rewrite or delete

- **Defer (chosen).** Remove from `BUILTIN_ADAPTERS`; keep the
  factory, fixture, and test suite committed. The adapter does no harm
  sitting idle, and reinstating it the day a compatible CSV reappears
  is one one-line change to `corpus/src/adapters/index.ts`.
- **Rewrite against N-SUMHSS PUF (rejected).** The PUF is
  per-facility survey microdata (service mix, capacity, modalities),
  not a venue-name + two-line postal-address record. Rewriting against
  it would lose the only training signal this adapter exists to
  contribute — the `street1` / `street2` narrative sub-tenant chaos
  ("Suite C, behind main building") — and would just be a parallel,
  weaker NPPES.
- **Find via FOIA / SAMHSA dev channels (deferred, not chosen).**
  The data exists (the locator UI is backed by it); the access path is
  not in our hands on a useful timeline. Worth keeping on the
  follow-up list but not blocking on.

### Impact

Per the issue triage: SAMHSA's distinct contribution is the **two-line
address** shape. NPPES + HRSA together still cover ~95% of the
venue+address training signal SAMHSA would have added (NPPES has
two-line addresses for healthcare-provider venues; HRSA has venue +
single-line addresses). The corpus loses an adversarial-source
diversity check but no irreplaceable schema coverage.

### Revisit triggers

Re-register the adapter (re-add to `BUILTIN_ADAPTERS` in
`corpus/src/adapters/index.ts`) when **any** of the following becomes
true:

1. A new public bulk export of the Treatment Locator with the original
   column shape (`frid`, `name1`, `name2`, `street1`, `street2`, `city`,
   `state`, `zip`) is published — through SAMHSA, data.gov, or a partner
   distribution.
2. An operator obtains a compatible CSV through FOIA / partnership and
   wants to run a one-shot ingest. The CLI can still drive the adapter
   via direct factory invocation without re-registering it; registering
   is only needed for inclusion in default `corpus build` runs.
3. The schema gap left by deferral becomes evidence-backed (eval set
   shows the model failing on two-line narrative-suite addresses at a
   rate the deferral can no longer justify) — in which case the
   priority shifts to obtaining the data by any available channel.

Related: #26 (Tier A licensing — applies when source is found), epic #15.

## Input

A CSV file the operator pre-downloads from the SAMHSA Open Data
Foundry. Streamed via `csv-parse`; no SQLite step needed.

> **Source-availability caveat.** As of 2026-05-22 the Open Data Foundry
> bulk CSV is no longer publicly distributed (see
> [Source availability (deferral)](#source-availability-deferral)).
> The column contract below remains the canonical input shape an
> operator-supplied CSV must conform to.

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
