# Typed Evidence and Derivation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the repository one vocabulary for typed evidence and epistemic status, wire the coverage-basis exclusion gate that already exists and has never been called, and project a derivation into the geocode result.

**Architecture:** A new zero-dependency leaf workspace `@mailwoman/evidence` owns the evidence union, the epistemic-status axis, `CoverageBasis` + `supportsExclusion` (moved out of `@mailwoman/core/layers`, which re-exports them), and the derivation projection. Four consumers adopt it in order of what is buildable today: `plausibilityCheck` re-expressed with no behaviour change, a GB spatial-existence probe over `uprn.db`, the resolver's demote-only negative mode, and a US `surveyed` coverage basis from Census H1. Exclusions demote; they never remove.

**Tech Stack:** TypeScript running directly under Node (type stripping, `.ts` specifiers, `erasableSyntaxOnly`), vitest, Kysely over `node:sqlite`, H3.

**Spec:** [`docs/superpowers/specs/2026-08-21-evidence-derivation-design.md`](../specs/2026-08-21-evidence-derivation-design.md)

## Global Constraints

- **`erasableSyntaxOnly: true`** — no `enum` (use `const X = {…} as const` + `type X = (typeof X)[keyof typeof X]`), no constructor parameter properties, no runtime namespaces.
- **Relative imports use explicit `.ts` extensions.** Each workspace tsconfig sets `rewriteRelativeImportExtensions: true`.
- **`@mailwoman/evidence` has ZERO runtime dependencies.** Not `@mailwoman/core`, not `@mailwoman/spatial`. Adding one defeats the reason the workspace exists.
- **Acronym casing:** whole camelCase components — `parseJSON`, `readID`, `POILookup`. `ID` never `Id`. Enforced by `sister-software/no-title-case-acronym` in `yarn lint:oxlint`.
- **No raw `process.env` / `process.argv`** — CI-enforced. Use `core/env/schema.ts` + `env-paths`.
- **Data-root paths go through `@mailwoman/core/utils`** (`dataRootPath`, `mailwomanDataRoot`). Never hard-code `/mnt/playpen/mailwoman-data`.
- **Never hand-assemble a path into another package's install directory.** Use `import.meta.resolve`, a real `exports` subpath, or `dataRootPath`.
- **Exclusions demote only.** No task in this plan may remove a candidate from a result set.
- **Run `yarn compile` before any test run** that crosses a workspace boundary — a stale `out/` reads as a broken test.

---

## Task 1: Falsifier — decompose the 187 coverage misses

**This task gates every other task.** If fold failures dominate, the negative-evidence arms do not get built and this plan stops at Task 9.

**Files:**

- Create: `scratchpad/2026-08-21-coverage-miss-decomposition.md` (the verdict — a record, not code)
- Read only: `packages/dev-mcp/lib/constraint-census.ts`

**Interfaces:**

- Consumes: nothing
- Produces: a written verdict with counts. No code.

- [ ] **Step 1: Restart the dev-MCP worker so it serves current source**

Run the `mwdev_restart` MCP tool. Expected: a result naming both boot fingerprints.

- [ ] **Step 2: Run the constraint census over the full board**

Run the `mwdev_constraints` MCP tool with `inputs: {"kind": "board"}`. It takes >120s and moves to the background; wait for the task notification. The result is written to a file — do not try to read it inline.

Expected shape (the 2026-08-21 baseline, for comparison):

```
591 rows → 1,609 backend lookups; 306 resolved nothing (19.0%)
  key exists in another band :  119
  key exists nowhere         :  187
  by band                    :  locality 96 · postalcode 80 · region 11
  INERT                      :  parent_fallback_retry (196 firings, 196 nothing, 0 conversions)
```

- [ ] **Step 3: Extract the locality-band coverage misses**

```bash
F=<the result file path from the notification>
jq -r '[.misses[] | select((.elsewhere|length)==0 and .band=="locality")][] | "\(.value)\t|\t\(.input)"' "$F" | sort -u
```

- [ ] **Step 4: Classify every row into exactly one of four classes**

Classify by hand — this is a judgement the measurement cannot make. The classes, with the observed exemplars:

| Class           | Test                                                                 | Exemplars                                                                             |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `mistag_street` | the value is a fragment of a street phrase in the input              | `Avenida` ← `Avenida Corrientes`; `de Catalunya` ← `Rambla de Catalunya`; `Turner St` |
| `mistag_poi`    | the value names a venue or landmark                                  | `Statue of Liberty`; `Great Mosque of Niamey`                                         |
| `junk_span`     | the value is not a name at all                                       | `New` ← `New Territories, Hong Kong`; `near NAFTI`                                    |
| `fold_failure`  | **the place is real and we plausibly hold it under another surface** | see the three sub-mechanisms below                                                    |

`fold_failure` is not one class. `normalizeLocalityForKey` — the fold `constraint-census` keys with — was
measured correct (NFKD, strip combining marks, lowercase, strip `.,'’`, collapse whitespace), so the
denominator is NOT contaminated by a diacritic bug. What it does do is keep hyphens and drop periods, and
that produces three distinct failures. Record which one each row is:

| Sub-mechanism       | Board row        | Folds to         | Register likely holds |
| ------------------- | ---------------- | ---------------- | --------------------- |
| `fold_hyphen`       | `Tel Aviv-Yafo`  | `tel aviv-yafo`  | `tel aviv yafo`       |
| `fold_admin_suffix` | `São Paulo - SP` | `sao paulo - sp` | `sao paulo`           |
| `fold_designator`   | `Co. Westmeath`  | `co westmeath`   | `westmeath`           |

For every row you classify `fold_failure`, confirm it by probing the gazetteer for the same place under a repaired surface. Use the `mwdev_lookup` MCP tool. A row you cannot confirm is `unknown`, not `fold_failure` — a magnitude never carries its own absence.

- [ ] **Step 5: Write the verdict**

Write `scratchpad/2026-08-21-coverage-miss-decomposition.md` containing: the five class counts, the denominator (96 locality-band rows), every `fold_failure` row with its confirming probe, and one of two verdicts stated explicitly:

- **PROCEED** — mis-tags outnumber fold failures. Negative evidence has a real target. Continue to Task 2.
- **STOP AND REPAIR THE FOLD** — fold failures dominate. Tasks 5–7 and 9–10 do not get built; the plan continues to Task 2, 3, 4, 8 (the vocabulary and derivation are useful regardless) and a new fold-repair plan is written.

- [ ] **Step 6: Commit**

```bash
git add scratchpad/2026-08-21-coverage-miss-decomposition.md
git commit -m "evidence: decompose the board's 187 coverage misses before building an exclusion"
```

---

## Task 2: `@mailwoman/evidence` workspace, typed union, epistemic status

**Files:**

- Create: `packages/evidence/package.json`
- Create: `packages/evidence/tsconfig.json`
- Create: `packages/evidence/tsconfig.test.json`
- Create: `packages/evidence/index.ts`
- Create: `packages/evidence/status.ts`
- Create: `packages/evidence/evidence.ts`
- Create: `packages/evidence/evidence.test.ts`
- Modify: `package.json` (root `workspaces` array)
- Modify: `tsconfig.json` (root `references`)
- Modify: `.release-it.json` (publish list)

**Interfaces:**

- Consumes: nothing
- Produces:
  - `type EpistemicStatus = "designated" | "observed" | "derived" | "inferred" | "unresolved"` and the `EpistemicStatus` const object
  - `type Assertion = "authoritative" | "inferred"` and the `Assertion` const object
  - `interface Observation { kind: "observation"; source: string; vintage: string; value: unknown }`
  - `interface Relation { kind: "relation"; source: string; vintage: string; relationship: string; assertion: Assertion; score?: number }`
  - `interface Prior { kind: "prior"; source: string; label: string; weight: number }`
  - `function observation(source: string, vintage: string, value: unknown): Observation`
  - `function relation(input: { source: string; vintage: string; relationship: string; assertion: Assertion; score?: number }): Relation`
  - `function prior(source: string, label: string, weight: number): Prior`

- [ ] **Step 1: Write the failing test**

Create `packages/evidence/evidence.test.ts`:

```ts
import { describe, expect, it } from "vitest"

import { Assertion, observation, prior, relation } from "./index.ts"

describe("evidence constructors", () => {
	it("an observation carries source and vintage and never a score", () => {
		const e = observation("os-open-uprn", "2026-08", { uprn: 100_023_336_956 })

		expect(e.kind).toBe("observation")
		expect(e.source).toBe("os-open-uprn")
		expect(e.vintage).toBe("2026-08")
		expect(e).not.toHaveProperty("score")
	})

	it("a prior carries a weight and cannot claim a vintage it does not have", () => {
		const e = prior("population", "urbanisation", 0.4)

		expect(e.kind).toBe("prior")
		expect(e.weight).toBe(0.4)
	})

	// filer.db enforces this in SQL (`filer_family_match_score_inferred_only`). The same rule has to
	// hold here or the two disagree the moment a caller builds a Relation outside the database.
	it("an authoritative relation REFUSES a score", () => {
		expect(() =>
			relation({
				source: "edgar-exhibit-21",
				vintage: "2026-08-07",
				relationship: "subsidiary",
				assertion: Assertion.Authoritative,
				score: 0.9,
			})
		).toThrow(/authoritative relation cannot carry a score/i)
	})

	it("an inferred relation accepts a score", () => {
		const e = relation({
			source: "form-499",
			vintage: "2025-12-07",
			relationship: "parent_company",
			assertion: Assertion.Inferred,
			score: 0.82,
		})

		expect(e.assertion).toBe("inferred")
		expect(e.score).toBe(0.82)
	})
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run packages/evidence/evidence.test.ts`
Expected: FAIL — cannot resolve `./index.ts`.

- [ ] **Step 3: Create the package manifest**

Create `packages/evidence/package.json`:

```json
{
	"name": "@mailwoman/evidence",
	"version": "9.1.0",
	"description": "The typed-evidence contract — observation, exclusion, relation and prior, the epistemic-status axis, the coverage-basis exclusion gate, and the derivation graph. Pure, zero-runtime-dep: the shared home every claim-type package reaches for.",
	"license": "AGPL-3.0-only OR LicenseRef-Commercial",
	"repository": {
		"type": "git",
		"url": "https://github.com/sister-software/mailwoman.git",
		"directory": "packages/evidence"
	},
	"files": ["out/**/*.js", "out/**/*.js.map", "out/**/*.d.ts", "out/**/*.d.ts.map", "*.ts", "!*.test.ts"],
	"type": "module",
	"exports": {
		"./package.json": "./package.json",
		".": {
			"node": "./index.ts",
			"default": "./out/index.js",
			"types": "./out/index.d.ts"
		}
	},
	"publishConfig": {
		"access": "public"
	}
}
```

Note the absence of a `dependencies` block. That is the point of the workspace; do not add one.

- [ ] **Step 4: Create both tsconfigs**

Create `packages/evidence/tsconfig.json`:

```json
{
	"extends": "@sister.software/tsconfig/node",
	"compilerOptions": {
		"outDir": "./out",
		"emitDeclarationOnly": false,
		"rewriteRelativeImportExtensions": true,
		"erasableSyntaxOnly": true
	},
	"include": ["./**/*"],
	"exclude": ["./out/**/*", "./**/*.test.ts"],
	"references": []
}
```

Create `packages/evidence/tsconfig.test.json`:

```json
{
	// Non-emitting companion to ./tsconfig.json — see ../../tsconfig.test-base.json for why it exists.
	"extends": ["./tsconfig.json", "../../tsconfig.test-base.json"],
	"include": ["./**/*.test.ts", "./test/**/*"],
	"exclude": ["./out/**/*"],
	"references": [{ "path": "./tsconfig.json" }]
}
```

- [ ] **Step 5: Write the status module**

Create `packages/evidence/status.ts`:

```ts
/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The epistemic axis — WHAT MAY BE CLAIMED about a value, kept strictly separate from the mechanism that
 *   produced it. A geocode result's `resolution_tier` answers "how was this coordinate produced"
 *   (`address_point`, `interpolated`, …); this answers "what does the evidence permit us to say". A rooftop
 *   matched against a national register the authority declares complete is `designated`; the same rooftop
 *   matched against a crowdsourced extract is `observed`. Same mechanism, different authority, and collapsing
 *   them silently upgrades a source's observation into an authority's designation.
 */

export const EpistemicStatus = {
	/** An authority assigned this. A UPRN, a BAN address, an official postcode. */
	Designated: "designated",
	/** A named source recorded it at a named vintage. An OSM node, an Overture row. */
	Observed: "observed",
	/** Computed from observations by a stated rule — an interpolated house number, a street centroid. */
	Derived: "derived",
	/** No row matched; the value is the intersection of stated constraints. Never presentable as retrieved. */
	Inferred: "inferred",
	/** The evidence does not support a claim. The honest answer, not a failure to try. */
	Unresolved: "unresolved",
} as const

export type EpistemicStatus = (typeof EpistemicStatus)[keyof typeof EpistemicStatus]

/**
 * Whether a relationship is stated by a source or concluded by us.
 *
 * `filer.db` enforces the companion rule in SQL — `filer_family_match_score_inferred_only` — because a match
 * score on an authoritative link means the link was never authoritative. {@link relation} enforces the same
 * rule for callers who build one outside a database.
 */
export const Assertion = {
	Authoritative: "authoritative",
	Inferred: "inferred",
} as const

export type Assertion = (typeof Assertion)[keyof typeof Assertion]
```

- [ ] **Step 6: Write the evidence module**

Create `packages/evidence/evidence.ts`:

```ts
/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The typed evidence union. Four kinds, and the difference between them is what each is ALLOWED to do:
 *
 *   - `observation` — retrieved from a named source at a named vintage. Carries no score; a source either
 *     said it or did not.
 *   - `exclusion` — proves a candidate impossible. Constructed ONLY by `requireExclusionBasis`
 *     (`./coverage.ts`); there is deliberately no exported constructor here, because an exclusion built
 *     without a coverage check is the defect this whole module exists to prevent.
 *   - `relation` — structural compatibility between entities. Carries an assertion, and a score only when
 *     that assertion is `inferred`.
 *   - `prior` — moves probability. Can never, by itself, prove or exclude.
 */

import { Assertion } from "./status.ts"

export interface Observation {
	kind: "observation"
	source: string
	vintage: string
	value: unknown
}

export interface Relation {
	kind: "relation"
	source: string
	vintage: string
	relationship: string
	assertion: Assertion
	score?: number
}

export interface Prior {
	kind: "prior"
	source: string
	label: string
	weight: number
}

export function observation(source: string, vintage: string, value: unknown): Observation {
	return { kind: "observation", source, vintage, value }
}

export function relation(input: {
	source: string
	vintage: string
	relationship: string
	assertion: Assertion
	score?: number
}): Relation {
	if (input.assertion === Assertion.Authoritative && input.score !== undefined) {
		throw new Error(
			`authoritative relation cannot carry a score (${input.relationship} from ${input.source}): a score means the link was concluded, not stated`
		)
	}

	return input.score === undefined
		? {
				kind: "relation",
				source: input.source,
				vintage: input.vintage,
				relationship: input.relationship,
				assertion: input.assertion,
			}
		: {
				kind: "relation",
				source: input.source,
				vintage: input.vintage,
				relationship: input.relationship,
				assertion: input.assertion,
				score: input.score,
			}
}

export function prior(source: string, label: string, weight: number): Prior {
	return { kind: "prior", source, label, weight }
}
```

- [ ] **Step 7: Write the barrel**

Create `packages/evidence/index.ts`:

```ts
/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The typed-evidence contract. Zero runtime dependencies BY DESIGN: `@mailwoman/bdc`,
 *   `@mailwoman/resolver`, `@mailwoman/filer` and `@mailwoman/match` all consume this, and two of them are
 *   leaves. Routing it through `@mailwoman/core` would drag core's shipped data behind every one of them —
 *   the same cost that makes `nuts-lookup` and `timezone-lookup` re-implement a ray cast rather than depend
 *   on `@mailwoman/spatial`. Do not add a dependency here.
 */

export * from "./evidence.ts"
export * from "./status.ts"
```

- [ ] **Step 8: Register the workspace in all four registers**

Add `"packages/evidence"` to the root `package.json` `workspaces` array (append after `"packages/ancestrie"`).

Add to the root `tsconfig.json` `references` array — **both** entries:

```json
{ "path": "./packages/evidence" },
{ "path": "./packages/evidence/tsconfig.test.json" }
```

Add `"packages/evidence"` to `.release-it.json` → `plugins["@release-it-plugins/workspaces"].workspaces`.

- [ ] **Step 9: Verify the registration arithmetic**

```bash
yarn install
node -e "const w=require('./package.json').workspaces,r=require('./.release-it.json').plugins['@release-it-plugins/workspaces'].workspaces;console.log(w.filter(x=>!r.includes(x)))"
```

Expected output: the six known absences only — `docs`, `packages/tile-worker`, `packages/geocode-oracle`, `packages/neural-weights-base-latn`, `packages/dev-mcp`, `packages/osm`. If `packages/evidence` appears, step 8 was incomplete.

```bash
yarn compile
```

Expected: builds clean. A `TS6305: Output file has not been built from source file` means a missing tsconfig reference.

- [ ] **Step 10: Run the test to verify it passes**

Run: `yarn vitest run packages/evidence/evidence.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 11: Lint**

Run: `yarn lint:oxlint`
Expected: no `sister-software/no-title-case-acronym` findings in `packages/evidence/`.

- [ ] **Step 12: Commit**

```bash
git add packages/evidence package.json tsconfig.json .release-it.json yarn.lock
git commit -m "evidence: one vocabulary for what is known and how well it is known

Three packages independently invented an evidence type — bdc/plausibility,
resolver/street-evidence and filer.db — and none can see the others. filer's
is the disciplined one and it is enforced in SQL; relation() lifts that same
rule into the type system for callers who build a link outside a database."
```

---

## Task 3: Move `CoverageBasis` into evidence, add the exclusion gate

`@mailwoman/core/layers` currently owns `CoverageBasis` and `supportsExclusion`. Evidence cannot depend on core, and duplicating the union across both would be exactly the failure AGENTS.md records: "When two copies must agree, share the FUNCTION — sharing the constants proves nothing." So evidence takes ownership and core re-exports.

**Files:**

- Create: `packages/evidence/coverage.ts`
- Create: `packages/evidence/coverage.test.ts`
- Modify: `packages/core/lib/layers/schema.ts` (delete the `CoverageBasis` definition, import + re-export from evidence)
- Modify: `packages/core/lib/layers/manifest.ts` (delete `supportsExclusion`, re-export from evidence)
- Modify: `packages/core/package.json` (add the dependency)
- Modify: `packages/core/tsconfig.json` (add the reference)

**Interfaces:**

- Consumes: `EpistemicStatus` from Task 2
- Produces:
  - `const CoverageBasis` / `type CoverageBasis` — `"designated" | "surveyed" | "source_present"`
  - `function supportsExclusion(cell: { basis?: CoverageBasis | null }): boolean`
  - `function foldIdentity(fold: (s: string) => string): string`
  - `const FOLD_PROBE_CORPUS: readonly string[]`
  - `interface CoverageScope { layer: string; h3Cell: number; basis: CoverageBasis; fold: string }`
  - `interface Exclusion { kind: "exclusion"; source: string; vintage: string; scope: CoverageScope }`
  - `function requireExclusionBasis(input: RequireExclusionInput): Exclusion | null`

**Also in this task:** move `res9ShortCellToRes6Parent` from `packages/bdc/lib/sdk/filing-landscape.ts` to
`@mailwoman/spatial/h3/cell`, generalized over its two resolutions. It currently closes over
`BDC_H3_RESOLUTION` / `BDC_COVERAGE_H3_RESOLUTION`, and Task 5 needs the identical derivation inside
`resolver-wof-sqlite` — importing it from `@mailwoman/bdc` would be the wrong dependency direction. Same
share-the-function rule that moves `CoverageBasis`. Steps 10-12.

- [ ] **Step 1: Write the failing test**

Create `packages/evidence/coverage.test.ts`:

```ts
import { describe, expect, it } from "vitest"

import { CoverageBasis, requireExclusionBasis, supportsExclusion } from "./index.ts"

const BASE = {
	layer: "os-open-uprn",
	source: "os-open-uprn",
	vintage: "2026-08",
	h3Cell: 617_733_122_422_996_991,
	probeFold: "foldStreetSurface@v1",
	layerFold: "foldStreetSurface@v1",
}

describe("supportsExclusion", () => {
	it("admits designated and surveyed, refuses source_present and absent", () => {
		expect(supportsExclusion({ basis: CoverageBasis.Designated })).toBe(true)
		expect(supportsExclusion({ basis: CoverageBasis.Surveyed })).toBe(true)
		expect(supportsExclusion({ basis: CoverageBasis.SourcePresent })).toBe(false)
		expect(supportsExclusion({})).toBe(false)
		expect(supportsExclusion({ basis: null })).toBe(false)
	})
})

describe("requireExclusionBasis", () => {
	it("builds an exclusion when the cell is designated and the folds agree", () => {
		const e = requireExclusionBasis({ ...BASE, cell: { basis: CoverageBasis.Designated } })

		expect(e).not.toBeNull()
		expect(e!.kind).toBe("exclusion")
		expect(e!.scope.basis).toBe("designated")
		expect(e!.scope.layer).toBe("os-open-uprn")
	})

	// The meaning-of-zero rule: a cell nobody surveyed is unknown, and unknown is not absence.
	it("refuses when the cell is missing from layer_coverage", () => {
		expect(requireExclusionBasis({ ...BASE, cell: undefined })).toBeNull()
	})

	it("refuses source_present — the source looked, which is not the source found everything", () => {
		expect(requireExclusionBasis({ ...BASE, cell: { basis: CoverageBasis.SourcePresent } })).toBeNull()
	})

	// The board's `locality=Tel Aviv-Yafo` class: the key "exists nowhere" only under the fold we probed
	// with. An exclusion here is confidently wrong and indistinguishable from a true absence.
	it("refuses when the probe fold differs from the layer's build fold", () => {
		expect(
			requireExclusionBasis({
				...BASE,
				layerFold: "normalizeLocalityForKey@v2",
				cell: { basis: CoverageBasis.Designated },
			})
		).toBeNull()
	})

	it("refuses when the country is outside the probe's scope", () => {
		expect(
			requireExclusionBasis({
				...BASE,
				country: "FR",
				countries: new Set(["GB"]),
				cell: { basis: CoverageBasis.Designated },
			})
		).toBeNull()
	})
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run packages/evidence/coverage.test.ts`
Expected: FAIL — `requireExclusionBasis` is not exported.

- [ ] **Step 3: Write the coverage module**

Create `packages/evidence/coverage.ts`:

```ts
/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The exclusion gate. An {@link Exclusion} is the only evidence kind that can act on an ABSENCE, so it is
 *   the only one with no public constructor: {@link requireExclusionBasis} is the sole way to make one, and
 *   it refuses far more often than it admits.
 *
 *   FOLD PARITY IS A PRECONDITION, not a detail. A key that "exists nowhere" may simply exist under a
 *   surface we did not probe. The 2026-08-21 board decomposition found this class directly — `Tel Aviv-Yafo`,
 *   `São Paulo - SP`, `Co. Westmeath` are all real places reported as coverage misses — and it is
 *   indistinguishable from a true absence at the decision point. `street-evidence.ts` carries the same scar
 *   one layer down: "the 4 v1-policy breaks were fold mismatches: `pillet-will` stored unhyphenated." So the
 *   probe must name the fold it used and the layer must name the fold its builder wrote, and a mismatch is a
 *   refusal rather than an exclusion.
 */

export const CoverageBasis = {
	/**
	 * An authority declares the set complete for this cell — BAN holding every address in a commune, OS
	 * declaring OS Open UPRN complete for GB. A miss inside a designated cell IS evidence of absence.
	 */
	Designated: "designated",
	/**
	 * We measured completeness ourselves against an independent reference, and `completeness` carries that
	 * measurement. A miss is evidence of absence in proportion to the value.
	 */
	Surveyed: "surveyed",
	/**
	 * The source returned rows in this cell and we recorded that. Says nothing about what the source missed.
	 * A miss here is UNKNOWN, never absence.
	 */
	SourcePresent: "source_present",
} as const

export type CoverageBasis = (typeof CoverageBasis)[keyof typeof CoverageBasis]

/**
 * Whether a coverage reading can support an EXCLUSION — a claim that the thing asked for is not there.
 *
 * Presence is supportable from any basis. Absence is not: `source_present` records that the source returned
 * rows, which says nothing about what it missed. Callers building negative evidence must gate on this rather
 * than on `completeness` alone, or an exclusion fires identically on a genuinely empty cell and on one we
 * never surveyed.
 */
export function supportsExclusion(cell: { basis?: CoverageBasis | null }): boolean {
	return cell.basis === CoverageBasis.Designated || cell.basis === CoverageBasis.Surveyed
}

/**
 * What an exclusion rests on, carried into the derivation so a reader can audit the refusal.
 */
export interface CoverageScope {
	layer: string
	h3Cell: number
	basis: CoverageBasis
	/** The fold both the layer's builder and this probe used. Their agreement is what licensed the exclusion. */
	fold: string
}

export interface Exclusion {
	kind: "exclusion"
	source: string
	vintage: string
	scope: CoverageScope
}

export interface RequireExclusionInput {
	layer: string
	source: string
	vintage: string
	h3Cell: number
	/**
	 * The layer's coverage row for this cell. `undefined` means the cell is ABSENT from `layer_coverage`,
	 * which is unknown — never a zero-completeness record (the meaning-of-zero rule).
	 */
	cell: { basis?: CoverageBasis | null } | undefined
	/**
	 * Identity of the fold this probe folded its key with. NOT a hand-written label: three packages already
	 * export a function named `foldName` and all three compute different answers (`Ångström` → `a ngstro m` /
	 * `angstrom` / `angstrom`), so a name is not an identity. Derive it with {@link foldIdentity}.
	 */
	probeFold: string
	/** Identity of the fold the layer's builder wrote its keys with, derived the same way. */
	layerFold: string
	/** The country of the thing being excluded, when the probe is country-scoped. */
	country?: string
	/** ISO-2 upper-case countries this probe can answer for. Omit for an unscoped probe. */
	countries?: ReadonlySet<string>
}

/**
 * The ONLY constructor for an {@link Exclusion}. Returns `null` — never throws — on every refusal, because a
 * refusal is the ordinary case and a caller must fail open to whatever ranking it already had.
 */
export function requireExclusionBasis(input: RequireExclusionInput): Exclusion | null {
	if (!input.cell) return null
	if (!supportsExclusion(input.cell)) return null
	if (input.probeFold !== input.layerFold) return null
	if (input.countries && input.country && !input.countries.has(input.country.toUpperCase())) return null

	const basis = input.cell.basis

	if (!basis) return null

	return {
		kind: "exclusion",
		source: input.source,
		vintage: input.vintage,
		scope: { layer: input.layer, h3Cell: input.h3Cell, basis, fold: input.probeFold },
	}
}
```

- [ ] **Step 4: Add the union member and export**

In `packages/evidence/evidence.ts`, add the import and the union at the end of the file:

```ts
import type { Exclusion } from "./coverage.ts"

export type Evidence = Observation | Exclusion | Relation | Prior
```

In `packages/evidence/index.ts`, add:

```ts
export * from "./coverage.ts"
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `yarn vitest run packages/evidence/coverage.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Move core's definitions to re-exports**

In `packages/core/lib/layers/schema.ts`, delete the `CoverageBasis` const and type declarations (the block beginning `export const CoverageBasis = {`) and replace with:

```ts
// Owned by @mailwoman/evidence so bdc, resolver and filer can gate on the SAME FUNCTION rather than on
// matching copies of the same three strings. The layer_coverage schema and its IO stay here.
export { CoverageBasis } from "@mailwoman/evidence"
```

In `packages/core/lib/layers/manifest.ts`, delete the `supportsExclusion` function body and replace with:

```ts
export { requireExclusionBasis, supportsExclusion } from "@mailwoman/evidence"
```

Keep the `import { CoverageBasis } from "@mailwoman/evidence"` that `manifest.ts` needs for its `basis: c.basis ?? CoverageBasis.SourcePresent` defaults.

- [ ] **Step 7: Wire core's dependency**

In `packages/core/package.json`, add to `dependencies`:

```json
"@mailwoman/evidence": "workspace:*"
```

In `packages/core/tsconfig.json`, add to `references`:

```json
{ "path": "../evidence" }
```

- [ ] **Step 8: Verify nothing downstream broke**

```bash
yarn install
yarn compile
yarn vitest run packages/core/lib/layers
```

Expected: PASS. `packages/core/lib/layers/schema.test.ts` already asserts `supportsExclusion` admits `Designated`/`Surveyed` and refuses `SourcePresent`/absent — those assertions must still pass unchanged, now against the moved implementation.

- [ ] **Step 9: Add `foldIdentity` — a fold is identified by what it computes, not what it is called**

Three packages export a function named `foldName` and no two agree. Measured:

```
input        resolver/fold-name   codex/normalize   un-locode/index
Ångström     a ngstro m           angstrom          angstrom
São Paulo    sa o paulo           sao paulo         sao paulo
Saint-Denis  saint denis          saint denis       saint-denis
Zürich       zu rich              zurich            zurich
```

7 of 8 probe inputs disagree across the three. So `probeFold: "foldName@v1"` identifies nothing. Append to
`packages/evidence/coverage.ts`:

```ts
/**
 * Inputs a fold identity is computed over. Each exercises one axis a fold can differ on: a WORD-INTERNAL
 * diacritic (the axis `resolver/fold-name.ts` gets wrong — it maps the combining mark to a space, splitting
 * the word), a diacritic ADJACENT to punctuation (which hides that bug), hyphens, periods, apostrophes,
 * case, collapsing whitespace, and a non-Latin script. Adding an input changes every identity, which is
 * correct: it is a new distinction two folds may differ on. Never reorder — identity is order-dependent.
 */
export const FOLD_PROBE_CORPUS: readonly string[] = [
	"Besançon",
	"Le Pré-Saint-Gervais",
	"Ångström",
	"São Paulo - SP",
	"Tel Aviv-Yafo",
	"Co. Westmeath",
	"L'Haÿ-les-Roses",
	"  MIXED   Case  ",
	"ХУД - 15 хороо",
	"Đường Trần Hưng Đạo",
]

/**
 * Identify a fold by its BEHAVIOUR over {@link FOLD_PROBE_CORPUS} — a name cannot do this job.
 *
 * Two folds that compute the same answers are interchangeable and share an identity, which is the property
 * the exclusion gate needs: it is asking "was this key built by a fold equivalent to mine", not "were these
 * two functions written in the same file".
 *
 * Deliberately NOT a cryptographic hash: the string is meant to be readable in a derivation and a diff, so a
 * reviewer can see WHICH probe moved when an identity changes.
 */
export function foldIdentity(fold: (s: string) => string): string {
	return FOLD_PROBE_CORPUS.map((probe) => fold(probe)).join("\u0001")
}
```

- [ ] **Step 10: Test that `foldIdentity` separates the three `foldName`s**

Append to `packages/evidence/coverage.test.ts`:

```ts
describe("foldIdentity", () => {
	const resolverFold = (s: string) =>
		s
			.toLowerCase()
			.normalize("NFD")
			.replaceAll(/[^a-z0-9 ]/g, " ")
			.replaceAll(/\s+/g, " ")
			.trim()
	const codexFold = (s: string) =>
		s
			.toLowerCase()
			.normalize("NFD")
			.replaceAll(/[\u0300-\u036F]/g, "")
			.replaceAll(/[^a-z0-9]+/g, " ")
			.trim()

	it("gives three same-named folds three different identities", () => {
		expect(foldIdentity(resolverFold)).not.toBe(foldIdentity(codexFold))
	})

	it("gives two independently-written but equivalent folds the SAME identity", () => {
		const copy = (s: string) =>
			s
				.toLowerCase()
				.normalize("NFD")
				.replaceAll(/[\u0300-\u036F]/gu, "")
				.replaceAll(/[^a-z0-9]+/gu, " ")
				.trim()

		expect(foldIdentity(copy)).toBe(foldIdentity(codexFold))
	})

	it("is stable across calls", () => {
		expect(foldIdentity(codexFold)).toBe(foldIdentity(codexFold))
	})
})
```

Run: `yarn vitest run packages/evidence/coverage.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 11: Move `res9ShortCellToRes6Parent` to `@mailwoman/spatial`**

Add to `packages/spatial/lib/h3/cell.ts`, generalized over both resolutions:

```ts
/**
 * Reconstruct a short-cell int's ancestor at a coarser resolution WITHOUT going through a centroid.
 *
 * The centroid is the wrong input: re-deriving a parent from a stored cell's centre can land in a different
 * parent than the original cell belonged to, so a coverage read and the build that wrote it disagree on a
 * fraction of cells. Reconstructing from the stored cell itself is exact.
 *
 * Lived in `bdc/sdk/filing-landscape.ts` closed over the BDC resolutions until `resolver-wof-sqlite` needed
 * the identical derivation and importing from `@mailwoman/bdc` would have inverted the dependency.
 */
export function shortCellToParentInt(h3CellShortInt: number, from: number, to: number): number {
	const fullCell = expandH3Cell(h3CellShortInt.toString(16) as H3CellShort, from)

	return shortCellToInt(cellToParent(fullCell, to) as H3Cell)
}
```

In `packages/bdc/lib/sdk/filing-landscape.ts`, replace the body of `res9ShortCellToRes6Parent` with a call and
keep the export — its callers (`nearest-infrastructure.ts`, `plausibility.ts`, and its own parity test)
should not have to change in this task:

```ts
export function res9ShortCellToRes6Parent(h3CellShortInt: number): number {
	return shortCellToParentInt(h3CellShortInt, BDC_H3_RESOLUTION, BDC_COVERAGE_H3_RESOLUTION)
}
```

- [ ] **Step 12: Verify the move changed no cell**

```bash
yarn compile
yarn vitest run packages/bdc packages/spatial
```

Expected: PASS. `filing-landscape`'s existing parity test asserts this derivation agrees cell-for-cell with
`build-bdc.ts`'s own coverage-cell derivation — that test is the regression net for this move and must not
be edited.

- [ ] **Step 13: Commit**

```bash
git add packages/evidence packages/core/lib/layers packages/core/package.json packages/core/tsconfig.json packages/spatial packages/bdc/lib/sdk/filing-landscape.ts yarn.lock
git commit -m "evidence: own CoverageBasis, and refuse an exclusion whose fold does not match the layer's

Duplicating the three basis strings across core and evidence would have matched
forever while the gate diverged — the #861 failure. Core re-exports instead.

requireExclusionBasis adds the condition supportsExclusion could not see: a key
that exists nowhere under OUR fold may exist under the layer's. Tel Aviv-Yafo
and Sao Paulo - SP both read as coverage misses on the board and both are real."
```

---

## Task 4: Re-express `plausibilityCheck` — no behaviour change

**Files:**

- Modify: `packages/bdc/lib/sdk/plausibility.ts`
- Modify: `packages/bdc/package.json`
- Modify: `packages/bdc/tsconfig.json`
- Test: `packages/bdc/lib/sdk/plausibility.test.ts` (**must pass unchanged — do not edit it**)

**Interfaces:**

- Consumes: `Observation`, `observation`, `Evidence` from Task 2
- Produces: `PlausibilityEvidence` widened to include the shared kinds; `PlausibilityBundle.coverage_confidence` and `block_resolution` unchanged

- [ ] **Step 1: Run the existing suite and record the baseline**

```bash
yarn compile
yarn vitest run packages/bdc/lib/sdk/plausibility.test.ts
```

Expected: PASS. Record the test count — it must be identical after the change. **The whole acceptance criterion of this task is that this file's assertions never change.**

- [ ] **Step 2: Add the dependency**

In `packages/bdc/package.json` `dependencies`, add `"@mailwoman/evidence": "workspace:*"`.
In `packages/bdc/tsconfig.json` `references`, add `{ "path": "../evidence" }`.

- [ ] **Step 3: Re-express the evidence union**

In `packages/bdc/lib/sdk/plausibility.ts`, change the union so each existing variant also satisfies the shared shape. Keep every existing property name — consumers read `.filing`, `.hit` and `.reason`:

```ts
import type { Evidence } from "@mailwoman/evidence"

export type PlausibilityEvidence =
	| {
			kind: "observation"
			type: "filing"
			source: "bdc"
			vintage: string
			filing: ProviderFilingSummary
			corroborates: boolean
	  }
	| { kind: "observation"; type: "physical_plant"; source: "poi"; vintage: string; hit: InfrastructureHit }
	| { type: "abstain"; reason: PlausibilityAbstainReason; layer?: string }

/**
 * The two non-abstain variants are {@link Evidence} observations wearing their original field names, so a
 * caller that already reads `.filing` keeps working while a caller that wants the shared vocabulary can
 * narrow on `kind`. The abstain variant deliberately does NOT join the union: an abstain is the ABSENCE of
 * evidence plus a reason, which `coverage_confidence` already reports, and minting an evidence object for
 * "we could not look" would put a claim where there is none.
 */
export type PlausibilitySharedEvidence =
	Extract<PlausibilityEvidence, { kind: "observation" }> extends Evidence
		? Extract<PlausibilityEvidence, { kind: "observation" }>
		: never
```

- [ ] **Step 4: Populate the new fields at every construction site**

Find each place the module pushes into `evidence` and add `kind`, `source` and (for the physical variant) `vintage`. The filing variant already carries `vintage`; the physical one must take it from the poi layer manifest already read for `coverage_detail`.

- [ ] **Step 5: Run the suite to verify it passes UNCHANGED**

```bash
yarn compile
yarn vitest run packages/bdc/lib/sdk/plausibility.test.ts
```

Expected: PASS with the same test count as Step 1, and **zero edits to the test file**. If a test needed changing, the re-expression changed behaviour and must be redone.

- [ ] **Step 6: Commit**

```bash
git add packages/bdc yarn.lock
git commit -m "bdc: say plausibility's evidence in the shared vocabulary, same answers

The suite is the acceptance criterion and it is untouched. An abstain stays
out of the evidence union on purpose: it is the absence of evidence plus a
reason, and coverage_confidence already carries that."
```

---

## Task 5: Give `UPRNLookup`'s `null` its coverage scope

**Gated on Task 1 returning PROCEED.**

The probe already exists. `packages/resolver-wof-sqlite/lib/uprn-lookup.ts` ships `UPRNLookup` with
`coordinateOf(uprn)` and `nearestUPRN(latitude, longitude, radiusM)` — a bounded ring-walk over the res-9
`h3_cell` index whose rings "stop as soon as geometry proves no unprobed cell could beat the best hit",
capped at `UPRN_MAX_NEAREST_RADIUS_M = 10_000`, with an integration test. Its own docstring already states
this task's requirement:

> callers building negative evidence must consult `readLayerCoverage`, not this reader alone.

So this task does not build a probe. It does the consult, and it puts the answer in the type so a caller
cannot skip it.

**Files:**

- Create: `packages/resolver-wof-sqlite/uprn-existence.ts`
- Create: `packages/resolver-wof-sqlite/uprn-existence.test.ts`
- Modify: `packages/resolver-wof-sqlite/package.json` (add `@mailwoman/evidence`)
- Modify: `packages/resolver-wof-sqlite/tsconfig.json` (add the reference)

**Interfaces:**

- Consumes: `requireExclusionBasis`, `foldIdentity`, `CoverageBasis`, `Exclusion` from Task 3; `shortCellToParentInt` from Task 3 step 11; the existing `UPRNLookup`, `UPRN_H3_RESOLUTION`, `UPRN_COVERAGE_H3_RESOLUTION`, `uprnH3Cell`
- Produces:
  - `const UPRN_EXISTENCE_FOLD: string` — the identity of the point-keying used by both builder and probe
  - `function uprnAbsenceAt(input: { lookup: UPRNLookup; contractDB: Kysely<LayerContractDatabase>; latitude: number; longitude: number; radiusM: number; country?: string }): Promise<Exclusion | null>`

- [ ] **Step 1: Write the failing test**

Create `packages/resolver-wof-sqlite/uprn-existence.test.ts`. Build a scratch fixture — the real `uprn.db`
is build-local and a test must never require it:

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { CoverageBasis } from "@mailwoman/evidence"
import { afterAll, describe, expect, it } from "vitest"

import { uprnAbsenceAt } from "./uprn-existence.ts"
import { UPRNLookup } from "./uprn-lookup.ts"
import { uprnH3Cell } from "./uprn-schema.ts"

const dir = mkdtempSync(join(tmpdir(), "uprn-existence-"))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Westminster holds a point; Edinburgh is covered and empty; New York is outside coverage entirely. */
const WESTMINSTER = { latitude: 51.5007, longitude: -0.1246 }
const EDINBURGH = { latitude: 55.9533, longitude: -3.1883 }
const NEW_YORK = { latitude: 40.7128, longitude: -74.006 }

function fixture(name: string, basis: CoverageBasis): string {
	const path = join(dir, name)
	const db = new DatabaseSync(path)

	db.exec(
		`CREATE TABLE uprn (uprn INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL, h3_cell INTEGER NOT NULL);
		 CREATE INDEX idx_uprn_cell ON uprn (h3_cell);
		 CREATE TABLE layer_coverage (h3_cell INTEGER PRIMARY KEY, completeness REAL NOT NULL, basis TEXT, observed_rows INTEGER NOT NULL);
		 CREATE TABLE layer_manifest (name TEXT PRIMARY KEY, version TEXT NOT NULL, schema_version INTEGER NOT NULL, tier TEXT NOT NULL, license TEXT NOT NULL, attribution TEXT, source TEXT NOT NULL, source_vintage TEXT NOT NULL, build_cmd TEXT NOT NULL, build_sha TEXT NOT NULL, freshness_policy TEXT NOT NULL, spine_keys TEXT NOT NULL, created_at TEXT NOT NULL);`
	)

	db.prepare(`INSERT INTO uprn VALUES (?, ?, ?, ?)`).run(
		1,
		WESTMINSTER.latitude,
		WESTMINSTER.longitude,
		uprnH3Cell(WESTMINSTER.latitude, WESTMINSTER.longitude)
	)

	// Both cells are COVERED. Only one holds a point — that is the whole distinction under test.
	for (const p of [WESTMINSTER, EDINBURGH]) {
		db.prepare(`INSERT OR IGNORE INTO layer_coverage VALUES (?, 1.0, ?, 1)`).run(coverageCellFor(p), basis)
	}

	db.prepare(
		`INSERT INTO layer_manifest VALUES ('os-open-uprn','2026-08',1,'build-local','OGL-UK-3.0',NULL,'os-open-uprn','2026-08','buildUPRNLayer','test','sealed','{}','2026-08-18T00:00:00.000Z')`
	).run()
	db.close()

	return path
}
```

`coverageCellFor` is `shortCellToParentInt(uprnH3Cell(lat, lon), UPRN_H3_RESOLUTION, UPRN_COVERAGE_H3_RESOLUTION)` —
import it rather than inlining the arithmetic, so the fixture and the implementation cannot disagree.

```ts
describe("uprnAbsenceAt", () => {
	it("an empty DESIGNATED cell yields an exclusion", async () => {
		using lookup = new UPRNLookup(fixture("designated.db", CoverageBasis.Designated))
		const e = await uprnAbsenceAt({ ...deps(lookup), ...EDINBURGH, radiusM: 250 })

		expect(e).not.toBeNull()
		expect(e!.scope.basis).toBe("designated")
		expect(e!.scope.layer).toBe("os-open-uprn")
		// Vintage comes from the shard's own manifest, never a literal.
		expect(e!.vintage).toBe("2026-08")
	})

	it("a point within the radius yields null — presence is not this probe's business", async () => {
		using lookup = new UPRNLookup(fixture("present.db", CoverageBasis.Designated))

		expect(await uprnAbsenceAt({ ...deps(lookup), ...WESTMINSTER, radiusM: 250 })).toBeNull()
	})

	it("an empty SOURCE_PRESENT cell yields null — the gate refuses regardless of emptiness", async () => {
		using lookup = new UPRNLookup(fixture("sourcepresent.db", CoverageBasis.SourcePresent))

		expect(await uprnAbsenceAt({ ...deps(lookup), ...EDINBURGH, radiusM: 250 })).toBeNull()
	})

	it("a point outside any covered cell yields null — unsurveyed is unknown, not absence", async () => {
		using lookup = new UPRNLookup(fixture("outside.db", CoverageBasis.Designated))

		expect(await uprnAbsenceAt({ ...deps(lookup), ...NEW_YORK, radiusM: 250 })).toBeNull()
	})

	it("a non-GB country yields null even inside a covered cell", async () => {
		using lookup = new UPRNLookup(fixture("scoped.db", CoverageBasis.Designated))

		expect(await uprnAbsenceAt({ ...deps(lookup), ...EDINBURGH, radiusM: 250, country: "FR" })).toBeNull()
	})
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run packages/resolver-wof-sqlite/uprn-existence.test.ts`
Expected: FAIL — cannot resolve `./uprn-existence.ts`.

- [ ] **Step 3: Add the dependency**

In `packages/resolver-wof-sqlite/package.json` `dependencies`, add `"@mailwoman/evidence": "workspace:*"`.
In `packages/resolver-wof-sqlite/tsconfig.json` `references`, add `{ "path": "../evidence" }`.

- [ ] **Step 4: Implement the consult**

Create `packages/resolver-wof-sqlite/uprn-existence.ts`. It is thin by construction — `nearestUPRN` does the
search, `readLayerCoverage` does the coverage read, `requireExclusionBasis` does the gating:

```ts
/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The consult `uprn-lookup.ts`'s docstring instructs: "callers building negative evidence must consult
 *   `readLayerCoverage`, not this reader alone." A bare `null` from `nearestUPRN` is two different facts —
 *   no UPRN here, or nobody surveyed here — and this is the only place that separates them.
 *
 *   `radiusM` is a CALLER'S parameter with no default. There is no radius that is correct for both "which
 *   property is this coordinate" and "is this street built at all", and picking one here would bury that
 *   choice where nobody reviewing an exclusion can see it.
 */

export const UPRN_EXISTENCE_FOLD = foldIdentity((s) => s)
```

`UPRN_EXISTENCE_FOLD` uses the identity fold deliberately: this probe keys on a COORDINATE, not a name, so
there is no string folding to disagree about. Passing the same identity as both `probeFold` and `layerFold`
records that the fold axis is not in play here, rather than silently omitting the check. Say so in the
comment — a future reader will otherwise read it as a stub.

The function:

1. `const cell = uprnH3Cell(latitude, longitude)` then `shortCellToParentInt(cell, UPRN_H3_RESOLUTION, UPRN_COVERAGE_H3_RESOLUTION)`.
2. `const coverage = await readLayerCoverage(contractDB, coverageCell)` — `undefined` means absent.
3. `if (lookup.nearestUPRN(latitude, longitude, radiusM)) return null` — a hit is presence; nothing to say.
4. `const manifest = await readLayerManifest(contractDB)` for `source` and `sourceVintage`, read once by the caller and passed in if this is hot.
5. `return requireExclusionBasis({ layer: manifest.name, source: manifest.source, vintage: manifest.sourceVintage, h3Cell: coverageCell, cell: coverage, probeFold: UPRN_EXISTENCE_FOLD, layerFold: UPRN_EXISTENCE_FOLD, country, countries: new Set(["GB"]) })`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `yarn compile && yarn vitest run packages/resolver-wof-sqlite/uprn-existence.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Verify against the real shard**

`uprn.db` is build-local, so this is a manual check rather than a test. Confirm the two cases the fixture
cannot: a real GB postcode centroid inside coverage returns `null` (points exist there), and a Northern
Ireland coordinate returns `null` for the OTHER reason (NI is outside OS Open UPRN coverage — the
`uprn-lookup.ts` docstring names it). If NI returns an exclusion, the coverage read is wrong.

- [ ] **Step 7: Commit**

```bash
git add packages/resolver-wof-sqlite/uprn-existence.ts packages/resolver-wof-sqlite/uprn-existence.test.ts packages/resolver-wof-sqlite/package.json packages/resolver-wof-sqlite/tsconfig.json yarn.lock
git commit -m "resolver-wof-sqlite: separate uprn's two nulls

nearestUPRN already answers 'no UPRN within the radius' with a bounded ring
walk, and its docstring already says a caller building negative evidence must
consult readLayerCoverage rather than trust that null alone. Nothing did. This
is that consult, and it returns an Exclusion or nothing so a caller cannot
accidentally read an unsurveyed cell as an empty one.

Northern Ireland is the case that proves it: outside OS Open UPRN coverage, so
a null there is unknown and must never become evidence of absence."
```

---

## Task 6: Demote-only negative mode in `pickByStreetEvidence`

**Gated on Task 1 returning PROCEED.**

**Files:**

- Modify: `packages/resolver/lib/street-evidence.ts`
- Modify: `packages/resolver/package.json`
- Modify: `packages/resolver/tsconfig.json`
- Test: `packages/resolver/street-evidence.test.ts`

**Interfaces:**

- Consumes: `Exclusion` from Task 3
- Produces: `PickByStreetEvidenceOpts` gains `exclusions?: ReadonlyArray<Exclusion | null>`; `StreetEvidencePick` gains `demoted: number[]`

- [ ] **Step 1: Write the failing test**

Append to `packages/resolver/street-evidence.test.ts`:

```ts
describe("demote-only exclusions", () => {
	const evidence: StreetLocalityEvidence = {
		hasStreetName: () => false,
		countries: new Set(["GB"]),
	}

	const exclusion = {
		kind: "exclusion" as const,
		source: "os-open-uprn",
		vintage: "2026-08",
		scope: { layer: "os-open-uprn", h3Cell: 1, basis: "designated" as const, fold: "uprn-point@res9" },
	}

	it("an exclusion on rank-1 promotes rank-2 without deleting rank-1", () => {
		const candidates = [
			{ streetSurface: "Avenida Corrientes", score: 10 },
			{ streetSurface: "Turner Street", score: 9 },
		]
		const pick = pickByStreetEvidence(candidates, evidence, { exclusions: [exclusion, null] })

		expect(pick.index).toBe(1)
		expect(pick.moved).toBe(true)
		expect(pick.demoted).toEqual([0])
		// The candidate array is never mutated and nothing is removed.
		expect(candidates).toHaveLength(2)
	})

	it("a null exclusion changes nothing — fail open", () => {
		const candidates = [
			{ streetSurface: "Avenida Corrientes", score: 10 },
			{ streetSurface: "Turner Street", score: 9 },
		]
		const pick = pickByStreetEvidence(candidates, evidence, { exclusions: [null, null] })

		expect(pick.index).toBe(0)
		expect(pick.demoted).toEqual([])
	})

	it("every candidate excluded still returns rank-1 — an exclusion never empties the set", () => {
		const candidates = [
			{ streetSurface: "Avenida Corrientes", score: 10 },
			{ streetSurface: "Turner Street", score: 9 },
		]
		const pick = pickByStreetEvidence(candidates, evidence, { exclusions: [exclusion, exclusion] })

		expect(pick.index).toBe(0)
		expect(pick.demoted).toEqual([0, 1])
	})

	it("omitting exclusions entirely reproduces the v2 policy byte-for-byte", () => {
		const candidates = [
			{ streetSurface: "rue de la Paix", score: 10 },
			{ streetSurface: "rue Pillet-Will", score: 9 },
		]

		expect(pickByStreetEvidence(candidates, evidence, {})).toEqual(pickByStreetEvidence(candidates, evidence))
	})
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run packages/resolver/street-evidence.test.ts`
Expected: FAIL — `exclusions` is not a known option; `demoted` is not on the pick.

- [ ] **Step 3: Add the dependency**

In `packages/resolver/package.json` `dependencies`, add `"@mailwoman/evidence": "workspace:*"`.
In `packages/resolver/tsconfig.json` `references`, add `{ "path": "../evidence" }`.

- [ ] **Step 4: Implement the demotion**

In `packages/resolver/lib/street-evidence.ts`:

Add to `PickByStreetEvidenceOpts`:

```ts
	/**
	 * One entry per candidate, positionally aligned. A non-null entry DEMOTES that candidate by one bit — it is
	 * considered only after every un-excluded sibling. It is never removed: with every candidate excluded the
	 * pick is still rank-1, because the worst case this policy accepts is the model's own ranking.
	 *
	 * Omitted or all-null reproduces the measured v2 policy exactly.
	 */
	exclusions?: ReadonlyArray<Exclusion | null>
```

Add to `StreetEvidencePick`:

```ts
	/**
	 * Indices an exclusion demoted, in input order. Empty when no exclusion applied — a loggable record of what
	 * the coverage gate actually licensed, distinct from what evidence found.
	 */
	demoted: number[]
```

In the body: build the demoted index set first, then run the existing G1/G2 loop over the un-excluded candidates in their original order; if that finds no pick, run it again over the excluded ones; if still none, return rank-1. **Do not blend the exclusion into `score`** — the anti-Pelias rule is one bit, not a weight.

- [ ] **Step 5: Run the test to verify it passes**

Run: `yarn vitest run packages/resolver/street-evidence.test.ts`
Expected: PASS, including every pre-existing test unchanged.

- [ ] **Step 6: Run the gauntlet for regression**

Run the `mwdev_gate` MCP tool. Expected: 369 rows, no regression against the recorded baseline.

- [ ] **Step 7: Commit**

```bash
git add packages/resolver yarn.lock
git commit -m "resolver: let a coverage-licensed absence demote a sibling, never delete one

One bit into the existing fold, positionally aligned, and with every candidate
excluded the pick is still rank-1. The failure mode we already have is visible
at 10,000 km; an engine that fails at 2 km is the one we called worse."
```

---

## Task 7: `epistemic_status` on `GeocodeResult`

**Files:**

- Modify: `packages/mailwoman/lib/geocode-core.ts`
- Test: `packages/mailwoman/geocode-core.test.ts`

**Interfaces:**

- Consumes: `EpistemicStatus` from Task 2
- Produces: `GeocodeResult.epistemic_status: EpistemicStatus`

- [ ] **Step 1: Write the failing test**

Append to `packages/mailwoman/geocode-core.test.ts`:

```ts
describe("epistemic_status", () => {
	it("is unresolved when no coordinate was produced", async () => {
		const result = await geocode("qqqqzzzz nowhere at all")

		expect(result.lat).toBeNull()
		expect(result.epistemic_status).toBe("unresolved")
	})

	it("is derived for an interpolated tier — a rule computed it, no authority assigned it", async () => {
		const result = await geocodeFixtureAtTier("interpolated")

		expect(result.resolution_tier).toBe("interpolated")
		expect(result.epistemic_status).toBe("derived")
	})

	// The axes are orthogonal: the mechanism is the same, the authority is not.
	it("separates mechanism from authority", async () => {
		const result = await geocodeFixtureAtTier("admin")

		expect(result.resolution_tier).toBe("admin")
		expect(result.epistemic_status).toBe("observed")
	})
})
```

Use the fixture helpers already present in that file; if none matches, build the result through the same path the neighbouring tests use rather than inventing a new harness.

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn compile && yarn vitest run packages/mailwoman/geocode-core.test.ts`
Expected: FAIL — `epistemic_status` is undefined.

- [ ] **Step 3: Add the field and its derivation**

In `packages/mailwoman/lib/geocode-core.ts`, add to `GeocodeResult` immediately after `resolution_tier`:

```ts
/**
 * WHAT MAY BE CLAIMED about this coordinate, orthogonal to {@link resolution_tier}, which says how it was
 * PRODUCED. A rooftop matched against a register its authority declares complete is `designated`; the same
 * rooftop matched against a crowdsourced extract is `observed`. Same tier, different authority — and
 * reporting only the tier silently upgrades one into the other.
 */
epistemic_status: EpistemicStatus
```

Derive it where `uncertaintyM` is currently derived (around `geocode-core.ts:1412`):

- no coordinate → `Unresolved`
- the answering layer's coverage row is `designated` → `Designated`
- tier is `interpolated` or `plus_code` → `Derived`
- otherwise → `Observed`

`Inferred` is not producible yet; no task in this plan emits it. Leave it defined and unused rather than repurposing another value.

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn compile && yarn vitest run packages/mailwoman/geocode-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Check the drop-in surfaces still serialize**

Run: `yarn vitest run packages/photon packages/nominatim packages/api`
Expected: PASS. A new required field on `GeocodeResult` reaches every drop-in's passthrough.

- [ ] **Step 6: Commit**

```bash
git add packages/mailwoman/lib/geocode-core.ts packages/mailwoman/geocode-core.test.ts
git commit -m "geocode: report what the evidence permits, beside how the coordinate was made

resolution_tier was answering two questions. A UPRN rooftop and an OSM rooftop
are both address_point and only one of them was assigned by an authority."
```

---

## Task 8: Derivation projection from `ResolveNodeTrace`

**Files:**

- Create: `packages/evidence/derivation.ts`
- Create: `packages/evidence/derivation.test.ts`
- Modify: `packages/evidence/index.ts`
- Modify: `packages/mailwoman/lib/geocode-core.ts`

**Interfaces:**

- Consumes: `Evidence`, `EpistemicStatus` from Tasks 2–3
- Produces:
  - `interface DerivationNode { label: string; evidence: Evidence; contribution: string }`
  - `interface DerivationProjection { status: EpistemicStatus; constraints: DerivationNode[]; uncertaintyM: number | null }`
  - `function projectDerivation(input: { status: EpistemicStatus; nodes: DerivationNode[]; uncertaintyM: number | null }): DerivationProjection`

- [ ] **Step 1: Write the failing test**

Create `packages/evidence/derivation.test.ts`:

```ts
import { describe, expect, it } from "vitest"

import { CoverageBasis, EpistemicStatus, observation, projectDerivation, requireExclusionBasis } from "./index.ts"

describe("projectDerivation", () => {
	it("names every constraint and its contribution in order", () => {
		const p = projectDerivation({
			status: EpistemicStatus.Observed,
			uncertaintyM: 2100,
			nodes: [
				{ label: "locality", evidence: observation("wof", "2026-05", { id: 101750367 }), contribution: "resolved" },
				{
					label: "street",
					evidence: requireExclusionBasis({
						layer: "os-open-uprn",
						source: "os-open-uprn",
						vintage: "2026-08",
						h3Cell: 1,
						cell: { basis: CoverageBasis.Designated },
						probeFold: "uprn-point@res9",
						layerFold: "uprn-point@res9",
					})!,
					contribution: "excluded against a designated cell",
				},
			],
		})

		expect(p.status).toBe("observed")
		expect(p.constraints).toHaveLength(2)
		expect(p.constraints[1]!.evidence.kind).toBe("exclusion")
		expect(p.uncertaintyM).toBe(2100)
	})

	it("an unresolved projection carries no uncertainty rather than a fabricated one", () => {
		const p = projectDerivation({ status: EpistemicStatus.Unresolved, nodes: [], uncertaintyM: null })

		expect(p.status).toBe("unresolved")
		expect(p.uncertaintyM).toBeNull()
		expect(p.constraints).toEqual([])
	})
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run packages/evidence/derivation.test.ts`
Expected: FAIL — `projectDerivation` is not exported.

- [ ] **Step 3: Implement the projection**

Create `packages/evidence/derivation.ts` with the three types above and a `projectDerivation` that returns a frozen structure. It is a pure shaping function — no I/O, no defaults invented for missing inputs. Export it from `index.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn vitest run packages/evidence/derivation.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Wire the opt-in field**

In `packages/mailwoman/lib/geocode-core.ts`, add to `GeocodeResult`:

```ts
	/**
	 * The derivation behind this answer, present only when the caller asked for it. Projected from the
	 * resolver-interior trace (#1721) rather than separately recorded — with no trace sink the walk does zero
	 * bookkeeping and stays byte-identical, and that property is what makes this safe to ship on by default
	 * for debug surfaces and off everywhere else.
	 */
	derivation?: DerivationProjection
```

Populate it only when the caller supplied a trace sink. **Never populate it by turning the sink on yourself** — that would make the opt-in cost unconditional.

- [ ] **Step 6: Pin no-sink-no-effect**

Add to `packages/resolver/resolve-trace.test.ts`:

```ts
it("a walk with no sink resolves byte-identically to one whose sink is discarded", async () => {
	const withoutSink = await resolveFixture({})
	const records: ResolveNodeTrace[] = []
	const withSink = await resolveFixture({ traceSink: (r) => records.push(r) })

	expect(withoutSink).toEqual(withSink)
	expect(records.length).toBeGreaterThan(0)
})
```

Use the fixture helper already in that file.

- [ ] **Step 7: Run both suites**

Run: `yarn compile && yarn vitest run packages/evidence packages/resolver/resolve-trace.test.ts packages/mailwoman/geocode-core.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/evidence packages/mailwoman/lib/geocode-core.ts packages/resolver/resolve-trace.test.ts
git commit -m "evidence: project the derivation from the trace we already record

#1721 records the candidates, the per-stage ranks and every gate, with no sink
meaning no bookkeeping. The derivation is a projection of that, so an inferred
answer cannot be reported as a retrieved one without the record disagreeing."
```

---

## Task 9: US block completeness — Census H1 into `pl_block`

**Files:**

- Modify: `packages/tiger/lib/sdk/schema.ts` (three columns on `PLBlockTable` and its DDL)
- Modify: `packages/tiger/lib/sdk/redistricting.ts` (read segment 2)
- Test: `packages/tiger/lib/sdk/redistricting.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks
- Produces: `PLBlockTable` gains `housing_units: number`, `occupied: number`, `vacant: number`

- [ ] **Step 1: Write the failing test**

Create or append to `packages/tiger/lib/sdk/redistricting.test.ts`. Test the field-offset parsing against a synthetic segment-2 line rather than downloading a state:

```ts
import { describe, expect, it } from "vitest"

import { H1_OCCUPIED, H1_TOTAL, H1_VACANT, parseH1 } from "./redistricting.ts"

describe("H1 field offsets", () => {
	// Verified against the real file: ca000022020.pl has 152 fields and its state row's last three are
	// 14,392,140 / 13,475,623 / 916,517 — the published CA 2020 figures.
	it("reads total, occupied and vacant from the tail of segment 2", () => {
		const fields = new Array(152).fill("0")
		fields[0] = "PLST"
		fields[1] = "CA"
		fields[4] = "0000001"
		fields[H1_TOTAL] = "14392140"
		fields[H1_OCCUPIED] = "13475623"
		fields[H1_VACANT] = "916517"

		expect(parseH1(fields)).toEqual({ housing_units: 14392140, occupied: 13475623, vacant: 916517 })
	})

	it("occupied plus vacant equals the total — the invariant that proves the offsets", () => {
		const fields = new Array(152).fill("0")
		fields[H1_TOTAL] = "14392140"
		fields[H1_OCCUPIED] = "13475623"
		fields[H1_VACANT] = "916517"

		const h1 = parseH1(fields)

		expect(h1.occupied + h1.vacant).toBe(h1.housing_units)
	})
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run packages/tiger/lib/sdk/redistricting.test.ts`
Expected: FAIL — `parseH1` is not exported.

- [ ] **Step 3: Add the columns**

In `packages/tiger/lib/sdk/schema.ts`, add to `PLBlockTable`:

```ts
/** P.L. 94-171 table H1 — total housing units in the block. */
housing_units: number
/** H1 occupied. `occupied + vacant === housing_units` by construction; the test pins it. */
occupied: number
/** H1 vacant. */
vacant: number
```

And to the `createTable("pl_block")` chain, before `.modifyEnd(...)`:

```ts
		.addColumn("housing_units", "integer", (c) => c.notNull())
		.addColumn("occupied", "integer", (c) => c.notNull())
		.addColumn("vacant", "integer", (c) => c.notNull())
```

- [ ] **Step 4: Read segment 2**

In `packages/tiger/lib/sdk/redistricting.ts`, add beside the existing offset constants:

```ts
/**
 * Segment 2: FILEID|STUSAB|CHARITER|CIFSN|LOGRECNO(4)| P3×71 | P4×73 | H1×3 — 152 fields, H1 at the tail.
 * Verified against the real file: `ca000022020.pl`'s state row reads 14,392,140 / 13,475,623 / 916,517,
 * matching the published CA 2020 figures. `occupied + vacant === housing_units` is the invariant that
 * distinguishes a correct offset from a plausible one.
 */
const SEG2_FIELD_COUNT = 152
export const H1_TOTAL = SEG2_FIELD_COUNT - 3
export const H1_OCCUPIED = SEG2_FIELD_COUNT - 2
export const H1_VACANT = SEG2_FIELD_COUNT - 1

export function parseH1(fields: string[]): { housing_units: number; occupied: number; vacant: number } {
	return {
		housing_units: Number(fields[H1_TOTAL] ?? 0),
		occupied: Number(fields[H1_OCCUPIED] ?? 0),
		vacant: Number(fields[H1_VACANT] ?? 0),
	}
}
```

Extract `seg2Path` beside `seg1Path` (`${fileAbbr}00002${vintage}.pl`), then add a pass that reads segment 2 into a `Map<string, ReturnType<typeof parseH1>>` keyed by GEOID before the existing segment-1 loop, and spread the H1 fields into each `batch.push({...})`. A LOGRECNO present in segment 1 but absent from segment 2 gets zeros — and the loader must `yield` a count of those, because a silent zero here is indistinguishable from a genuinely empty block.

- [ ] **Step 5: Run the test to verify it passes**

Run: `yarn compile && yarn vitest run packages/tiger/lib/sdk/redistricting.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Verify against the real file at county scale**

```bash
node packages/tiger/out/scripts/... # use the CLI: mailwoman tiger redistricting --state 06 --county 037
```

Then confirm the invariant across every loaded block:

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.MAILWOMAN_DATA_ROOT+'/tiger/tiger.db',{readOnly:true});console.log(db.prepare('select count(*) bad from pl_block where occupied + vacant != housing_units').get())"
```

Expected: `{ bad: 0 }`.

- [ ] **Step 7: Commit**

```bash
git add packages/tiger/lib/sdk/schema.ts packages/tiger/lib/sdk/redistricting.ts packages/tiger/lib/sdk/redistricting.test.ts
git commit -m "tiger: carry H1 housing units beside the P2 race counts

The US has no public designated address register, so a US coverage basis has
to be SURVEYED — measured against an independent reference. H1 is that
reference and it is public domain. Three columns and one more segment read;
the ingester, the GEOID join and the cache were already here."
```

---

## Task 10: FR probe — does BAN support a per-commune designation claim?

**This task's deliverable is an answer, not a coverage table.** Do not write `layer_coverage` onto `street-centroids-fr.db` inside this task.

**Files:**

- Create: `scratchpad/2026-08-21-ban-designation-probe.md`

**Interfaces:**

- Consumes: `CoverageBasis` from Task 3 (as vocabulary for the verdict)
- Produces: a verdict, and either a follow-up task or a closed negative result

- [ ] **Step 1: Establish the denominator**

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.MAILWOMAN_DATA_ROOT+'/ban/street-centroids-fr.db',{readOnly:true});console.log(db.prepare('select count(*) streets, count(distinct locality_base) communes from street_centroid').get())"
```

Expected, at the `ban:fr` release `2026-05-18` shard: `{ streets: 2195655, communes: 32539 }`. France has roughly 34,900 communes, so a blanket `designated` would already be false.

- [ ] **Step 2: Find whether BAN publishes a per-commune completeness signal**

Read `packages/ban/lib/sdk/fetch.ts` and `packages/ban/lib/sdk/extract.ts` for fields carried and dropped at ingest. Then check the upstream BAN distribution for a per-commune certification or source field (communes publishing a certified Base Adresse Locale versus communes backfilled from other sources).

- [ ] **Step 3: Write the verdict**

Write `scratchpad/2026-08-21-ban-designation-probe.md` stating one of:

- **DESIGNATED, per commune** — the signal exists and is carried or recoverable. Name the field, the communes it covers, and the ones it does not. A follow-up task writes `layer_coverage` with `basis: designated` for the covered communes only, and NO row for the rest (absent is unknown; never a zero-completeness row).
- **SOURCE_PRESENT only** — no per-commune signal exists. The FR lexical arm does not ship. Record this as a closed negative result so it is not re-proposed.

Either verdict must state what was measured, not what was assumed.

- [ ] **Step 4: Commit**

```bash
git add scratchpad/2026-08-21-ban-designation-probe.md
git commit -m "ban: measure whether BAN designates per commune before claiming it does

32,539 communes in the shard against roughly 34,900 in France. The
CoverageBasis docstring uses BAN as its designated example; this establishes
whether that is true of the data or only of the sentence."
```

---

## Self-review notes

**Spec coverage.** §1 → Tasks 2, 3. §2 three states → Task 1 (measure), Task 3 (fold gate). §3 package → Task 2. §3.1 union → Tasks 2, 3. §3.2 two axes → Task 7. §3.3 gate → Task 3. §3.4 demote-only → Task 6. §4.1 GB → Task 5. §4.2 US → Task 9. §4.3 plausibility → Task 4. §4.4 FR → Task 10. §5 derivation → Task 8. §6 falsifiers → Task 1 (F1), Task 6 step 6 (F3), Task 4 step 5 (F4), Task 8 step 6 (F5). **Gap: falsifier 2** (the GB arm's own board measurement) has no task — it cannot be written until Task 1 returns PROCEED and Task 5 lands, because the arm's shape depends on Task 1's verdict. Write it as a follow-up plan.

**Type consistency.** `requireExclusionBasis` takes `RequireExclusionInput` in Tasks 3, 5 and 8 with the same field names. `Exclusion.scope` is `CoverageScope` throughout. `pickByStreetEvidence` keeps its existing name; `StreetEvidencePick.demoted` is `number[]` in both the test and the interface. `EpistemicStatus` values are lower-case strings in every assertion.

**Codebase survey, 2026-08-21 — what this plan does NOT build because it already exists.** `UPRNLookup`
(`resolver-wof-sqlite/uprn-lookup.ts`) already does the bounded nearest-point search Task 5 was going to
write, and already names the coverage consult as the caller's obligation. `res9ShortCellToRes6Parent`
already exists in `bdc/sdk/filing-landscape.ts` and moves rather than being re-derived.
`normalizeLocalityForKey`'s fold was verified correct, so Task 1's denominator stands.
`eval-harness/fragment-board.ts` is the board falsifier 2 will run on. `match/fellegi-sunter.ts` supplies
`scorePair` / `decide` for the relation side when a later slice needs them.

**Out of scope, found during the same survey.** `packages/resolver/lib/fold-name.ts`'s `foldName` claims to be
diacritic-insensitive and is not — it maps each combining mark to a space, so 6 of 9 French commune pairs
fail the comparison it exists to perform, and its one live call site (`street-tier.ts:516`) DELETES the
locality node on a false mismatch. Separate issue, separate fix; do not fold it into a task here.

**Spec amended.** §3 originally left `CoverageBasis` duplicated across evidence and core. AGENTS.md's parity rule ("share the FUNCTION — sharing the constants proves nothing") forbids that, so Task 3 moves ownership to evidence and re-exports from core. The spec was updated in the same commit as this plan; the two agree.
