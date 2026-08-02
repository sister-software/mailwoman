# WOF Granularity Scorecard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `mailwoman gazetteer granularity` — a per-country depth ladder over the admin gazetteer that answers "where does the gazetteer bottom out?" for all 244 countries, plus the projection-table extension it depends on.

**Architecture:** Two increments. **PR A** extends `PLACETYPE_PROJECTION` from 25 to all 34 WOF placetypes and adds a completeness test, because an unmapped placetype makes the census build throw and nothing can deepen the gazetteer until that is closed. **PR B** adds a pure builder module (`gazetteer-pipeline/granularity.ts`) that reads the shipped admin DB and emits per-(country × rung) node counts and parent-coverage shares, a markdown renderer, and the Pastel command that wires them together. The builder is read-only SQL over `spr`/`ancestors` — no network, no model, same shape as `buildPlacetypeCensus`.

**Tech Stack:** TypeScript running directly under `node` (type stripping, explicit `.ts` import extensions), `node:sqlite` via `DatabaseSync`, vitest 4.1.10, Pastel/Ink command components via `mailwoman/cli-kit`.

## Scope

This plan covers **PR A and PR B only** from the spec's four-PR split
(`docs/superpowers/specs/2026-08-02-wof-granularity-scorecard-design.md`). PR B delivers the answer
to the originating question on its own and is independently shippable.

PR C (gap attribution + name match) and PR D (pair yield + manifest emission) get their own plan
after B's numbers land, for two reasons recorded in the spec: C's source-gap leg is gated on Open
Question 1 (whether the cloned `whosonfirst-data*` repos are available anywhere — `wof/global` is
empty), and the 5% parent-coverage floor wants a second calibration point, which B produces.

## Global Constraints

- **No `enum`, no constructor parameter properties, no runtime namespaces** — `erasableSyntaxOnly: true` is enforced repo-wide. Use `const X = {…} as const` plus `type X = (typeof X)[keyof typeof X]`.
- **Relative imports carry explicit `.ts` extensions.** Source runs directly under `node`.
- **Acronyms capitalize as whole camelCase components** — `parseJSON`, `readID`, `WOFPlacetype`. Not `parseJson` / `readId`. Does not apply to `snake_case` DB columns.
- **Data-root paths go through `@mailwoman/core/utils`** — `dataRootPath("wof", "admin-global-priority.db")`. Never hardcode `/mnt/playpen/mailwoman-data`; reference `$MAILWOMAN_DATA_ROOT` in prose and help text.
- **Databases are read-only artifacts.** This plan only ever opens the admin DB with `{ readOnly: true }`.
- **The meaning-of-zero rule is structural.** A measured-and-empty rung is a present row with a zero count; a never-measured rung is an absent row. These must never collapse into the same representation.
- **Positive evidence only.** Nothing in this plan gates, masks, or forbids anything at decode time. It measures and reports.
- Every new file carries the standard header: `@copyright Sister Software`, `@license AGPL-3.0`, `@author Teffen Ellis, et al.`, followed by a prose docstring explaining why the file exists.

---

# PR A — extend the projection table

### Task 1: Map all 34 WOF placetypes

**Files:**
- Modify: `mailwoman/gazetteer-pipeline/placetype-census.ts:41-72` (the `PLACETYPE_PROJECTION` map)
- Test: `mailwoman/gazetteer-pipeline/placetype-census.test.ts:62-76` (the `PLACETYPE_PROJECTION` describe block)

**Interfaces:**
- Consumes: `ComponentTag` from `@mailwoman/core/types` — the 26-member union in `core/types/component.ts:30-61`. There is **no** `intersection` tag; the union carries `intersection_a` and `intersection_b`.
- Produces: `WOF_PLACETYPES` (a `readonly string[]` of all 34), and a `PLACETYPE_PROJECTION` whose key set equals it. PR B's `placetypesForRung()` reads both.

**Context the implementer needs.** `PLACETYPE_PROJECTION` is the executable copy of the projection
table in `docs/articles/plan/reference/placetype-evidence.mdx`. A `null` value means "in the
vocabulary, deliberately NOT projected" — distinct from a placetype missing from the map entirely,
which `buildPlacetypeCensus` reports in `unmappedPlacetypes` and the `census` command turns into a
throw (`mailwoman/commands/gazetteer/census.tsx:78-83`). Today the map has 25 keys against a
34-placetype vocabulary, so deepening the gazetteer past the current 9-placetype ingest allowlist
would break `mailwoman gazetteer census`.

**Two projection decisions this task makes, both needing reviewer attention.** The prose table says
`intersection`, `address` → "`intersection`; house_number/street grounding". Neither can be a single
`ComponentTag`: an intersection is a two-span construct (`intersection_a` + `intersection_b`) and a
WOF `address` is a whole address record, not a span role. Both therefore map to `null` — measured and
deliberately uncounted — with comments saying why. Do not invent a tag for either.

- [ ] **Step 1: Write the failing completeness test**

Replace the whole `describe("PLACETYPE_PROJECTION", …)` block at `placetype-census.test.ts:62-76`.
Note the third test: the old file asserted `expect("wing" in PLACETYPE_PROJECTION).toBe(false)`,
which this task deliberately makes false, so it is replaced with a placetype that is genuinely not in
the WOF vocabulary.

```typescript
describe("PLACETYPE_PROJECTION", () => {
	it("projects the dependent-locality family onto one tag", () => {
		for (const placetype of ["borough", "neighbourhood", "macrohood", "microhood"]) {
			expect(PLACETYPE_PROJECTION[placetype]).toBe("dependent_locality")
		}
	})

	it("covers every placetype in the WOF vocabulary", () => {
		const unmapped = WOF_PLACETYPES.filter((placetype) => !(placetype in PLACETYPE_PROJECTION))

		expect(unmapped).toEqual([])
	})

	it("maps nothing outside the WOF vocabulary", () => {
		const vocabulary = new Set<string>(WOF_PLACETYPES)
		const extra = Object.keys(PLACETYPE_PROJECTION).filter((placetype) => !vocabulary.has(placetype))

		expect(extra).toEqual([])
	})

	it("distinguishes a deliberately-uncounted placetype from an unmapped one", () => {
		// Present with a null value: in the vocabulary, not projected.
		expect("metroarea" in PLACETYPE_PROJECTION).toBe(true)
		expect(PLACETYPE_PROJECTION.metroarea).toBeNull()
		// Absent entirely: the builder must report it rather than count it.
		expect("not_a_wof_placetype" in PLACETYPE_PROJECTION).toBe(false)
	})

	it("projects the sub-venue structures onto venue and unit rather than dropping them", () => {
		expect(PLACETYPE_PROJECTION.building).toBe("venue")
		expect(PLACETYPE_PROJECTION.campus).toBe("venue")
		expect(PLACETYPE_PROJECTION.wing).toBe("unit")
		expect(PLACETYPE_PROJECTION.concourse).toBe("unit")
	})

	it("leaves the multi-span and record placetypes deliberately unprojected", () => {
		// `intersection` is a two-span construct (intersection_a + intersection_b) — no single tag fits.
		expect(PLACETYPE_PROJECTION.intersection).toBeNull()
		// A WOF `address` is a whole address record, not a span role.
		expect(PLACETYPE_PROJECTION.address).toBeNull()
	})
})
```

Update the import at `placetype-census.test.ts:15` to pull the new constant:

```typescript
import { PLACETYPE_PROJECTION, WOF_PLACETYPES, buildPlacetypeCensus, toBaseRates } from "./placetype-census.ts"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest --run mailwoman/gazetteer-pipeline/placetype-census.test.ts`
Expected: FAIL. The import of `WOF_PLACETYPES` does not resolve, so the whole file errors before any
assertion runs.

- [ ] **Step 3: Add the vocabulary constant**

Insert immediately above `PLACETYPE_PROJECTION` in `mailwoman/gazetteer-pipeline/placetype-census.ts`:

```typescript
/**
 * The complete Who's on First placetype vocabulary (34 as of 2026-08-02). {@link PLACETYPE_PROJECTION} must carry a key
 * for every entry — a test asserts it — so a placetype can never reach `buildPlacetypeCensus` unmapped and turn a build
 * into a throw at the worst moment. Sorted to keep the diff readable when WOF grows the vocabulary.
 */
export const WOF_PLACETYPES: readonly string[] = [
	"address",
	"arcade",
	"borough",
	"building",
	"campus",
	"concourse",
	"continent",
	"country",
	"county",
	"dependency",
	"disputed",
	"empire",
	"enclosure",
	"installation",
	"intersection",
	"localadmin",
	"locality",
	"macrocounty",
	"macrohood",
	"macroregion",
	"marinearea",
	"marketarea",
	"metroarea",
	"microhood",
	"nation",
	"neighbourhood",
	"ocean",
	"planet",
	"postalcode",
	"postalregion",
	"region",
	"timezone",
	"venue",
	"wing",
]
```

- [ ] **Step 4: Add the nine missing projections**

In `PLACETYPE_PROJECTION`, immediately after the `venue: "venue",` line, insert:

```typescript
	// Venue sub-structure. A WOF `building`/`campus` place carries a venue NAME ("Empire State Building", "MIT
	// Campus"); the interior subdivisions carry a unit designator ("Concourse B", "Terminal 4", "West Wing"). The
	// admin build stocks none of these today — that is the ingest allowlist, not the source, and measuring the
	// difference is what the granularity scorecard exists for.
	building: "venue",
	campus: "venue",
	arcade: "unit",
	concourse: "unit",
	enclosure: "unit",
	installation: "unit",
	wing: "unit",
```

Then, in the context-only block after `planet: null,`, insert:

```typescript
	// Multi-span and record placetypes: in the vocabulary, structurally unprojectable onto ONE tag.
	// An intersection is a two-span construct (`intersection_a` + `intersection_b`); a WOF `address` is a whole
	// address record consumed by the kind-classifier and the resolver's address-point tiers, not a span role.
	intersection: null,
	address: null,
```

- [ ] **Step 5: Update the module docstring**

The header at `placetype-census.ts:12-17` says the projection table "also names
macrohood/microhood/venue/building rows that this source does not stock." Replace that sentence with:

```
 *   The census counts what the source can actually answer. `admin-global-priority.db` carries nine
 *   placetypes (locality, localadmin, neighbourhood, borough, county, macrocounty, region,
 *   macroregion, country) because `ADMIN_PLACETYPES` in `admin/ingest-wof.ts` allowlists exactly
 *   those; the projection table maps all 34 in the WOF vocabulary. The other 25 are absent from the
 *   artifact by BUILD RECIPE, not by WOF's contents — which is COVERAGE, not fact (the
 *   meaning-of-zero rule), and why the artifact ships positive counts only and the reader treats a
 *   missing node as neutral. `mailwoman gazetteer granularity` measures the difference.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `yarn vitest --run mailwoman/gazetteer-pipeline/placetype-census.test.ts`
Expected: PASS, all describe blocks. The three `buildPlacetypeCensus` tests and both `toBaseRates`
tests must still pass unchanged — the fixture DB carries only `metroarea` as a non-counting
placetype, and that projection is untouched.

- [ ] **Step 7: Verify nothing else asserted on the old key set**

Run: `rg -n "PLACETYPE_PROJECTION" --iglob '!**/out/**'`
Expected: hits only in `placetype-census.ts`, `placetype-census.test.ts`,
`docs/articles/plan/reference/placetype-evidence.mdx`, and the spec. If any other file branches on
the map's key set, read it before continuing.

- [ ] **Step 8: Update the reference doc**

In `docs/articles/plan/reference/placetype-evidence.mdx`, in the projection table's row for
`building, campus, wing, concourse, arcade, enclosure, installation`, change the "Projects onto"
cell from `venue / unit sub-structure` to `` `venue` (building, campus) / `unit` (the interior
subdivisions) ``. In the `intersection, address` row, change the "Projects onto" cell to
`— (structurally multi-span; deliberately null)` and extend the "Evidence use" cell with: `Neither
projects onto a single tag — an intersection is intersection_a + intersection_b, and an address is a
whole record. Both are null in PLACETYPE_PROJECTION.`

- [ ] **Step 9: Commit**

```bash
git add mailwoman/gazetteer-pipeline/placetype-census.ts \
        mailwoman/gazetteer-pipeline/placetype-census.test.ts \
        docs/articles/plan/reference/placetype-evidence.mdx
git commit -m "fix(gazetteer): map all 34 WOF placetypes in PLACETYPE_PROJECTION

The map carried 25 keys against a 34-placetype vocabulary, and the nine
missing ones were exactly the deep-end rungs (address, arcade, building,
campus, concourse, enclosure, installation, intersection, wing). An unmapped
placetype makes buildPlacetypeCensus report it and the census command throw
by design, so anything that deepened the gazetteer past the 9-placetype
ingest allowlist would have broken the census build.

building/campus project onto venue; the interior subdivisions onto unit.
intersection and address are null: an intersection is a two-span construct
(intersection_a + intersection_b) and a WOF address is a whole record, so
neither maps onto one tag. A completeness test now pins the key set to the
vocabulary in both directions."
```

---

# PR B — the depth ladder

### Task 2: The rung ladder

**Files:**
- Create: `mailwoman/gazetteer-pipeline/granularity.ts`
- Create: `mailwoman/gazetteer-pipeline/granularity.test.ts`

**Interfaces:**
- Consumes: `PLACETYPE_PROJECTION`, `WOF_PLACETYPES` from `./placetype-census.ts` (Task 1).
- Produces:
  - `LADDER: readonly ComponentTag[]` — the ordered containment rungs, shallowest first.
  - `placetypesForRung(rung: ComponentTag): string[]` — WOF placetypes projecting onto that rung, sorted.
  - `SUB_LOCALITY_RUNGS: ReadonlySet<ComponentTag>` — rungs measured by parent-coverage rather than presence.

  Tasks 3-5 consume all three.

**Context the implementer needs.** The ladder is an ordered list because "bottoms out at" needs an
ordering, but rung *membership* is derived from `PLACETYPE_PROJECTION` so the scorecard and the
census can never disagree about what projects where. `postcode` is deliberately excluded: it is an
orthogonal channel, not a containment rung, and folding it in would make "bottoms out at"
incoherent. Context-only placetypes project to `null` and are excluded by construction.

- [ ] **Step 1: Write the failing test**

Create `mailwoman/gazetteer-pipeline/granularity.test.ts`:

```typescript
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Granularity-ladder tests. The builder runs against a fixture DB shaped like the WOF admin DB
 *   rather than the shipped 4M-row artifact, so the parent-coverage math and the bottoms-out rule
 *   are asserted on data small enough to read.
 */

import { describe, expect, it } from "vitest"

import { LADDER, SUB_LOCALITY_RUNGS, placetypesForRung } from "./granularity.ts"

describe("LADDER", () => {
	it("orders the containment rungs shallowest first", () => {
		expect(LADDER).toEqual(["country", "region", "subregion", "locality", "dependent_locality", "venue", "unit"])
	})

	it("excludes postcode, an orthogonal channel rather than a containment rung", () => {
		expect(LADDER).not.toContain("postcode")
	})
})

describe("placetypesForRung", () => {
	it("derives membership from the projection table rather than a second hand-written list", () => {
		expect(placetypesForRung("dependent_locality")).toEqual(["borough", "macrohood", "microhood", "neighbourhood"])
		expect(placetypesForRung("locality")).toEqual(["localadmin", "locality"])
		expect(placetypesForRung("venue")).toEqual(["building", "campus", "venue"])
	})

	it("returns an empty list for a tag no placetype projects onto", () => {
		expect(placetypesForRung("po_box")).toEqual([])
	})
})

describe("SUB_LOCALITY_RUNGS", () => {
	it("names the rungs measured by parent-coverage rather than presence", () => {
		expect([...SUB_LOCALITY_RUNGS].toSorted()).toEqual(["dependent_locality", "unit", "venue"])
	})
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest --run mailwoman/gazetteer-pipeline/granularity.test.ts`
Expected: FAIL — `Cannot find module './granularity.ts'`.

- [ ] **Step 3: Create the module with the ladder**

Create `mailwoman/gazetteer-pipeline/granularity.ts`:

```typescript
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The gazetteer DEPTH LADDER — per-country measurement of where the admin gazetteer bottoms out,
 *   worldwide. Built 2026-08-02 after a probe found the shipped `admin-global-priority.db` stocks 9
 *   of WOF's 34 placetypes and carries a `dependent_locality` tier in 11 of 244 countries; the
 *   venue tier is empty. "Is WOF granular enough" had never been measured, and this module is the
 *   instrument.
 *
 *   Rung MEMBERSHIP derives from `PLACETYPE_PROJECTION` so the scorecard and the placetype census
 *   can never disagree about what projects where; rung ORDER is explicit here, because "bottoms out
 *   at" needs an ordering the projection map does not carry.
 *
 *   Two different presence rules, deliberately. Rungs at or above `locality` are measured by node
 *   PRESENCE — a country either has region rows or it does not. Rungs below it are measured by
 *   PARENT-COVERAGE SHARE: the fraction of the country's locality-class nodes carrying at least one
 *   child projecting onto that rung. That statistic is not invented here — the placetype-census
 *   probe measured GB's dependent-locality share at 33.2% of 16,987 locality-class surfaces and
 *   found it to be real conditional evidence, while WITHIN-node share carried none (WOF rarely
 *   parents a locality under a locality, so covered nodes read ~100% across the board).
 *
 *   Read-only against the admin DB: no network, no model, no writes.
 */

import type { ComponentTag } from "@mailwoman/core/types"

import { PLACETYPE_PROJECTION } from "./placetype-census.ts"

/**
 * The containment rungs, shallowest first. `postcode` is deliberately absent: it is an orthogonal channel (the
 * postcode-anchor path already ships, and `postalcode` has its own build), and folding it into a depth ladder would
 * make "bottoms out at" incoherent.
 */
export const LADDER: readonly ComponentTag[] = [
	"country",
	"region",
	"subregion",
	"locality",
	"dependent_locality",
	"venue",
	"unit",
]

/**
 * Rungs measured by parent-coverage share rather than node presence — everything BELOW the locality backbone, which is
 * the denominator those shares are taken against.
 */
export const SUB_LOCALITY_RUNGS: ReadonlySet<ComponentTag> = new Set<ComponentTag>(["dependent_locality", "venue", "unit"])

/**
 * The locality-class placetypes that host address-bearing children — the parent set and the parent-coverage
 * denominator. Matches `PARENT_PLACETYPES` in `placetype-census.ts` by construction.
 */
export const PARENT_PLACETYPES: readonly string[] = ["locality", "localadmin"]

/**
 * WOF placetypes projecting onto a rung, sorted. Derived from {@link PLACETYPE_PROJECTION} rather than hand-listed, so
 * adding a placetype to the projection table automatically widens the rung it belongs to.
 */
export function placetypesForRung(rung: ComponentTag): string[] {
	return Object.entries(PLACETYPE_PROJECTION)
		.filter(([, tag]) => tag === rung)
		.map(([placetype]) => placetype)
		.toSorted()
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn vitest --run mailwoman/gazetteer-pipeline/granularity.test.ts`
Expected: PASS, all three describe blocks.

- [ ] **Step 5: Commit**

```bash
git add mailwoman/gazetteer-pipeline/granularity.ts mailwoman/gazetteer-pipeline/granularity.test.ts
git commit -m "feat(gazetteer): the granularity rung ladder

Rung membership derives from PLACETYPE_PROJECTION so the scorecard and the
placetype census cannot disagree about what projects where. Rung order is
explicit because bottoms-out-at needs an ordering the map does not carry.
postcode is excluded: an orthogonal channel, not a containment rung."
```

---

### Task 3: Measure the ladder against the admin DB

**Files:**
- Modify: `mailwoman/gazetteer-pipeline/granularity.ts` (append)
- Modify: `mailwoman/gazetteer-pipeline/granularity.test.ts` (append)

**Interfaces:**
- Consumes: `LADDER`, `PARENT_PLACETYPES`, `placetypesForRung` (Task 2); `OVERTURE_ID_BASE` from `./admin/fold-overture.ts`.
- Produces:
  - `interface RungMeasurement { nodes: number; overtureBackfilled: number; parentsCovered: number; parentCoverage: number }`
  - `interface CountryGranularity { country: string; localityParents: number; rungs: Partial<Record<ComponentTag, RungMeasurement>> }`
  - `buildGranularityLadder(adminDBPath: string): CountryGranularity[]` — sorted by country code.

  Task 4 reads `CountryGranularity`; Task 5 renders it.

**Context the implementer needs.** Three facts about the source shape, all verified 2026-08-02:

1. `spr` carries `id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated, …`. Every query filters `is_current != 0 AND is_deprecated = 0`, matching `verifyAdmin`.
2. `ancestors(id, ancestor_id)` is the transitive closure the freeze phase builds. `buildPlacetypeCensus` joins through it, and so does this.
3. Rows with `id >= OVERTURE_ID_BASE` (8e12) are Overture-backfilled, not real WOF. They are counted **separately** and never silently merged, because for the 86-country backfill set the locality rung and above are partly Overture already — those cells are self-comparison and the report must say so.

**Why the projection happens in SQL.** A parent with both a `borough` child and a `neighbourhood`
child must count **once** toward `dependent_locality` parent-coverage. Counting distinct parents per
placetype and summing in JS double-counts it. So the query projects placetype → rung with a `CASE`
expression generated from `placetypesForRung`, then does `COUNT(DISTINCT p.id)` per rung. The
generated `CASE` cannot drift from the projection table because it is built from it.

- [ ] **Step 1: Write the failing test**

Append to `mailwoman/gazetteer-pipeline/granularity.test.ts`. Add `DatabaseSync` to the imports at
the top of the file (`import { DatabaseSync } from "node:sqlite"`) and extend the module import to
`import { LADDER, SUB_LOCALITY_RUNGS, buildGranularityLadder, placetypesForRung } from "./granularity.ts"`.

```typescript
/**
 * A fixture DB with the `spr`/`ancestors` shape the ladder reads. `node:sqlite` cannot share an `:memory:` DB across
 * connections and the builder opens its own read-only handle, so this writes a temp file — the same approach
 * `placetype-census.test.ts` uses.
 *
 * Shape: GB has two locality parents (London, Quiet Town). London carries a borough AND a neighbourhood child, which
 * must count as ONE covered parent for dependent_locality, not two. IE has one locality parent and no children at all
 * — a country that bottoms out at locality. One Overture-backfilled locality proves the source split.
 */
function ladderFixtureDB(): string {
	const path = `/tmp/granularity-fixture-${process.pid}-${Math.random().toString(36).slice(2)}.db`
	const db = new DatabaseSync(path)

	db.exec(
		`CREATE TABLE spr (id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT, is_current INTEGER, is_deprecated INTEGER)`
	)
	db.exec(`CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER)`)

	const places: Array<[number, string, string, string, number, number]> = [
		[1, "United Kingdom", "country", "GB", 1, 0],
		[2, "London", "locality", "GB", 1, 0],
		[3, "Quiet Town", "locality", "GB", 1, 0],
		[4, "Camden", "borough", "GB", 1, 0],
		[5, "Shoreditch", "neighbourhood", "GB", 1, 0],
		// Deprecated: must not count anywhere.
		[6, "Ghost Hood", "neighbourhood", "GB", 1, 1],
		[7, "Ireland", "country", "IE", 1, 0],
		[8, "Cork", "locality", "IE", 1, 0],
		// An Overture-backfilled locality: counted, but reported separately.
		[8_000_000_000_001, "Backfilled Town", "locality", "IE", 1, 0],
	]

	for (const [id, name, placetype, country, isCurrent, isDeprecated] of places) {
		db.prepare(`INSERT INTO spr VALUES (?, ?, ?, ?, ?, ?)`).run(id, name, placetype, country, isCurrent, isDeprecated)
	}

	// Camden AND Shoreditch both under London — one covered parent, not two.
	const links: Array<[child: number, ancestor: number]> = [
		[4, 2],
		[5, 2],
		[6, 2],
	]

	for (const [id, ancestorID] of links) {
		db.prepare(`INSERT INTO ancestors VALUES (?, ?)`).run(id, ancestorID)
	}

	db.close()

	return path
}

describe("buildGranularityLadder", () => {
	it("counts a parent with two differently-typed children once", () => {
		const rows = buildGranularityLadder(ladderFixtureDB())
		const gb = rows.find((row) => row.country === "GB")

		// London has a borough child and a neighbourhood child; both project onto dependent_locality.
		expect(gb?.rungs.dependent_locality?.nodes).toBe(2)
		expect(gb?.rungs.dependent_locality?.parentsCovered).toBe(1)
	})

	it("takes parent-coverage against the country's locality-class node count", () => {
		const rows = buildGranularityLadder(ladderFixtureDB())
		const gb = rows.find((row) => row.country === "GB")

		// GB has two locality parents (London, Quiet Town); one carries a dependent locality.
		expect(gb?.localityParents).toBe(2)
		expect(gb?.rungs.dependent_locality?.parentCoverage).toBeCloseTo(0.5, 6)
	})

	it("excludes deprecated rows", () => {
		const rows = buildGranularityLadder(ladderFixtureDB())
		const gb = rows.find((row) => row.country === "GB")

		// "Ghost Hood" is deprecated: 3 neighbourhood-family rows exist, 2 count.
		expect(gb?.rungs.dependent_locality?.nodes).toBe(2)
	})

	it("splits Overture-backfilled rows from real WOF rows", () => {
		const rows = buildGranularityLadder(ladderFixtureDB())
		const ie = rows.find((row) => row.country === "IE")

		expect(ie?.rungs.locality?.nodes).toBe(2)
		expect(ie?.rungs.locality?.overtureBackfilled).toBe(1)
	})

	it("records a measured-and-empty rung as a present zero, not an absent row", () => {
		const rows = buildGranularityLadder(ladderFixtureDB())
		const ie = rows.find((row) => row.country === "IE")

		// IE was measured for dependent_locality and has none. The meaning-of-zero rule: present, zero.
		expect(ie?.rungs.dependent_locality).toBeDefined()
		expect(ie?.rungs.dependent_locality?.nodes).toBe(0)
		expect(ie?.rungs.dependent_locality?.parentCoverage).toBe(0)
	})

	it("returns countries sorted by code", () => {
		const rows = buildGranularityLadder(ladderFixtureDB())

		expect(rows.map((row) => row.country)).toEqual(["GB", "IE"])
	})
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest --run mailwoman/gazetteer-pipeline/granularity.test.ts -t buildGranularityLadder`
Expected: FAIL — `buildGranularityLadder is not a function` (the import is unresolved).

- [ ] **Step 3: Implement the builder**

Append to `mailwoman/gazetteer-pipeline/granularity.ts`. Add these imports at the top of the file,
below the existing ones:

```typescript
import { DatabaseSync } from "node:sqlite"

import { OVERTURE_ID_BASE } from "./admin/fold-overture.ts"
```

Then append:

```typescript
/**
 * One rung's measurement for one country. A rung the builder LOOKED AT and found empty is a present row of zeroes; a
 * rung with no measurable source is absent from `CountryGranularity.rungs` entirely. Collapsing those two would break
 * the meaning-of-zero rule inside the artifact.
 */
export interface RungMeasurement {
	/**
	 * Current, non-deprecated nodes at this rung, both sources combined.
	 */
	nodes: number
	/**
	 * How many of {@link nodes} are Overture-backfilled (`id >= OVERTURE_ID_BASE`) rather than real WOF. For the
	 * 86-country backfill set the locality rung and above are partly Overture, so a report that hid this would present
	 * self-comparison as corroboration.
	 */
	overtureBackfilled: number
	/**
	 * Distinct locality-class parents carrying at least one child projecting onto this rung.
	 */
	parentsCovered: number
	/**
	 * {@link parentsCovered} over the country's locality-class node count. Zero when the country has no locality parents.
	 */
	parentCoverage: number
}

/**
 * One country's ladder.
 */
export interface CountryGranularity {
	country: string
	/**
	 * The parent-coverage denominator: current, non-deprecated `locality`/`localadmin` nodes.
	 */
	localityParents: number
	rungs: Partial<Record<ComponentTag, RungMeasurement>>
}

/**
 * Build a `CASE` expression projecting `spr.placetype` onto a rung name, generated from the projection table so it
 * cannot drift from it. Placetypes projecting onto nothing in {@link LADDER} fall through to NULL and are filtered by
 * the caller's `WHERE`.
 */
function rungCaseExpression(column: string): string {
	const whens = LADDER.flatMap((rung) =>
		placetypesForRung(rung).map((placetype) => `WHEN '${placetype}' THEN '${rung}'`)
	)

	return `CASE ${column} ${whens.join(" ")} END`
}

/**
 * Every placetype that lands on a ladder rung — the `IN` list bounding both queries.
 */
function ladderPlacetypes(): string[] {
	return LADDER.flatMap((rung) => placetypesForRung(rung))
}

/**
 * Measure the depth ladder for every country in the admin DB.
 *
 * Read-only. Two queries: node counts per (country, rung) with the source split, and distinct covered parents per
 * (country, rung) through `ancestors`. The projection runs in SQL because a parent with both a borough child and a
 * neighbourhood child must count ONCE toward `dependent_locality` — counting distinct parents per placetype and summing
 * in JS would double it.
 */
export function buildGranularityLadder(adminDBPath: string): CountryGranularity[] {
	const db = new DatabaseSync(adminDBPath, { readOnly: true })

	try {
		const placetypeList = ladderPlacetypes()
			.map((placetype) => `'${placetype}'`)
			.join(", ")
		const parentList = PARENT_PLACETYPES.map((placetype) => `'${placetype}'`).join(", ")
		// Alias-qualified: the parent query joins `spr` to itself, so an unqualified `is_deprecated` is ambiguous.
		const live = (alias: string): string => `${alias}.is_current != 0 AND ${alias}.is_deprecated = 0`

		const nodeRows = db
			.prepare(
				`SELECT s.country AS country,
					${rungCaseExpression("s.placetype")} AS rung,
					COUNT(*) AS nodes,
					SUM(CASE WHEN s.id >= ? THEN 1 ELSE 0 END) AS overtureBackfilled
				 FROM spr s
				 WHERE ${live("s")} AND s.country != '' AND s.placetype IN (${placetypeList})
				 GROUP BY s.country, rung`
			)
			.all(OVERTURE_ID_BASE) as Array<{
			country: string
			rung: ComponentTag
			nodes: number
			overtureBackfilled: number | null
		}>

		const parentRows = db
			.prepare(
				`SELECT p.country AS country,
					${rungCaseExpression("s.placetype")} AS rung,
					COUNT(DISTINCT p.id) AS parentsCovered
				 FROM spr s
				 JOIN ancestors a ON a.id = s.id
				 JOIN spr p ON p.id = a.ancestor_id
				 WHERE p.placetype IN (${parentList})
				   AND s.placetype IN (${placetypeList})
				   AND s.country = p.country
				   AND s.id != p.id
				   AND ${live("s")}
				   AND ${live("p")}
				 GROUP BY p.country, rung`
			)
			.all() as Array<{ country: string; rung: ComponentTag; parentsCovered: number }>

		const denominatorRows = db
			.prepare(
				`SELECT s.country AS country, COUNT(*) AS localityParents
				 FROM spr s
				 WHERE ${live("s")} AND s.country != '' AND s.placetype IN (${parentList})
				 GROUP BY s.country`
			)
			.all() as Array<{ country: string; localityParents: number }>

		const byCountry = new Map<string, CountryGranularity>()

		const ensure = (country: string): CountryGranularity => {
			const existing = byCountry.get(country)

			if (existing) return existing

			// Seed EVERY rung at zero: the country was measured, so an empty rung is a present zero. A rung with no
			// measurable source at all is dropped by the caller, not left implicit here.
			const rungs: Partial<Record<ComponentTag, RungMeasurement>> = {}

			for (const rung of LADDER) {
				rungs[rung] = { nodes: 0, overtureBackfilled: 0, parentsCovered: 0, parentCoverage: 0 }
			}

			const row: CountryGranularity = { country, localityParents: 0, rungs }

			byCountry.set(country, row)

			return row
		}

		for (const row of denominatorRows) {
			ensure(row.country).localityParents = row.localityParents
		}

		for (const row of nodeRows) {
			if (!row.rung) continue

			const measurement = ensure(row.country).rungs[row.rung]!

			measurement.nodes = row.nodes
			measurement.overtureBackfilled = row.overtureBackfilled ?? 0
		}

		for (const row of parentRows) {
			if (!row.rung) continue

			const country = ensure(row.country)
			const measurement = country.rungs[row.rung]!

			measurement.parentsCovered = row.parentsCovered
		}

		for (const country of byCountry.values()) {
			for (const rung of LADDER) {
				const measurement = country.rungs[rung]!

				measurement.parentCoverage = country.localityParents
					? measurement.parentsCovered / country.localityParents
					: 0
			}
		}

		return [...byCountry.values()].toSorted((a, b) => a.country.localeCompare(b.country))
	} finally {
		db.close()
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn vitest --run mailwoman/gazetteer-pipeline/granularity.test.ts`
Expected: PASS, all six `buildGranularityLadder` tests plus Task 2's three describe blocks.

- [ ] **Step 5: Smoke against the real artifact**

Run:

```bash
node --input-type=module -e '
import { buildGranularityLadder } from "./mailwoman/gazetteer-pipeline/granularity.ts"
import { dataRootPath } from "@mailwoman/core/utils"
const rows = buildGranularityLadder(String(dataRootPath("wof", "admin-global-priority.db")))
console.log("countries:", rows.length)
for (const cc of ["GB", "IE", "JP", "DE"]) {
  const r = rows.find((row) => row.country === cc)
  console.log(cc, "localityParents", r?.localityParents,
    "depLoc nodes", r?.rungs.dependent_locality?.nodes,
    "coverage", ((r?.rungs.dependent_locality?.parentCoverage ?? 0) * 100).toFixed(1) + "%")
}'
```

Expected: `countries: 244`. GB `depLoc nodes 13177`, IE `depLoc nodes 0`, JP `depLoc nodes 7759`,
DE `depLoc nodes 67162` — these must match the design-stage probe exactly. GB's coverage share is
the number to sanity-check against the census probe's 33.2% reading; it will not match exactly (the
census measured distinct *surfaces*, this measures distinct *nodes*), but a wildly different figure
means the join is wrong. **If the counts do not match the probe, stop and diagnose before Task 4.**

- [ ] **Step 6: Commit**

```bash
git add mailwoman/gazetteer-pipeline/granularity.ts mailwoman/gazetteer-pipeline/granularity.test.ts
git commit -m "feat(gazetteer): measure the depth ladder against the admin DB

Node counts and parent-coverage per (country, rung), with the Overture
backfill split kept visible so the 86-country backfill set cannot present
self-comparison as corroboration. The placetype-to-rung projection runs in
SQL, generated from PLACETYPE_PROJECTION, because a parent with both a
borough and a neighbourhood child must count once toward dependent_locality.

Every rung is seeded at zero for a measured country: a measured-and-empty
rung is a present zero, never an absent row."
```

---

### Task 4: Derive "bottoms out at"

**Files:**
- Modify: `mailwoman/gazetteer-pipeline/granularity.ts` (append)
- Modify: `mailwoman/gazetteer-pipeline/granularity.test.ts` (append)

**Interfaces:**
- Consumes: `CountryGranularity`, `LADDER`, `SUB_LOCALITY_RUNGS` (Tasks 2-3).
- Produces: `DEFAULT_COVERAGE_FLOOR = 0.05` and `bottomsOutAt(country: CountryGranularity, floor?: number): ComponentTag | null`. Task 5 renders the result.

**Context the implementer needs.** Two presence rules, because parent-coverage is only meaningful
below the locality backbone (the backbone is its denominator). At or above `locality`, a rung counts
as reached when it has any nodes. Below it, when parent-coverage clears the floor. The walk goes
deepest-first and returns the first rung that qualifies; `null` means the country has nothing at
all, which should only happen for a country code with no live rows.

The 5% default is the weakest number in the design and is flagged as such in the spec's open
questions: GB, the one country with a validated reading, sits at 33.2%. The floor is a parameter
precisely so the report can be re-run at another value without a code change.

- [ ] **Step 1: Write the failing test**

Append to `mailwoman/gazetteer-pipeline/granularity.test.ts`, extending the module import with
`DEFAULT_COVERAGE_FLOOR, bottomsOutAt`:

```typescript
/**
 * Build a `CountryGranularity` by hand so the bottoms-out rule is tested independently of any SQL.
 */
function granularity(
	country: string,
	spec: Partial<Record<string, { nodes?: number; parentCoverage?: number }>>,
	localityParents = 100
): CountryGranularity {
	const rungs: Partial<Record<ComponentTag, RungMeasurement>> = {}

	for (const rung of LADDER) {
		const given = spec[rung]

		rungs[rung] = {
			nodes: given?.nodes ?? 0,
			overtureBackfilled: 0,
			parentsCovered: Math.round((given?.parentCoverage ?? 0) * localityParents),
			parentCoverage: given?.parentCoverage ?? 0,
		}
	}

	return { country, localityParents, rungs }
}

describe("bottomsOutAt", () => {
	it("uses node presence at and above the locality backbone", () => {
		const row = granularity("XX", { country: { nodes: 1 }, region: { nodes: 12 } })

		expect(bottomsOutAt(row)).toBe("region")
	})

	it("uses parent-coverage below the backbone", () => {
		const row = granularity("GB", {
			country: { nodes: 1 },
			locality: { nodes: 16_677 },
			dependent_locality: { nodes: 13_177, parentCoverage: 0.33 },
		})

		expect(bottomsOutAt(row)).toBe("dependent_locality")
	})

	it("does not credit a sub-locality rung with nodes but coverage under the floor", () => {
		// A handful of nodes clustered under one parent is not a tier the country reaches.
		const row = granularity("XX", {
			country: { nodes: 1 },
			locality: { nodes: 5_000 },
			dependent_locality: { nodes: 40, parentCoverage: 0.01 },
		})

		expect(bottomsOutAt(row)).toBe("locality")
	})

	it("honors a caller-supplied floor", () => {
		const row = granularity("XX", {
			locality: { nodes: 5_000 },
			dependent_locality: { nodes: 40, parentCoverage: 0.01 },
		})

		expect(bottomsOutAt(row, 0.005)).toBe("dependent_locality")
	})

	it("returns the deepest qualifying rung, not the first", () => {
		const row = granularity("JP", {
			country: { nodes: 1 },
			locality: { nodes: 43_868 },
			dependent_locality: { nodes: 7_759, parentCoverage: 0.08 },
			venue: { nodes: 2_000, parentCoverage: 0.2 },
		})

		expect(bottomsOutAt(row)).toBe("venue")
	})

	it("returns null for a country with no live rows at any rung", () => {
		expect(bottomsOutAt(granularity("ZZ", {}, 0))).toBeNull()
	})

	it("defaults the floor to five percent", () => {
		expect(DEFAULT_COVERAGE_FLOOR).toBe(0.05)
	})
})
```

Extend the type-only import at the top of the test file:

```typescript
import type { ComponentTag } from "@mailwoman/core/types"

import type { CountryGranularity, RungMeasurement } from "./granularity.ts"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest --run mailwoman/gazetteer-pipeline/granularity.test.ts -t bottomsOutAt`
Expected: FAIL — `bottomsOutAt is not a function`.

- [ ] **Step 3: Implement the derivation**

Append to `mailwoman/gazetteer-pipeline/granularity.ts`:

```typescript
/**
 * Default parent-coverage floor for crediting a sub-locality rung.
 *
 * This is the weakest number in the design and is deliberately a parameter. GB — the one country with a validated
 * reading — sits around 33%, so 5% is far below the only calibration point we have; it is set low on purpose, to catch
 * thin-but-real tiers rather than to certify them. A second calibration point should harden it.
 */
export const DEFAULT_COVERAGE_FLOOR = 0.05

/**
 * The deepest rung a country actually reaches, or `null` when it has nothing live at any rung.
 *
 * Two presence rules, because parent-coverage is only meaningful BELOW the locality backbone — the backbone is its
 * denominator. At or above `locality`, a rung counts as reached when it has any nodes. Below it, when parent-coverage
 * clears `floor`.
 */
export function bottomsOutAt(country: CountryGranularity, floor: number = DEFAULT_COVERAGE_FLOOR): ComponentTag | null {
	for (const rung of [...LADDER].toReversed()) {
		const measurement = country.rungs[rung]

		if (!measurement) continue

		const reached = SUB_LOCALITY_RUNGS.has(rung) ? measurement.parentCoverage >= floor : measurement.nodes > 0

		if (reached) return rung
	}

	return null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn vitest --run mailwoman/gazetteer-pipeline/granularity.test.ts`
Expected: PASS, every describe block in the file.

- [ ] **Step 5: Commit**

```bash
git add mailwoman/gazetteer-pipeline/granularity.ts mailwoman/gazetteer-pipeline/granularity.test.ts
git commit -m "feat(gazetteer): derive the bottoms-out-at rung

Node presence at and above the locality backbone, parent-coverage share
below it — the backbone is that share's denominator, so the two rules are
not interchangeable. The 5% floor is a parameter because GB, the only
country with a validated reading, sits near 33%."
```

---

### Task 5: Render the report

**Files:**
- Create: `mailwoman/gazetteer-pipeline/granularity-report.ts`
- Create: `mailwoman/gazetteer-pipeline/granularity-report.test.ts`

**Interfaces:**
- Consumes: `CountryGranularity`, `bottomsOutAt`, `LADDER`, `DEFAULT_COVERAGE_FLOOR` (Tasks 2-4).
- Produces: `renderGranularityReport(rows: CountryGranularity[], meta: GranularityReportMeta): string`, where `GranularityReportMeta` is `{ sourcePath: string; sourceMD5: string; buildDate: string; floor: number }`. Task 6 writes the returned string to disk.

**Context the implementer needs.** The report is a committed artifact under
`docs/articles/evals/coverage/`, following the `fill-rates.md` precedent
(`$MAILWOMAN_DATA_ROOT/overture/<release>/fill-rates.md`). It must state its own limits inline —
this is the spec's Section 5, and the reason is that the numbers will outlive the conversation that
produced them. Someone reading the table in six months must be told, in the file, that counts are
not quality and that the locality rung is self-comparison for backfilled countries.

`buildDate` is injected rather than read from the clock so the renderer is deterministic under test.

- [ ] **Step 1: Write the failing test**

Create `mailwoman/gazetteer-pipeline/granularity-report.test.ts`:

```typescript
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Report-renderer tests. The renderer is pure — rows in, markdown out, `buildDate` injected — so
 *   the committed artifact's shape is asserted without touching a DB or a clock.
 */

import type { ComponentTag } from "@mailwoman/core/types"

import { describe, expect, it } from "vitest"

import type { CountryGranularity, RungMeasurement } from "./granularity.ts"
import { LADDER } from "./granularity.ts"
import { renderGranularityReport } from "./granularity-report.ts"

function row(
	country: string,
	spec: Partial<Record<string, { nodes?: number; overtureBackfilled?: number; parentCoverage?: number }>>,
	localityParents = 100
): CountryGranularity {
	const rungs: Partial<Record<ComponentTag, RungMeasurement>> = {}

	for (const rung of LADDER) {
		const given = spec[rung]

		rungs[rung] = {
			nodes: given?.nodes ?? 0,
			overtureBackfilled: given?.overtureBackfilled ?? 0,
			parentsCovered: Math.round((given?.parentCoverage ?? 0) * localityParents),
			parentCoverage: given?.parentCoverage ?? 0,
		}
	}

	return { country, localityParents, rungs }
}

const META = {
	sourcePath: "$MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db",
	sourceMD5: "d41d8cd98f00b204e9800998ecf8427e",
	buildDate: "2026-08-02T00:00:00.000Z",
	floor: 0.05,
}

describe("renderGranularityReport", () => {
	it("puts the bottoms-out-at column in the summary table", () => {
		const markdown = renderGranularityReport(
			[row("GB", { country: { nodes: 1 }, locality: { nodes: 16_677 }, dependent_locality: { nodes: 13_177, parentCoverage: 0.33 } })],
			META
		)

		expect(markdown).toContain("| GB |")
		expect(markdown).toContain("dependent_locality")
	})

	it("marks a country whose rung is Overture-backfilled rather than real WOF", () => {
		const markdown = renderGranularityReport(
			[row("IE", { country: { nodes: 1 }, locality: { nodes: 3_230, overtureBackfilled: 3_230 } })],
			META
		)

		expect(markdown).toMatch(/IE[^\n]*100\.0% ovt/)
	})

	it("pins the source and the floor in the header", () => {
		const markdown = renderGranularityReport([row("GB", { country: { nodes: 1 } })], META)

		expect(markdown).toContain("d41d8cd98f00b204e9800998ecf8427e")
		expect(markdown).toContain("2026-08-02T00:00:00.000Z")
		expect(markdown).toContain("5.0%")
	})

	it("declares its own limits inline", () => {
		const markdown = renderGranularityReport([row("GB", { country: { nodes: 1 } })], META)

		expect(markdown).toContain("Counts are not quality")
		expect(markdown).toContain("meaning-of-zero")
	})

	it("renders a measured-and-empty rung as 0 rather than omitting it", () => {
		const markdown = renderGranularityReport(
			[row("IE", { country: { nodes: 1 }, locality: { nodes: 3_230 } })],
			META
		)

		// IE was measured for dependent_locality and has none: the cell must exist and read 0.
		const ieLine = markdown.split("\n").find((line) => line.startsWith("| IE |"))

		expect(ieLine).toBeDefined()
		expect(ieLine).toContain("| 0 |")
	})
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest --run mailwoman/gazetteer-pipeline/granularity-report.test.ts`
Expected: FAIL — `Cannot find module './granularity-report.ts'`.

- [ ] **Step 3: Implement the renderer**

Create `mailwoman/gazetteer-pipeline/granularity-report.ts`:

```typescript
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Markdown renderer for the gazetteer depth scorecard — the committed artifact under
 *   `docs/articles/evals/coverage/`, following the `fill-rates.md` precedent.
 *
 *   The report declares its own limits inline rather than deferring them to a design doc. These
 *   numbers will outlive the conversation that produced them, and a reader six months out must be
 *   told IN THE FILE that counts are not quality and that the locality rung is self-comparison for
 *   the Overture-backfilled countries.
 *
 *   Pure: rows in, markdown out, `buildDate` injected by the caller so the output is deterministic
 *   under test.
 */

import type { ComponentTag } from "@mailwoman/core/types"

import { LADDER, type CountryGranularity, bottomsOutAt } from "./granularity.ts"

export interface GranularityReportMeta {
	/**
	 * Display path of the measured DB. Use the `$MAILWOMAN_DATA_ROOT`-relative form, never the resolved lab path.
	 */
	sourcePath: string
	sourceMD5: string
	/**
	 * ISO timestamp, injected rather than read from the clock so the renderer stays deterministic.
	 */
	buildDate: string
	floor: number
}

function pct(value: number): string {
	return `${(value * 100).toFixed(1)}%`
}

/**
 * One row's cell for a rung: node count, plus the Overture-backfilled share when any of it is backfilled.
 */
function rungCell(country: CountryGranularity, rung: ComponentTag): string {
	const measurement = country.rungs[rung]

	// Absent measurement = never measured. Distinct from a measured zero, which renders as "0".
	if (!measurement) return "—"

	if (!measurement.nodes) return "0"

	if (!measurement.overtureBackfilled) return measurement.nodes.toLocaleString()

	const share = measurement.overtureBackfilled / measurement.nodes

	return `${measurement.nodes.toLocaleString()} (${pct(share)} ovt)`
}

/**
 * Render the scorecard.
 */
export function renderGranularityReport(rows: CountryGranularity[], meta: GranularityReportMeta): string {
	const header = LADDER.join(" | ")
	const alignment = LADDER.map(() => "--:").join(" | ")

	const body = rows.map((country) => {
		const bottom = bottomsOutAt(country, meta.floor)
		const cells = LADDER.map((rung) => rungCell(country, rung)).join(" | ")

		return `| ${country.country} | ${bottom ?? "(none)"} | ${country.localityParents.toLocaleString()} | ${cells} |`
	})

	const reached = rows.filter((country) => bottomsOutAt(country, meta.floor) === "dependent_locality").length

	return `# Gazetteer depth scorecard

Generated by \`mailwoman gazetteer granularity\`. Per-country measurement of where the admin
gazetteer bottoms out — node counts per containment rung, and for the sub-locality rungs the
parent-coverage share (the fraction of the country's locality-class nodes carrying at least one
child projecting onto that rung).

- **Source:** \`${meta.sourcePath}\` (md5 \`${meta.sourceMD5}\`)
- **Built:** ${meta.buildDate}
- **Parent-coverage floor:** ${pct(meta.floor)} — a sub-locality rung counts as reached only above this.
- **Countries measured:** ${rows.length.toLocaleString()}
- **Countries reaching \`dependent_locality\`:** ${reached.toLocaleString()}

## What this report does not tell you

- **Counts are not quality.** A node count establishes where to look, never that the rows are good.
- **There is no demand-side grounding below the locality line.** Nothing here proves a sub-locality
  surface appears in real addresses. Overture's \`address_levels\` — the obvious instrument — bottoms
  out at municipality in every country measured, so it cannot see this tier.
- **The locality rung and above are partly self-comparison.** For the Overture-backfilled country
  set those rows came from Overture, not WOF; the \`ovt\` share in each cell is how much.
- **An empty rung is coverage, not fact.** \`ADMIN_PLACETYPES\` in \`admin/ingest-wof.ts\` allowlists
  9 of WOF's 34 placetypes, so for 25 of them the build never asked. Per the **meaning-of-zero**
  rule a measured-and-empty rung renders as \`0\` and a never-measured rung as \`—\`; they are not
  the same claim.

## Ladder

| country | bottoms out at | locality parents | ${header} |
| --- | --- | --: | ${alignment} |
${body.join("\n")}
`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn vitest --run mailwoman/gazetteer-pipeline/granularity-report.test.ts`
Expected: PASS, all five tests.

- [ ] **Step 5: Commit**

```bash
git add mailwoman/gazetteer-pipeline/granularity-report.ts mailwoman/gazetteer-pipeline/granularity-report.test.ts
git commit -m "feat(gazetteer): render the depth scorecard as markdown

The report declares its own limits inline — counts are not quality, there is
no demand-side grounding below the locality line, and the locality rung is
self-comparison for backfilled countries. Those numbers will outlive this
conversation and the caveats have to travel with them.

Measured-and-empty renders 0, never-measured renders em-dash: the
meaning-of-zero rule made visible in the artifact."
```

---

### Task 6: Wire the command

**Files:**
- Create: `mailwoman/commands/gazetteer/granularity.tsx`
- Test: manual smoke (the command layer is Ink/TSX; the logic it calls is covered by Tasks 2-5)

**Interfaces:**
- Consumes: `buildGranularityLadder` (Task 3), `renderGranularityReport` + `GranularityReportMeta` (Task 5), `DEFAULT_COVERAGE_FLOOR` (Task 4).
- Produces: the `mailwoman gazetteer granularity` subcommand and a written markdown report.

**Context the implementer needs.** Commands in this repo are Pastel/Ink components. The pattern is
fixed and `mailwoman/commands/gazetteer/census.tsx` is the closest analogue — read it before
starting. The required shape: a zod `OptionsSchema` re-exported as `options`, a
`CommandComponent<typeof OptionsSchema>` default export, `useCommandTask` wrapping the async work
and returning `string[]` of result lines, and the three-branch render (`error` → red, `done` → the
lines with the first in green, otherwise `null`).

Pastel binds a kebab flag to a lowercase-acronym prop, so option keys must match its derivation —
`--out`, `--source`, `--floor` are all single words and unaffected here.

- [ ] **Step 1: Create the command**

Create `mailwoman/commands/gazetteer/granularity.tsx`:

```tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer granularity` — the per-country gazetteer depth scorecard.
 *
 *   Answers "where does the admin gazetteer bottom out?" for every country it knows, which nobody
 *   had measured: the shipped artifact stocks 9 of WOF's 34 placetypes and carries a
 *   `dependent_locality` tier in 11 of 244 countries. Read-only, no network, no model — two grouped
 *   queries over `spr`/`ancestors` and a markdown render.
 *
 *   The report is a COMMITTED artifact (the `fill-rates.md` precedent), so the source md5 and the
 *   parent-coverage floor are pinned in its header. Re-running against a rebuilt gazetteer and
 *   diffing the report is the intended workflow.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { dataRootPath, md5File } from "@mailwoman/core/utils"
import { Box, Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { DEFAULT_COVERAGE_FLOOR, bottomsOutAt, buildGranularityLadder } from "../../gazetteer-pipeline/granularity.ts"
import { renderGranularityReport } from "../../gazetteer-pipeline/granularity-report.ts"

const OptionsSchema = zod.object({
	out: zod
		.string()
		.default("docs/articles/evals/coverage/gazetteer-depth-scorecard.md")
		.describe("Output path for the markdown scorecard"),
	source: zod.string().optional().describe("WOF admin DB. Default $MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db"),
	floor: zod
		.number()
		.default(DEFAULT_COVERAGE_FLOOR)
		.describe(
			`Parent-coverage floor for crediting a sub-locality rung. Default ${DEFAULT_COVERAGE_FLOOR} — set low on ` +
				"purpose, to catch thin-but-real tiers rather than certify them."
		),
})

export { OptionsSchema as options }

const GazetteerGranularity: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const sourcePath = options.source ?? String(dataRootPath("wof", "admin-global-priority.db"))
		const rows = buildGranularityLadder(sourcePath)

		if (!rows.length) {
			throw new Error(`granularity: no countries measured from ${sourcePath} — is this an admin DB?`)
		}

		const markdown = renderGranularityReport(rows, {
			// Display the portable form; never bake the resolved lab path into a committed artifact.
			sourcePath: "$MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db",
			sourceMD5: await md5File(sourcePath),
			buildDate: new Date().toISOString(),
			floor: options.floor,
		})

		mkdirSync(dirname(options.out), { recursive: true })
		writeFileSync(options.out, markdown)

		const byBottom = new Map<string, number>()

		for (const row of rows) {
			const bottom = bottomsOutAt(row, options.floor) ?? "(none)"

			byBottom.set(bottom, (byBottom.get(bottom) ?? 0) + 1)
		}

		const distribution = [...byBottom.entries()]
			.toSorted((a, b) => b[1] - a[1])
			.map(([rung, n]) => `  ${rung}: ${n.toLocaleString()} countries`)

		return [
			`gazetteer depth scorecard → ${options.out}`,
			`countries measured: ${rows.length.toLocaleString()} (floor ${(options.floor * 100).toFixed(1)}%)`,
			"bottoms out at:",
			...distribution,
		]
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				{state.result.map((line, i) => (
					<Text key={i} color={i === 0 ? "green" : undefined}>
						{i === 0 ? "✓ " : "  "}
						{line}
					</Text>
				))}
			</Box>
		)
	}

	return null
}

export default GazetteerGranularity
```

Only `dirname` is imported from `node:path` — the command builds no paths, it only makes the output
file's parent directory. Do not add imports the file does not use; oxlint flags them.

- [ ] **Step 2: Run the command**

Run: `yarn mailwoman gazetteer granularity --out /tmp/scorecard-smoke.md`
Expected: exit 0, and the summary reports 244 countries measured with a `bottoms out at`
distribution dominated by `locality`.

If `yarn mailwoman` is not the invocation this repo uses, check `package.json`'s `bin`/scripts and
the sibling command's usage before improvising.

- [ ] **Step 3: Verify the report against the design-stage probe**

Run: `rg -n "^\| (GB|IE|JP|DE|NZ) \|" /tmp/scorecard-smoke.md`

Expected, matching the numbers in the spec exactly:
- GB `dependent_locality` cell reads `13,177`
- DE reads `67,162`
- JP reads `7,759`
- IE and NZ read `0` — measured and empty, not `—`

**If any cell reads `—` for these five countries, the meaning-of-zero handling is wrong.** Stop and
fix before committing.

- [ ] **Step 4: Generate the committed report**

Run: `yarn mailwoman gazetteer granularity`
Expected: writes `docs/articles/evals/coverage/gazetteer-depth-scorecard.md`.

- [ ] **Step 5: Run the full unit suite**

Run: `yarn ci:test:fast`
Expected: PASS. This is the ~15s pure-surface leg; it must be green before the commit.

- [ ] **Step 6: Commit**

```bash
git add mailwoman/commands/gazetteer/granularity.tsx \
        docs/articles/evals/coverage/gazetteer-depth-scorecard.md
git commit -m "feat(gazetteer): mailwoman gazetteer granularity

The per-country depth scorecard, and the first committed run of it. 244
countries measured; the dependent_locality tier exists in 11 of them and the
venue tier in none, which is the answer to a question we had been assuming
rather than measuring.

The report pins its source md5 and its parent-coverage floor, so re-running
against a rebuilt gazetteer and diffing is the intended workflow."
```

---

## Verification checklist

Before opening the PR:

- [ ] `yarn ci:test:fast` passes.
- [ ] `yarn vitest --run mailwoman/gazetteer-pipeline/` passes — census, granularity, and report suites.
- [ ] The committed scorecard's GB/DE/JP row counts match the spec's Finding 1 and Finding 3 tables exactly.
- [ ] IE and NZ render `0` at `dependent_locality`, never `—`.
- [ ] `rg -n "mnt/playpen" mailwoman/gazetteer-pipeline/granularity*.ts mailwoman/commands/gazetteer/granularity.tsx` returns nothing.
- [ ] `mailwoman gazetteer census --country gb` still succeeds — PR A widened the projection map and must not have broken it.
