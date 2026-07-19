# POI Pipeline (Plan 2 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `poi_query` pipeline arc: a lexicon-gated `poi_query` QueryKind, the `POIIntent` record, the intent-extraction stage (subject split + anchor re-parse), an OverpassQL export emitter, and the `poiQueryKind` factory flag — default-OFF, byte-identical when off by construction.

**Architecture:** Spec §3.1–3.2 (`docs/superpowers/specs/2026-07-18-spatial-layers-and-poi-design.md`). Detection lives in `kind-classifier` behind an injected `POIPhraseLookup` (the package keeps its "no dictionaries" invariant — the lexicon arrives only via the factory). The intent stage lives in `core` as a new optional `stages.poiIntent`; `runPipeline` branches on `kind === "poi_query"`, and a `null` outcome falls through to the full pipeline (mis-detection safety valve). Assembly happens in `mailwoman/`: the `poiQueryKind` factory flag wires `@mailwoman/poi-taxonomy` into the classifier factory and builds the intent stage with a recursion-guarded anchor re-parse. Brand subjects: the `POIIntent` contract includes the brand variant now, but Plan 2 wires **category** detection only — the brand table (Wikidata QIDs) is Plan 3 data work.

**Tech Stack:** TypeScript (erasable-only, `.ts` imports), vitest, oxfmt/oxlint. No new dependencies except workspace edges: `kind-classifier` gains NOTHING; `mailwoman` gains `@mailwoman/poi-taxonomy`.

## Global Constraints

- License header on every new `.ts` file, verbatim:
  ```ts
  /**
   * @copyright Sister Software
   * @license AGPL-3.0
   * @author Teffen Ellis, et al.
   */
  ```
- `erasableSyntaxOnly`; tabs; relative imports with explicit `.ts` extensions; acronym casing (`categoryID`, `osmTag`, `emitOverpassQL`); DB/wire snake_case rule does not apply here (no DB).
- **Byte-identity invariant:** with `poiQueryKind` unset/false, no code path may alter any existing result — the default `classifyKind` export must be untouched, `stages.poiIntent` must be unset, and `PipelineResult.poiIntent` must be ABSENT (optional field never set), not `undefined`-valued.
- `kind-classifier` must NOT import `@mailwoman/poi-taxonomy` (dependency direction: lexicon is injected). `core` must NOT import it either. Only `mailwoman/` may.
- Both exports maps rule applies to any new subpath (none planned — new mailwoman files are internal modules re-exported from `mailwoman/index.ts` only if a task says so).
- Work in `/home/lab/Projects/mailwoman-exotic-poi`, branch `feat/poi-pipeline` (based on post-#1180 main; installed + compiled).
- Commits verified with `git log -1 --oneline` (never pipe commit output); every commit message ends with:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012SJfJddDssHbDWqaqLoEpi
  ```

---

### Task 1: Core types + the `poi_query` branch in `runPipeline`

**Files:**

- Modify: `core/pipeline/types.ts` (QueryKind union ~line 105; RuntimePipelineStages ~line 222; PipelineResult ~line 274; new POIIntent types after QueryKindResult)
- Modify: `core/pipeline/runtime-pipeline.ts` (branch after the kind-classifier timing block at ~line 343, BEFORE the `canShortCircuit` fast-path block at ~line 349)
- Test: `core/pipeline/poi-branch.test.ts`

**Interfaces:**

- Consumes: existing `NormalizedInputLite`, `LocaleHint`, `AddressTree`, `PipelineOpts`.
- Produces (contract for Tasks 3–5): `"poi_query"` in `QueryKind`; `POIIntent`, `POIIntentOutcome`; `RuntimePipelineStages.poiIntent?: (input: NormalizedInputLite, locale: LocaleHint, opts?: PipelineOpts) => Promise<POIIntentOutcome | null>`; `PipelineResult.poiIntent?: POIIntentOutcome`; `PipelineResult.path` gains `"poi"`.

- [ ] **Step 1: Write the failing test**

`core/pipeline/poi-branch.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { runPipeline } from "./runtime-pipeline.ts"
import type { POIIntentOutcome, QueryKindResult } from "./types.ts"

const POI_KIND: QueryKindResult = { kind: "poi_query", confidence: 0.92, alternatives: [] }

describe("poi_query pipeline branch", () => {
	it("routes to stages.poiIntent and returns path 'poi' with the outcome", async () => {
		const outcome: POIIntentOutcome = {
			type: "intent",
			intent: { subject: { kind: "category", categoryID: "hospital", matched: "hospital" } },
		}
		const result = await runPipeline("hospital", {
			classifyKind: async () => POI_KIND,
			poiIntent: async () => outcome,
		})

		expect(result.path).toBe("poi")
		expect(result.poiIntent).toEqual(outcome)
		expect(result.kind.kind).toBe("poi_query")
		expect(result.tree.roots).toEqual([])
		expect(result.timing["poi-intent"]).toBeTypeOf("number")
	})

	it("carries the anchor tree into result.tree when the intent has one", async () => {
		const anchorTree = {
			raw: "Springfield IL",
			roots: [
				{
					tag: "locality" as const,
					value: "Springfield",
					start: 0,
					end: 11,
					confidence: 0.9,
					children: [],
				},
			],
		}
		const outcome: POIIntentOutcome = {
			type: "intent",
			intent: {
				subject: { kind: "category", categoryID: "hospital", matched: "hospital" },
				anchor: { text: "Springfield IL", tree: anchorTree },
			},
		}
		const result = await runPipeline("hospital near Springfield IL", {
			classifyKind: async () => POI_KIND,
			poiIntent: async () => outcome,
		})

		expect(result.tree).toEqual(anchorTree)
	})

	it("falls through to the full pipeline when the stage returns null", async () => {
		const result = await runPipeline("hospital", {
			classifyKind: async () => POI_KIND,
			poiIntent: async () => null,
		})

		expect(result.path).toBe("full")
		expect(result.poiIntent).toBeUndefined()
		expect("poiIntent" in result).toBe(false)
	})

	it("ignores a poi_query kind entirely when no stage is wired", async () => {
		const result = await runPipeline("hospital", {
			classifyKind: async () => POI_KIND,
		})

		expect(result.path).toBe("full")
		expect("poiIntent" in result).toBe(false)
	})

	it("returns an abstain outcome verbatim", async () => {
		const outcome: POIIntentOutcome = { type: "abstain", reason: "no_executor" }
		const result = await runPipeline("drinking fountain", {
			classifyKind: async () => POI_KIND,
			poiIntent: async () => outcome,
		})

		expect(result.path).toBe("poi")
		expect(result.poiIntent).toEqual(outcome)
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/lab/Projects/mailwoman-exotic-poi && yarn vitest run core/pipeline/poi-branch.test.ts`
Expected: FAIL — `"poi_query"` not assignable to `QueryKind` / `poiIntent` unknown property.

- [ ] **Step 3: Extend `core/pipeline/types.ts`**

3a. Add `"poi_query"` to the `QueryKind` union (after `"landmark"`):

```ts
/** Kind classifier output. */
export type QueryKind =
	| "postcode_only"
	| "locality_only"
	| "structured_address"
	| "intersection"
	| "po_box"
	| "landmark"
	| "poi_query"
	| "vague"
```

3b. After the `QueryKindResult` interface, add the POI intent contract:

```ts
/**
 * The structured POI intent — the pluggable boundary between detection (kind classifier), the
 * executors (Plan 3's poi.db SQL compiler), and the export formats (OverpassQL emitter). Category
 * ids are `@mailwoman/poi-taxonomy` ids carried as plain strings — core stays lexicon-free; the
 * branded type lives with the data package. Spec §3.2:
 * docs/superpowers/specs/2026-07-18-spatial-layers-and-poi-design.md
 */
export interface POIIntent {
	subject:
		| { kind: "category"; categoryID: string; matched: string }
		| { kind: "brand"; name: string; wikidata?: string; matched: string }
		| { kind: "name"; text: string }
	/** Spatial anchor: the split-off remainder text and its parse, when the query carried one. */
	anchor?: {
		text?: string
		tree?: AddressTree
		/** Caller-supplied bias point ("near me"); executors treat it as the anchor when no tree resolved. */
		biasPoint?: { latitude: number; longitude: number }
		radiusM?: number
	}
	limit?: number
}

/**
 * Outcome of the poi-intent stage. `abstain` = the query is POI-shaped but unanswerable as asked
 * (e.g. no executor wired for a build-local-only category) — surfaces map it to their native
 * empty-result envelope instead of a mangled parse.
 */
export type POIIntentOutcome = { type: "intent"; intent: POIIntent } | { type: "abstain"; reason: string }
```

3c. In `RuntimePipelineStages` (after the `placeCountry` member), add:

```ts
	/**
	 * POI intent stage (spec §3.1). Runs ONLY when the kind classifier emitted `poi_query`. Returns
	 * the extracted intent, an abstain, or `null` to fall through to the full pipeline (the
	 * mis-detection safety valve — a `poi_query` kind with no extractable subject parses normally).
	 * Absent by default; wired by `createRuntimePipeline({ poiQueryKind: true })`.
	 */
	poiIntent?: (
		input: NormalizedInputLite,
		locale: LocaleHint,
		opts?: PipelineOpts
	) => Promise<POIIntentOutcome | null>
```

3d. In `PipelineResult`: widen `path` and add the optional field:

```ts
	/** Present only when the poi-intent stage produced an outcome (path === "poi"). */
	poiIntent?: POIIntentOutcome
	/** Which path the coordinator took. `"fast-path"` skipped stages 3-5; `"poi"` took the intent branch. */
	path: "fast-path" | "full" | "poi"
```

(Replace the existing `path` member + its comment; keep field order — `poiIntent` directly above `path`.)

- [ ] **Step 4: Add the branch in `core/pipeline/runtime-pipeline.ts`**

Insert between the kind-classifier timing block (`timing["kind-classifier"] = …`, ~line 343) and the fast-path comment block (`// Fast-path: trivial inputs short-circuit…`, ~line 345):

```ts
// POI branch (spec §3.1). Only reachable when a poi-aware kind classifier was wired (the
// default classifier never emits `poi_query`), and only acts when the stage is present —
// both absent by default, so the flag-off pipeline is byte-identical by construction. A
// `null` outcome falls through to the full pipeline: a poi_query kind with no extractable
// subject is a mis-detection, and the address path is the safe interpretation.
if (kind.kind === "poi_query" && stages.poiIntent) {
	throwIfAborted(opts)
	const tPoi = performance.now()
	const poiOutcome = await stages.poiIntent(normalized, locale, effectiveOpts)
	timing["poi-intent"] = performance.now() - tPoi

	if (poiOutcome) {
		const emptyTree: AddressTree = { raw: normalized.normalized, roots: [] }
		const tree = poiOutcome.type === "intent" ? (poiOutcome.intent.anchor?.tree ?? emptyTree) : emptyTree

		return {
			input: raw,
			normalized,
			queryShape,
			locale,
			kind,
			phraseProposals: [],
			tree,
			poiIntent: poiOutcome,
			timing,
			path: "poi",
		}
	}
}
```

(`AddressTree` is already imported in this file; `throwIfAborted` and `effectiveOpts` are in scope at this point — see the surrounding fast-path block for the pattern.)

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn vitest run core/pipeline/poi-branch.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Guard the untouched surface**

Run: `yarn vitest run core/pipeline/ kind-classifier/`
Expected: all existing pipeline + kind-classifier tests still pass (no behavioral change for non-poi kinds).

- [ ] **Step 7: Format and commit**

```bash
cd /home/lab/Projects/mailwoman-exotic-poi
yarn oxfmt core/pipeline/types.ts core/pipeline/runtime-pipeline.ts core/pipeline/poi-branch.test.ts
git add core/pipeline/types.ts core/pipeline/runtime-pipeline.ts core/pipeline/poi-branch.test.ts
git commit -m "feat(core): poi_query kind + POIIntent contract + poi pipeline branch"
git log -1 --oneline
```

---

### Task 2: `poi-taxonomy` gains `osmTag` + the no-locale lookup pin

**Files:**

- Modify: `poi-taxonomy/types.ts` (CategoryRecord)
- Modify: `poi-taxonomy/data/taxonomy.json` (all 23 categories)
- Modify: `poi-taxonomy/lookup.test.ts` (two new tests)

**Interfaces:**

- Produces: `CategoryRecord.osmTag?: string` (`"key=value"` form). Task 5's emitter consumes it via the existing `getPOICategory`.

- [ ] **Step 1: Write the failing tests** (append to the existing describes in `poi-taxonomy/lookup.test.ts`)

To `describe("taxonomy integrity", …)` add:

```ts
it("every category carries a well-formed osmTag", () => {
	for (const category of getAllCategories()) {
		expect(category.osmTag, `osmTag missing on ${category.id}`).toMatch(/^[a-z_]+=[a-z_]+$/)
	}
})
```

New describe (pins the deferred behavior from the Plan-1 final review — locale-GATED synonyms are invisible without a locale, ungated ones always match):

```ts
describe("lookup without a locale", () => {
	it("hides locale-gated synonyms and keeps ungated ones", () => {
		expect(lookupPOICategory("chemist")).toEqual([])
		expect(lookupPOICategory("drinking fountain")[0]?.confidence).toBe(1.0)
	})
})
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn vitest run poi-taxonomy/lookup.test.ts`
Expected: the osmTag test FAILS (`osmTag missing on hospital`); the no-locale test may already pass — that is fine, it is a pin, not a change.

- [ ] **Step 3: Add the field to `poi-taxonomy/types.ts`** (in `CategoryRecord`, after `basicLabel`):

```ts
	/**
	 * The OSM tag this category maps to, `key=value` form (e.g. `amenity=hospital`) — consumed by
	 * the OverpassQL export emitter. Curated alongside the category; NOT an Overture field.
	 */
	osmTag?: string
```

- [ ] **Step 4: Add `osmTag` to every category in `data/taxonomy.json`** (insert after each `basicLabel` key):

| id                   | osmTag                    |
| -------------------- | ------------------------- |
| hospital             | `amenity=hospital`        |
| pharmacy             | `amenity=pharmacy`        |
| restaurant           | `amenity=restaurant`      |
| cafe                 | `amenity=cafe`            |
| fast_food_restaurant | `amenity=fast_food`       |
| supermarket          | `shop=supermarket`        |
| gas_station          | `amenity=fuel`            |
| hotel                | `tourism=hotel`           |
| school               | `amenity=school`          |
| library              | `amenity=library`         |
| park                 | `leisure=park`            |
| trail                | `route=hiking`            |
| atm                  | `amenity=atm`             |
| bank                 | `amenity=bank`            |
| post_office          | `amenity=post_office`     |
| police_station       | `amenity=police`          |
| fire_station         | `amenity=fire_station`    |
| fire_hydrant         | `emergency=fire_hydrant`  |
| post_box             | `amenity=post_box`        |
| drinking_water       | `amenity=drinking_water`  |
| telecom_cabinet      | `man_made=street_cabinet` |
| data_center          | `telecom=data_center`     |
| power_substation     | `power=substation`        |

- [ ] **Step 5: Run to verify pass**

Run: `yarn vitest run poi-taxonomy/lookup.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Format and commit**

```bash
yarn oxfmt poi-taxonomy/types.ts poi-taxonomy/data/taxonomy.json poi-taxonomy/lookup.test.ts
git add poi-taxonomy/types.ts poi-taxonomy/data/taxonomy.json poi-taxonomy/lookup.test.ts
git commit -m "feat(poi-taxonomy): per-category osmTag + pin no-locale lookup semantics"
git log -1 --oneline
```

---

### Task 3: kind-classifier — injected lexicon, subject matcher, `poi_query` scorer

**Files:**

- Create: `kind-classifier/poi.ts`
- Modify: `kind-classifier/classify.ts` (add factory; default export untouched)
- Modify: `kind-classifier/index.ts` (re-export the new symbols — check the barrel's existing style first)
- Test: `kind-classifier/poi.test.ts`

**Interfaces:**

- Consumes: `NormalizedInputLite`, `QueryShapeLike`, `LocaleHint` from `./types.ts`; `classifyKindSync` from `./classify.ts`.
- Produces (Task 4 consumes): `POIPhraseMatch`, `POIPhraseLookup`, `POISubjectMatch`, `matchPOISubject(text: string, locale: string | undefined, lookup: POIPhraseLookup): POISubjectMatch | null`, `createKindClassifier(opts?: { poiLexicon?: POIPhraseLookup }): (input, shape, locale) => Promise<QueryKindResult>`.

- [ ] **Step 1: Write the failing test**

`kind-classifier/poi.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { classifyKind, createKindClassifier } from "./index.ts"
import { matchPOISubject, type POIPhraseLookup } from "./poi.ts"
import type { LocaleHint } from "./types.ts"

/** Stub lexicon: knows `hospital` and the two-token `drinking fountain`. */
const LOOKUP: POIPhraseLookup = (phrase) => {
	const norm = phrase.trim().toLowerCase()

	if (norm === "hospital") return [{ categoryID: "hospital", matchedPhrase: "hospital", confidence: 1.0 }]

	if (norm === "drinking fountain") {
		return [{ categoryID: "drinking_water", matchedPhrase: "drinking fountain", confidence: 1.0 }]
	}

	return []
}

const LOCALE: LocaleHint = { locale: "en-US", confidence: 1, alternatives: [], source: "caller" }

const input = (normalized: string) => ({ raw: normalized, normalized })
const shape = (segments?: string[]) => ({
	knownFormats: [],
	...(segments ? { segments: segments.map((body, index) => ({ body, index })) } : {}),
})

describe("matchPOISubject", () => {
	it("matches the whole input", () => {
		const m = matchPOISubject("hospital", "en-US", LOOKUP)
		expect(m?.match.categoryID).toBe("hospital")
		expect(m?.remainder).toBe("")
	})

	it("splits a subject prefix from a 'near' anchor", () => {
		const m = matchPOISubject("drinking fountain near Springfield IL", "en-US", LOOKUP)
		expect(m?.match.categoryID).toBe("drinking_water")
		expect(m?.subject).toBe("drinking fountain")
		expect(m?.remainder).toBe("Springfield IL")
	})

	it("splits on a comma separator", () => {
		const m = matchPOISubject("hospital, Portland OR", "en-US", LOOKUP)
		expect(m?.remainder).toBe("Portland OR")
	})

	it("returns null when nothing matches", () => {
		expect(matchPOISubject("Empire State Building", "en-US", LOOKUP)).toBeNull()
	})
})

describe("createKindClassifier with a poi lexicon", () => {
	const classify = createKindClassifier({ poiLexicon: LOOKUP })

	it("emits poi_query for a bare category phrase", async () => {
		const result = await classify(input("hospital"), shape(), LOCALE)
		expect(result.kind).toBe("poi_query")
		expect(result.confidence).toBeGreaterThanOrEqual(0.9)
	})

	it("emits poi_query for subject + anchor", async () => {
		const result = await classify(input("hospital near Springfield IL"), shape(), LOCALE)
		expect(result.kind).toBe("poi_query")
	})

	it("does NOT claim a venue-led full address (house-number remainder)", async () => {
		const result = await classify(
			input("hospital, 350 5th Ave, New York, NY 10118"),
			shape(["hospital", " 350 5th Ave", " New York", " NY 10118"]),
			LOCALE
		)
		expect(result.kind).not.toBe("poi_query")
	})

	it("keeps the base ranking when the lexicon misses", async () => {
		const withPOI = await classify(input("Empire State Building"), shape(), LOCALE)
		const base = await classifyKind(input("Empire State Building"), shape())
		expect(withPOI).toEqual(base)
	})
})

describe("default classifyKind is untouched", () => {
	it("never emits poi_query", async () => {
		const result = await classifyKind(input("hospital"), shape())
		expect(result.kind).not.toBe("poi_query")
		expect(result.alternatives.map((a) => a.kind)).not.toContain("poi_query")
	})
})
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn vitest run kind-classifier/poi.test.ts`
Expected: FAIL — `./poi.ts` unresolved.

- [ ] **Step 3: Write `kind-classifier/poi.ts`**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   POI subject detection for the `poi_query` kind. The lexicon is INJECTED (`POIPhraseLookup`) —
 *   this package keeps its bitter-lesson invariant (no dictionaries in-tree); the phrase table
 *   lives in `@mailwoman/poi-taxonomy` and is wired in by `createRuntimePipeline` behind the
 *   default-OFF `poiQueryKind` flag. Spec §3.1.
 */

import type { NormalizedInputLite, QueryShapeLike } from "./types.ts"

/** One lexicon hit for a candidate subject phrase. */
export interface POIPhraseMatch {
	categoryID: string
	matchedPhrase: string
	confidence: number
}

/** Injected phrase→category lookup. Exact-phrase, locale-aware; returns [] on miss. */
export type POIPhraseLookup = (phrase: string, locale?: string) => ReadonlyArray<POIPhraseMatch>

export interface POISubjectMatch {
	match: POIPhraseMatch
	/** The matched subject text as it appeared in the query. */
	subject: string
	/** The anchor remainder after the separator; `""` when the whole input matched. */
	remainder: string
}

/** Anchor separator between subject and place: the FIRST comma, or near/in/at/around. */
const ANCHOR_SEPARATOR = /\s*,\s*|\s+(?:near|in|at|around)\s+/i

/** Longest subject we accept, in tokens. Lexicon phrases are short; 4 covers the table. */
const MAX_SUBJECT_TOKENS = 4

/**
 * Match a POI subject: the whole input, or the text before the FIRST anchor separator when that
 * prefix (≤ 4 tokens) hits the lexicon. Returns null when the lexicon never fires — including
 * comma-ridden full addresses whose leading segment isn't a lexicon phrase.
 */
export function matchPOISubject(
	text: string,
	locale: string | undefined,
	lookup: POIPhraseLookup
): POISubjectMatch | null {
	const trimmed = text.trim()

	if (!trimmed) return null

	const whole = lookup(trimmed, locale)

	if (whole.length > 0) {
		return { match: whole[0]!, subject: trimmed, remainder: "" }
	}

	const separator = ANCHOR_SEPARATOR.exec(trimmed)

	if (!separator || separator.index === 0) return null

	const subject = trimmed.slice(0, separator.index).trim()

	if (subject.split(/\s+/).length > MAX_SUBJECT_TOKENS) return null

	const hits = lookup(subject, locale)

	if (hits.length === 0) return null

	const remainder = trimmed.slice(separator.index + separator[0].length).trim()

	return { match: hits[0]!, subject, remainder }
}

/**
 * `poi_query` scorer over an injected lexicon. Confidence bands: whole-input lexicon hit 0.92
 * (above venue-landmark's 0.88 ceiling — an exact lexicon phrase beats a shape heuristic);
 * subject + anchor 0.9. Guards below keep venue-led FULL addresses (class 2) on the
 * structured-address path: a remainder that leads with a house number, or a 4+-segment input,
 * scores 0 here.
 */
export function createScorePOIQuery(
	lookup: POIPhraseLookup,
	locale?: string
): (input: NormalizedInputLite, shape: QueryShapeLike) => number {
	return (input, shape) => {
		const matched = matchPOISubject(input.normalized, locale ?? input.appliedLocale, lookup)

		if (!matched) return 0

		if (matched.remainder === "") return 0.92 * matched.match.confidence

		// Venue-led full address: "X, 350 5th Ave, …" stays a structured_address parse.
		if (/^\d+\s/.test(matched.remainder)) return 0

		const segCount = shape.segments?.length ?? 1

		if (segCount > 3) return 0

		return 0.9 * matched.match.confidence
	}
}
```

- [ ] **Step 4: Add the factory to `kind-classifier/classify.ts`** (append after `classifyKind`; do NOT modify the existing exports):

```ts
/** Options for {@link createKindClassifier}. */
export interface KindClassifierOpts {
	/**
	 * POI phrase lexicon (spec §3.1). When present, a `poi_query` scorer joins the rule set —
	 * injected, never imported, so this package stays dictionary-free. Absent → the returned
	 * classifier is behaviorally identical to {@link classifyKind}.
	 */
	poiLexicon?: POIPhraseLookup
}

/**
 * Build a kind classifier. Without opts this is exactly the default {@link classifyKind}; with a
 * `poiLexicon` it additionally scores `poi_query` and merges it into the ranked result.
 */
export function createKindClassifier(
	opts: KindClassifierOpts = {}
): (input: NormalizedInputLite, shape: QueryShapeLike, locale?: LocaleHint) => Promise<QueryKindResult> {
	const { poiLexicon } = opts

	if (!poiLexicon) return classifyKind

	return async (input, shape, locale) => {
		const base = classifyKindSync(input, shape)
		const poiConfidence = createScorePOIQuery(poiLexicon, locale?.locale)(input, shape)

		if (poiConfidence <= 0) return base

		if (poiConfidence > base.confidence) {
			return {
				kind: "poi_query",
				confidence: poiConfidence,
				alternatives: [{ kind: base.kind, confidence: base.confidence }, ...base.alternatives],
			}
		}

		return {
			...base,
			alternatives: [...base.alternatives, { kind: "poi_query", confidence: poiConfidence }].sort(
				(a, b) => b.confidence - a.confidence
			),
		}
	}
}
```

Imports to add at the top of `classify.ts`: `import { createScorePOIQuery, type POIPhraseLookup } from "./poi.ts"` (merge into the existing import block style).

- [ ] **Step 5: Re-export from the barrel**

In `kind-classifier/index.ts`, re-export following the file's existing style: `createKindClassifier`, `KindClassifierOpts` (from `./classify.ts`), and `matchPOISubject`, `POIPhraseLookup`, `POIPhraseMatch`, `POISubjectMatch` (from `./poi.ts`).

- [ ] **Step 6: Run tests**

Run: `yarn vitest run kind-classifier/`
Expected: new file PASS (9 tests) + all pre-existing kind-classifier tests still green.

- [ ] **Step 7: Format and commit**

```bash
yarn oxfmt kind-classifier/poi.ts kind-classifier/classify.ts kind-classifier/index.ts kind-classifier/poi.test.ts
git add kind-classifier/poi.ts kind-classifier/classify.ts kind-classifier/index.ts kind-classifier/poi.test.ts
git commit -m "feat(kind-classifier): injected POI lexicon — matchPOISubject + poi_query scorer + factory"
git log -1 --oneline
```

---

### Task 4: mailwoman wiring — the `poiQueryKind` flag + intent stage

**Files:**

- Create: `mailwoman/poi-intent.ts`
- Modify: `mailwoman/runtime-pipeline.ts` (factory opt + stage wiring)
- Modify: `mailwoman/package.json` (add `"@mailwoman/poi-taxonomy": "workspace:*"` to dependencies) + `mailwoman/tsconfig.json` references if the file lists sibling references (mirror how `@mailwoman/kind-classifier` is referenced) + root `yarn install` for the lockfile
- Test: `mailwoman/poi-intent.test.ts`

**Interfaces:**

- Consumes: Task 1's `POIIntent`/`POIIntentOutcome`/stage signature; Task 3's `matchPOISubject`/`createKindClassifier`/`POIPhraseLookup`; `lookupPOICategory`, `requiresBuildLocalLayer` from `@mailwoman/poi-taxonomy`.
- Produces: `poiTaxonomyLookup: POIPhraseLookup` (the adapter), `createPOIIntentStage(deps: { lookup: POIPhraseLookup; parseAnchor: (text: string, opts?: PipelineOpts) => Promise<PipelineResult> }): NonNullable<RuntimePipelineStages["poiIntent"]>`, and `CreateRuntimePipelineOpts.poiQueryKind?: boolean`.

- [ ] **Step 1: Write the failing test**

`mailwoman/poi-intent.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { LocaleHint, PipelineResult } from "@mailwoman/core/pipeline"
import { describe, expect, it } from "vitest"

import { createPOIIntentStage, poiTaxonomyLookup } from "./poi-intent.ts"
import { createRuntimePipeline } from "./runtime-pipeline.ts"

const LOCALE: LocaleHint = { locale: "en-US", confidence: 1, alternatives: [], source: "caller" }

const anchorResult = (raw: string): PipelineResult => ({
	input: raw,
	normalized: { raw, normalized: raw },
	queryShape: { knownFormats: [] },
	locale: LOCALE,
	kind: { kind: "structured_address", confidence: 0.5, alternatives: [] },
	phraseProposals: [],
	tree: { raw, roots: [] },
	timing: {},
	path: "full",
})

describe("poiTaxonomyLookup adapter", () => {
	it("maps taxonomy matches into POIPhraseMatch shape", () => {
		const hits = poiTaxonomyLookup("drinking fountain", "en-US")
		expect(hits[0]?.categoryID).toBe("drinking_water")
		expect(hits[0]?.confidence).toBe(1.0)
	})
})

describe("createPOIIntentStage", () => {
	it("returns a category intent with a parsed anchor", async () => {
		const parsed: string[] = []
		const stage = createPOIIntentStage({
			lookup: poiTaxonomyLookup,
			parseAnchor: async (text) => {
				parsed.push(text)
				return anchorResult(text)
			},
		})
		const outcome = await stage(
			{ raw: "hospital near Springfield IL", normalized: "hospital near Springfield IL" },
			LOCALE
		)

		expect(outcome?.type).toBe("intent")

		if (outcome?.type !== "intent") throw new Error("unreachable")

		expect(outcome.intent.subject).toEqual({ kind: "category", categoryID: "hospital", matched: "hospital" })
		expect(outcome.intent.anchor?.text).toBe("Springfield IL")
		expect(parsed).toEqual(["Springfield IL"])
	})

	it("returns a bare-subject intent with no anchor and no anchor parse", async () => {
		const stage = createPOIIntentStage({
			lookup: poiTaxonomyLookup,
			parseAnchor: async () => {
				throw new Error("must not parse an anchor for a bare subject")
			},
		})
		const outcome = await stage({ raw: "fire hydrant", normalized: "fire hydrant" }, LOCALE)

		expect(outcome?.type).toBe("intent")
	})

	it("returns null when no subject matches (fall-through)", async () => {
		const stage = createPOIIntentStage({ lookup: poiTaxonomyLookup, parseAnchor: async (t) => anchorResult(t) })
		const outcome = await stage({ raw: "Empire State Building", normalized: "Empire State Building" }, LOCALE)

		expect(outcome).toBeNull()
	})
})

// placeCountry/streetEvidence lazy-load bundled data on first call — off for hermetic tests
// (fresh worktrees may lack linked dev weights; the poi arc doesn't touch either stage).
const HERMETIC = { placeCountry: false as const, streetEvidence: false as const }

describe("createRuntimePipeline poiQueryKind flag", () => {
	it("OFF by default: a category phrase never takes the poi path", async () => {
		const pipeline = createRuntimePipeline({ ...HERMETIC })
		const result = await pipeline("hospital")

		expect(result.path).not.toBe("poi")
		expect("poiIntent" in result).toBe(false)
		expect(result.kind.kind).not.toBe("poi_query")
	})

	it("ON: a category phrase takes the poi path end-to-end", async () => {
		const pipeline = createRuntimePipeline({ ...HERMETIC, poiQueryKind: true })
		const result = await pipeline("drinking fountain near Springfield")

		expect(result.path).toBe("poi")
		expect(result.poiIntent?.type).toBe("intent")

		if (result.poiIntent?.type !== "intent") throw new Error("unreachable")

		expect(result.poiIntent.intent.subject).toEqual({
			kind: "category",
			categoryID: "drinking_water",
			matched: "drinking fountain",
		})
		expect(result.poiIntent.intent.anchor?.text).toBe("Springfield")
	})

	it("ON: a plain address stays on the normal path", async () => {
		const pipeline = createRuntimePipeline({ ...HERMETIC, poiQueryKind: true })
		const result = await pipeline("350 5th Ave, New York, NY 10118")

		expect(result.path).not.toBe("poi")
		expect("poiIntent" in result).toBe(false)
	})
})
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn vitest run mailwoman/poi-intent.test.ts`
Expected: FAIL — `./poi-intent.ts` unresolved.

- [ ] **Step 3: Add the dependency**

In `mailwoman/package.json` dependencies (alphabetical, near `"@mailwoman/phrase-grouper"`): `"@mailwoman/poi-taxonomy": "workspace:*"`. Then `yarn install` (lockfile updates — commit with this task). Check `mailwoman/tsconfig.json`: if it carries a `references` array listing sibling workspaces, add `{ "path": "../poi-taxonomy" }` in the same style; if not, skip.

- [ ] **Step 4: Write `mailwoman/poi-intent.ts`**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   POI intent stage assembly (spec §3.1–3.2). This is the ONLY module that joins the pieces:
 *   `@mailwoman/poi-taxonomy` (the lexicon), `@mailwoman/kind-classifier` (subject matching), and
 *   the pipeline contract from core. Wired by `createRuntimePipeline({ poiQueryKind: true })`;
 *   dormant otherwise.
 */

import type {
	LocaleHint,
	NormalizedInputLite,
	PipelineOpts,
	PipelineResult,
	POIIntent,
	POIIntentOutcome,
} from "@mailwoman/core/pipeline"
import { matchPOISubject, type POIPhraseLookup } from "@mailwoman/kind-classifier"
import { lookupPOICategory } from "@mailwoman/poi-taxonomy"

/** Adapter: `@mailwoman/poi-taxonomy`'s CategoryMatch → the classifier's injected lookup shape. */
export const poiTaxonomyLookup: POIPhraseLookup = (phrase, locale) =>
	lookupPOICategory(phrase, locale).map((m) => ({
		categoryID: m.category.id,
		matchedPhrase: m.matchedPhrase,
		confidence: m.confidence,
	}))

export interface POIIntentStageDeps {
	lookup: POIPhraseLookup
	/**
	 * Parses the anchor remainder ("Springfield IL") through the ADDRESS pipeline. Callers must
	 * hand in a pipeline WITHOUT the poi stage (recursion guard) — `createRuntimePipeline` does.
	 */
	parseAnchor: (text: string, opts?: PipelineOpts) => Promise<PipelineResult>
}

/** Build the `stages.poiIntent` implementation. */
export function createPOIIntentStage(
	deps: POIIntentStageDeps
): (input: NormalizedInputLite, locale: LocaleHint, opts?: PipelineOpts) => Promise<POIIntentOutcome | null> {
	return async (input, locale, opts) => {
		const matched = matchPOISubject(input.normalized, locale.locale, deps.lookup)

		if (!matched) return null

		const intent: POIIntent = {
			subject: {
				kind: "category",
				categoryID: matched.match.categoryID,
				matched: matched.match.matchedPhrase,
			},
		}

		if (matched.remainder) {
			const anchor = await deps.parseAnchor(matched.remainder, opts)
			intent.anchor = { text: matched.remainder, tree: anchor.tree }
		}

		return { type: "intent", intent }
	}
}
```

- [ ] **Step 5: Wire the flag in `mailwoman/runtime-pipeline.ts`**

5a. Add to `CreateRuntimePipelineOpts` (after `streetEvidence`):

```ts
	/**
	 * POI-query detection + intent extraction (spec §3.1, exotic-POI arc plan 2). Default-OFF —
	 * see the runtime-flag register. When true: the kind classifier gains the poi-taxonomy
	 * lexicon (`poi_query` kind) and the poi-intent stage is wired; the anchor remainder parses
	 * through this same pipeline with the poi stage OFF (recursion guard). When unset/false the
	 * pipeline is byte-identical to pre-flag builds. An explicit `classifyKind` override wins
	 * over the poi-aware default.
	 */
	poiQueryKind?: boolean
```

5b. In `createRuntimePipeline`, wire conditionally. Imports: `createKindClassifier` from `@mailwoman/kind-classifier`; `createPOIIntentStage, poiTaxonomyLookup` from `./poi-intent.ts`. Replace the single `classifyKind:` line in the `stages` literal and add `poiIntent` after the stages object is built (the anchor pipeline needs the stages object — build it as a second closure):

```ts
		// POI arc (default-OFF). The poi-aware classifier only exists behind the flag; an explicit
		// classifyKind override always wins. The anchor re-parse runs THIS pipeline minus the poi
		// stage: same stages object, but runPipeline never takes the poi branch because
		// anchorStages.poiIntent is absent and anchorStages.classifyKind is the default.
		classifyKind:
			opts.classifyKind ?? (opts.poiQueryKind ? createKindClassifier({ poiLexicon: poiTaxonomyLookup }) : defaultClassifyKind),
```

and after the `stages` literal closes (the existing `classifyKind: opts.classifyKind ?? defaultClassifyKind` line is what 5b's first snippet replaces; `runPipeline` is already imported in this file — verify):

```ts
if (opts.poiQueryKind) {
	stages.poiIntent = createPOIIntentStage({
		lookup: poiTaxonomyLookup,
		// Inline spread, evaluated at CALL time: the factory's lazy stages (placeCountry,
		// streetEvidence) mutate `stages` on first run, and this form always sees the final
		// wiring. classifyKind reverts to the default (no poi lexicon) and poiIntent is
		// stripped — the recursion guard.
		parseAnchor: (text, runOpts) =>
			runPipeline(text, { ...stages, classifyKind: defaultClassifyKind, poiIntent: undefined }, runOpts),
	})
}
```

- [ ] **Step 6: Run tests**

Run: `yarn vitest run mailwoman/poi-intent.test.ts`
Expected: PASS (7 tests). Also run `yarn vitest run mailwoman/geocode-core.test.ts` — must stay green (flag-off surface untouched).

- [ ] **Step 7: Format and commit**

```bash
yarn oxfmt mailwoman/poi-intent.ts mailwoman/runtime-pipeline.ts mailwoman/poi-intent.test.ts
git add mailwoman/poi-intent.ts mailwoman/runtime-pipeline.ts mailwoman/poi-intent.test.ts mailwoman/package.json mailwoman/tsconfig.json yarn.lock
git commit -m "feat(mailwoman): poiQueryKind flag — lexicon-wired kind classifier + poi-intent stage"
git log -1 --oneline
```

---

### Task 5: OverpassQL export emitter

**Files:**

- Create: `mailwoman/poi-overpass.ts`
- Test: `mailwoman/poi-overpass.test.ts`

**Interfaces:**

- Consumes: `POIIntent` from `@mailwoman/core/pipeline`; `getPOICategory` from `@mailwoman/poi-taxonomy` (caller passes the tag — the emitter itself stays data-free).
- Produces: `emitOverpassQL(intent: POIIntent, opts?: { osmTag?: string; radiusM?: number }): string`. Pure formatter; we never execute Overpass — this is the spec's export-only path.

- [ ] **Step 1: Write the failing test**

`mailwoman/poi-overpass.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { POIIntent } from "@mailwoman/core/pipeline"
import { describe, expect, it } from "vitest"

import { emitOverpassQL } from "./poi-overpass.ts"

const category = (anchor?: POIIntent["anchor"]): POIIntent => ({
	subject: { kind: "category", categoryID: "hospital", matched: "hospital" },
	...(anchor ? { anchor } : {}),
})

describe("emitOverpassQL", () => {
	it("emits a global tag query for a bare category", () => {
		const ql = emitOverpassQL(category(), { osmTag: "amenity=hospital" })
		expect(ql).toContain('nwr["amenity"="hospital"]')
		expect(ql).toContain("[out:json]")
		expect(ql).toContain("out center")
	})

	it("scopes to a named area when the anchor tree resolved a locality", () => {
		const ql = emitOverpassQL(
			category({
				text: "Springfield IL",
				tree: {
					raw: "Springfield IL",
					roots: [
						{ tag: "locality", value: "Springfield", start: 0, end: 11, confidence: 0.9, children: [] },
						{ tag: "region", value: "IL", start: 12, end: 14, confidence: 0.9, children: [] },
					],
				},
			}),
			{ osmTag: "amenity=hospital" }
		)
		expect(ql).toContain('area["name"="Springfield"]->.anchor')
		expect(ql).toContain('nwr["amenity"="hospital"](area.anchor)')
	})

	it("falls back to a name regex for name subjects, with escaping", () => {
		const ql = emitOverpassQL({ subject: { kind: "name", text: 'Joe"s "Diner"' } })
		expect(ql).toContain('nwr["name"~"Joe\\"s \\"Diner\\"",i]')
	})

	it("emits a brand name filter for brand subjects", () => {
		const ql = emitOverpassQL({ subject: { kind: "brand", name: "McDonald's", matched: "mcdonald's" } })
		expect(ql).toContain('nwr["name"~"McDonald\'s",i]')
	})

	it("throws on a category subject with no osmTag provided", () => {
		expect(() => emitOverpassQL(category())).toThrow(/osmTag/)
	})
})
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn vitest run mailwoman/poi-overpass.test.ts`
Expected: FAIL — module unresolved.

- [ ] **Step 3: Write `mailwoman/poi-overpass.ts`**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   OverpassQL EXPORT emitter over `POIIntent` (spec §1: "we print the query; we never run it").
 *   Overpass is not a serving backend — this exists so users who live in Overpass-turbo can take
 *   a mailwoman intent there. The category→OSM-tag mapping is the caller's input (from
 *   `@mailwoman/poi-taxonomy`'s `osmTag`); the emitter is a pure string builder.
 */

import type { POIIntent } from "@mailwoman/core/pipeline"

/** Escape a value for an OverpassQL double-quoted string. */
function escapeQL(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

export interface EmitOverpassOpts {
	/** `key=value` OSM tag for category subjects (from `CategoryRecord.osmTag`). */
	osmTag?: string
	/** Radius for around-filters when the anchor is a bias point (future); default 10000. */
	radiusM?: number
}

/**
 * Render an OverpassQL query for the intent. Category subjects need `opts.osmTag`; name/brand
 * subjects render a case-insensitive name regex. A resolved anchor locality becomes an area
 * scope; otherwise the query is global (Overpass-turbo users add their own bbox).
 */
export function emitOverpassQL(intent: POIIntent, opts: EmitOverpassOpts = {}): string {
	let filter: string

	switch (intent.subject.kind) {
		case "category": {
			if (!opts.osmTag) {
				throw new Error(`emitOverpassQL: category subject ${intent.subject.categoryID} requires opts.osmTag`)
			}
			const [key, value] = opts.osmTag.split("=")
			filter = `nwr["${escapeQL(key ?? "")}"="${escapeQL(value ?? "")}"]`
			break
		}
		case "brand":
			filter = `nwr["name"~"${escapeQL(intent.subject.name)}",i]`
			break
		case "name":
			filter = `nwr["name"~"${escapeQL(intent.subject.text)}",i]`
			break
	}

	const locality = intent.anchor?.tree?.roots.find((r) => r.tag === "locality")?.value

	if (locality) {
		return [
			"[out:json][timeout:25];",
			`area["name"="${escapeQL(locality)}"]->.anchor;`,
			`${filter}(area.anchor);`,
			"out center;",
		].join("\n")
	}

	return ["[out:json][timeout:25];", `${filter};`, "out center;"].join("\n")
}
```

- [ ] **Step 4: Run to verify pass**

Run: `yarn vitest run mailwoman/poi-overpass.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Format and commit**

```bash
yarn oxfmt mailwoman/poi-overpass.ts mailwoman/poi-overpass.test.ts
git add mailwoman/poi-overpass.ts mailwoman/poi-overpass.test.ts
git commit -m "feat(mailwoman): OverpassQL export emitter over POIIntent"
git log -1 --oneline
```

---

### Task 6: Surface `poiIntent` in `mailwoman parse --debug` + flag-register row

**Files:**

- Modify: `mailwoman/commands/parse.tsx` (the `--debug` serialization region, around line 648 where `kind` is emitted)
- Modify: `docs/articles/plan/reference/runtime-flags.mdx` (Default-OFF table)

- [ ] **Step 1: Debug surface**

In `mailwoman/commands/parse.tsx`, locate where the debug JSON includes `kind` (≈line 648). Add `poiIntent` alongside, same conditional style the file uses for optional result fields — the field must appear ONLY when present on the result (never `"poiIntent": undefined`). Mirror the surrounding code exactly; this is a one-to-three-line change.

- [ ] **Step 2: Flag-register row**

In `docs/articles/plan/reference/runtime-flags.mdx`, Default-OFF table (after the `jointReconcile` row), add:

```
| `poiQueryKind`                                                            | `CreateRuntimePipelineOpts`  | exotic-POI arc plan 2 (spec 2026-07-18): lexicon-gated `poi_query` kind + intent extraction; flag-off byte-identical by construction (default classifier never emits the kind, stage absent). Promotion gate before any default flip: golden 2pp + demo presets + the bare-venue/POI board (spec §3.6) |
```

- [ ] **Step 3: Verify**

Run: `yarn compile` (parse.tsx is TSX — compiled, not type-stripped; a stale out/ would mask errors) then `node mailwoman/out/cli.js parse "hospital" --debug 2>&1 | head -20` — output must be unchanged vs. main (flag is off in the CLI's default pipeline; no `poiIntent` key appears).
Expected: compile clean; CLI output has no poiIntent field.

- [ ] **Step 4: Format and commit**

```bash
yarn oxfmt mailwoman/commands/parse.tsx docs/articles/plan/reference/runtime-flags.mdx
git add mailwoman/commands/parse.tsx docs/articles/plan/reference/runtime-flags.mdx
git commit -m "feat(cli): poiIntent in parse --debug + poiQueryKind flag-register row"
git log -1 --oneline
```

---

### Task 7: Whole-tree verification

**Files:** none new.

- [ ] **Step 1:** `yarn compile` — zero errors.
- [ ] **Step 2:** `yarn vitest run core/pipeline/ kind-classifier/ poi-taxonomy/ mailwoman/poi-intent.test.ts mailwoman/poi-overpass.test.ts` — all green (expect ≈ 5 + 9 existing-kind-classifier-suite + 9 taxonomy + 7 + 5 new, plus pre-existing core/pipeline suites).
- [ ] **Step 3:** `yarn vitest run mailwoman/` — the full mailwoman suite stays green (byte-identity check for the flag-off surface; note `yarn compile` must have run first — CLI tests exec compiled out/).
- [ ] **Step 4:** `yarn lint` — clean for branch files (pre-existing warnings in `mailwoman/commands/gazetteer/{importance,inspect/placetype-stats}.tsx` are NOT ours — leave them).
- [ ] **Step 5:** `git status --short` clean, `git push -u origin feat/poi-pipeline`.

---

## Execution notes

- Task 4 Step 5b: the file's lazy stage wiring (placeCountry/streetEvidence resolve on first call) is why the plan mandates the **inline-spread** `parseAnchor` form — it reads `stages` at call time, immune to mutation ordering. Do not "optimize" it into a pre-built anchorStages object.
- Deferred to Plan 3 (do NOT build here): the poi.db executor, brand table + brand detection wiring, `variant-aliases` slang→taxonomy wiring, the landmark-leader abstain path, ResolveOpts kind-threading, MCP server, API/photon response variants.
- The golden-2pp / demo-preset gate applies at DEFAULT-FLIP time, not merge time (flag ships OFF; register row records the promotion gate).
