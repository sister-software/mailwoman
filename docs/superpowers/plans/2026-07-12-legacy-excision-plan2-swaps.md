# Legacy Excision Plan 2 — Production Swaps (`/v1/parse`, libpostal, nominatim) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap the three production surfaces off the v1 rules parser — `/v1/parse` to native neural output, libpostal `/parse` to a neural-backed engine behind the existing wire contract, nominatim `streetParts` deleted in favor of fields the geocode already returns — each gated against the phase-0 goldens.

**Architecture:** Raw `classifier.parse` everywhere (NOT the runtime pipeline — its reconcile stage merges street into house_number, #566). The libpostal projection extends in place (`libpostal/engine.ts`): a tree-aware `treeToParseMatches` assembles the street-name family into one match so the untouched route layer + `COMPONENT_TO_LIBPOSTAL` keep producing libpostal wire shapes. Gates are structured comparisons with pre-registered per-label agreement floors (spec §Projection layer, Plan-2 amendments) — byte-equality is unattainable across the engine swap by design.

**Tech Stack:** `NeuralAddressClassifier.loadFromWeights` (`@mailwoman/neural`), `decodeAsTuples`/`decodeAsXML` (`@mailwoman/core` decoder), Hono `app.request()` in-process gates, vitest `describe.skipIf` for data-bound suites.

**Spec:** `docs/superpowers/specs/2026-07-12-legacy-rules-excision-design.md` (§Projection layer incl. Plan-2 amendments, §Evidence capture). Plan 2 of 5.

**Prerequisite:** PR #1092 (phase-0 goldens) merged; branch `feat/legacy-excision-swaps` off updated main. Execute on the lab host (weights symlinks + gazetteer present) — the gate suites skip in CI by design, so the live receipts in each task are the real gate.

## Global Constraints

- **Pre-registered gate floors (set before any gate run; do NOT adjust to green a failing gate — a miss is an adjudication, not a threshold bug):** after case-folding (`.toLowerCase()`) and street assembly: `house_number` agreement ≥ 0.97, `postcode` ≥ 0.97, `road`/street-family ≥ 0.90, measured over golden rows where the rules engine emitted that label.
- **Raw `classifier.parse(text, { postcodeRepair: true })` is the parse seam** — never `createRuntimePipeline`/`runPipeline` for parse-only surfaces (#566).
- **Wire contracts:** libpostal + nominatim response SHAPES are frozen (compat drop-ins); `/v1/parse`'s shape changes deliberately (v7 major) and its schema edit auto-cascades to the emitted OpenAPI + regenerated clients (client publish stays a separate manual dispatch — no action here).
- **Goldens are readonly** — gates read them, never rewrite them.
- Tabs; 4-line license headers on new files; explicit `.ts` relative imports; ZERO raw `process.env`/`process.argv`; acronym casing (`decodeAsJSON`-style).
- **Compile receipts mandatory:** every task reports `yarn tsc -b <workspace>` output; `yarn compile` before any spawned `out/cli.js`.
- Never kill by pattern — spawned servers die by their own child PID only.
- Commit per task; push + PR at the end. CI must stay green on every commit (gate suites skip where data is absent).

---

### Task 1: Tree-aware libpostal projection — `treeToParseMatches` + map extension

**Files:**

- Modify: `libpostal/engine.ts`
- Test: `libpostal/index.test.ts` (add cases)

**Interfaces:**

- Consumes: `AddressTree`/`AddressNode` from `@mailwoman/core` (`core/decoder/types.ts:59-150`).
- Produces: `treeToParseMatches(tree: AddressTree): ParseMatch[]` — reading-order `{classification, value}` with the street-name family (`street_prefix`, `street`, `street_prefix_particle`, `street_suffix`) assembled into ONE `street` match; plus `COMPONENT_TO_LIBPOSTAL` entries for `subregion → state_district`, `intersection_a → road`, `intersection_b → road`. Task 3 wires it; the existing route-layer `toLibpostalComponents` stays untouched.

- [ ] **Step 1: Write the failing tests** (append to `libpostal/index.test.ts`)

```ts
test("treeToParseMatches: assembles the street-name family into one street match, reading order", () => {
	const tree = {
		raw: "1600 East Sheldon Rd, Springfield",
		roots: [
			{
				tag: "street",
				value: "Sheldon",
				start: 5,
				end: 12,
				confidence: 0.9,
				children: [
					{ tag: "house_number", value: "1600", start: 0, end: 4, confidence: 0.95, children: [] },
					{ tag: "street_prefix", value: "East", start: 5, end: 9, confidence: 0.9, children: [] },
					{ tag: "street_suffix", value: "Rd", start: 18, end: 20, confidence: 0.9, children: [] },
				],
			},
			{ tag: "locality", value: "Springfield", start: 22, end: 33, confidence: 0.9, children: [] },
		],
	} as never

	expect(treeToParseMatches(tree)).toEqual([
		{ classification: "house_number", value: "1600" },
		{ classification: "street", value: "East Sheldon Rd" },
		{ classification: "locality", value: "Springfield" },
	])
})

test("COMPONENT_TO_LIBPOSTAL: plan-2 additions", () => {
	expect(COMPONENT_TO_LIBPOSTAL.subregion).toBe("state_district")
	expect(COMPONENT_TO_LIBPOSTAL.intersection_a).toBe("road")
	expect(COMPONENT_TO_LIBPOSTAL.intersection_b).toBe("road")
})
```

The `as never` cast is deliberate: the fixture is a structural `AddressTree` literal; import `treeToParseMatches` alongside the existing named imports.

- [ ] **Step 2: Run to verify failure**

Run: `yarn vitest --run libpostal/index.test.ts`
Expected: FAIL — `treeToParseMatches` is not exported.

- [ ] **Step 3: Implement in `libpostal/engine.ts`**

Add to `COMPONENT_TO_LIBPOSTAL` (after the `macroregion` line, keeping the record's style):

```ts
	subregion: "state_district",
	intersection_a: "road",
	intersection_b: "road",
```

Append below `toLibpostalComponents` (import `type AddressNode, type AddressTree` from `@mailwoman/core` at the top — if the barrel does not re-export them, use `@mailwoman/core/decoder`):

```ts
/** The street-name family assembled into a single `street` match (mirrors geocode-core's assembleStreetName). */
const STREET_NAME_TAGS = new Set(["street", "street_prefix", "street_prefix_particle", "street_suffix"])

/**
 * Flatten a neural `AddressTree` to reading-order raw matches for {@link LibpostalEngine.parse}.
 * The street node and its street-name children collapse into ONE `street` match (libpostal's `road`
 * is the full name); other children (house_number, unit) emit as their own matches. Values join with
 * a single space — original inter-part punctuation is not reconstructed.
 */
export function treeToParseMatches(tree: AddressTree): ParseMatch[] {
	const spans: Array<{ start: number; classification: string; value: string }> = []

	const visit = (node: AddressNode): void => {
		if (node.tag === "street") {
			const nameParts = [node, ...node.children.filter((child) => STREET_NAME_TAGS.has(child.tag))].sort(
				(a, b) => a.start - b.start
			)
			const first = nameParts[0]

			if (first) {
				spans.push({ start: first.start, classification: "street", value: nameParts.map((p) => p.value).join(" ") })
			}

			for (const child of node.children) {
				if (!STREET_NAME_TAGS.has(child.tag)) visit(child)
			}

			return
		}

		spans.push({ start: node.start, classification: node.tag, value: node.value })

		for (const child of node.children) {
			visit(child)
		}
	}

	for (const root of tree.roots) {
		visit(root)
	}

	return spans.sort((a, b) => a.start - b.start).map(({ classification, value }) => ({ classification, value }))
}
```

- [ ] **Step 4: Run tests + compile**

Run: `yarn vitest --run libpostal/index.test.ts` → all pass (existing + 2 new). Then `yarn tsc -b libpostal` → clean (receipt in report).

- [ ] **Step 5: Commit**

```bash
git add libpostal/engine.ts libpostal/index.test.ts
git commit -m "feat(libpostal): tree-aware projection — treeToParseMatches + map entries for neural tags"
```

---

### Task 2: `/v1/parse` → native neural output

**Files:**

- Modify: `api/engine.ts` (ParseOutcome), `api/schema.ts` (ParseOutcomeSchema), `mailwoman/api-engine.ts` (createServeEngine wiring)
- Modify: `mailwoman/test/api-engine.test.ts` (existing assertions on the old shape)
- Test: `mailwoman/test/v1-parse-gate.test.ts` (new — golden gate)

**Interfaces:**

- Consumes: `classifier.parse` (`neural/classifier.ts:313`), `decodeAsTuples`/`decodeAsXML` (`@mailwoman/core`), phase-0 golden `mailwoman/test-fixtures/legacy-golden/v1-parse-golden.jsonl`.
- Produces: new wire `ParseOutcome = { input: string; components: Array<{tag, value}>; tree: AddressTree; debug?: string }`. `engine.parse` is **undefined when weights are absent** → the existing 501 route path answers (replaces the rules always-on invariant; documented in the migration guide, plan 5).

- [ ] **Step 1: Redefine the engine contract** — `api/engine.ts`: delete the `SerializedSolution` import; replace the `ParseOutcome` interface:

```ts
import type { AddressTree } from "@mailwoman/core"

/** One parsed component in reading order (a `ComponentTag` + the covered text). */
export interface ParseComponent {
	tag: string
	value: string
}

/** One parse outcome: ordered components + the full decoded tree (the same language `/v1/resolve` speaks). */
export interface ParseOutcome {
	input: string
	components: ParseComponent[]
	tree: AddressTree
	debug?: string
}
```

- [ ] **Step 2: Mirror it on the wire** — `api/schema.ts`: replace `ParseOutcomeSchema` (keep the docstring habit — note it mirrors `ParseOutcome` in engine.ts):

```ts
export const ParseComponentSchema = z.object({ tag: z.string(), value: z.string() }).openapi("ParseComponent")

export const ParseOutcomeSchema = z
	.object({
		input: z.string(),
		components: z.array(ParseComponentSchema),
		tree: z.looseObject({ roots: z.array(z.unknown()) }),
		debug: z.string().optional(),
	})
	.openapi("ParseOutcome")
```

The `tree` shape is the same loose-tree idiom `ResolveResponseSchema` uses (`api/schema.ts:134-146`). Routes pass the outcome through untouched — no `api/routes.ts` change.

- [ ] **Step 3: Rewire `createServeEngine`** — `mailwoman/api-engine.ts`: delete the rules block (lines ~222-236: the `createAddressParser()` + old `parse` closure and the `createAddressParser`/`createDiagnosticReport` imports if now unused). Build `parse` from the neural classifier, decoupled from the WOF-data gate so parse degrades only on missing weights:

```ts
// Parse needs only the model weights — not the gazetteer. Load them independently of the
// WOF-data gate below so `/v1/parse` answers whenever weights resolve, even on a geocode-degraded boot.
let parse: MailwomanAPIEngine["parse"]

try {
	const neuralMod = await import("@mailwoman/neural")
	const parseClassifier = await neuralMod.NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })

	parse = async (address, opts) => {
		const tree = await parseClassifier.parse(address, { postcodeRepair: true })

		return {
			input: address,
			components: decodeAsTuples(tree).map(([tag, value]) => ({ tag, value })),
			tree,
			debug: opts.debug ? decodeAsXML(tree) : undefined,
		}
	}
} catch {
	// Weights unresolvable — leave parse undefined; the route answers 501 with its existing guard.
	console.error("createServeEngine: neural weights not found — /v1/parse disabled (501)")
}
```

Reuse the loaded module/classifier for the geocode stack below instead of importing twice (restructure the existing `neuralMod` import + `classifier` construction so weights load ONCE — the geocode path keeps its WOF gate and 503 behavior). `decodeAsTuples`/`decodeAsXML` import from `@mailwoman/core`. Update the degraded-branch returns (`{ engine: { parse, health }, … }`) so they carry the new `parse` (or undefined).

- [ ] **Step 4: Update existing engine tests** — `mailwoman/test/api-engine.test.ts`: rewrite the parse assertions from `{ input: {body,start,end}, solutions: […] }` to the new shape (`outcome.components` array, `outcome.tree.roots`). Read the file first; keep its structure.

- [ ] **Step 5: Golden gate test** — `mailwoman/test/v1-parse-gate.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Plan-2 gate: the neural `/v1/parse` engine vs the phase-0 rules golden
 *   (mailwoman/test-fixtures/legacy-golden/v1-parse-golden.jsonl). Structured comparison, not
 *   byte-equality (spec §Projection layer, Plan-2 amendment 3): pre-registered per-label agreement
 *   floors after case-folding + street assembly. Skips when neural weights are absent (CI).
 */

import { existsSync, readFileSync, realpathSync } from "node:fs"

import { describe, expect, test } from "vitest"

interface GoldenRow {
	input: string
	outcome: { solutions: Array<{ classifications: Record<string, string[]> }> }
}

function weightsPresent(): boolean {
	try {
		return existsSync(realpathSync("neural-weights-en-us/model.onnx"))
	} catch {
		return false
	}
}

const fold = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()

describe.skipIf(!weightsPresent())("v1-parse golden gate (neural vs rules baseline)", () => {
	test("pre-registered agreement floors hold", async () => {
		const { createServeEngine } = await import("../api-engine.ts")
		const { engine } = await createServeEngine()

		if (!engine.parse) throw new Error("weights present but parse engine missing")

		const rows = readFileSync("mailwoman/test-fixtures/legacy-golden/v1-parse-golden.jsonl", "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as GoldenRow)

		// Rules label → the fold of that label's golden value; street family concatenates for assembly parity.
		const FLOORS: Array<{ label: string; floor: number; neuralTags: string[] }> = [
			{ label: "house_number", floor: 0.97, neuralTags: ["house_number"] },
			{ label: "postcode", floor: 0.97, neuralTags: ["postcode"] },
			{
				label: "street",
				floor: 0.9,
				neuralTags: ["street_prefix", "street", "street_prefix_particle", "street_suffix"],
			},
		]

		const tallies = new Map(FLOORS.map((f) => [f.label, { hit: 0, total: 0 }]))

		for (const row of rows) {
			const golden = row.outcome.solutions[0]?.classifications ?? {}
			const outcome = await engine.parse(row.input, { debug: false })
			const byTag = new Map<string, string[]>()

			for (const { tag, value } of outcome.components) {
				byTag.set(tag, [...(byTag.get(tag) ?? []), value])
			}

			for (const { label, neuralTags } of FLOORS) {
				const goldenValues = golden[label]

				if (!goldenValues?.length) continue

				const tally = tallies.get(label)!
				tally.total++
				const neuralValue = neuralTags.flatMap((t) => byTag.get(t) ?? []).join(" ")

				if (fold(neuralValue) === fold(goldenValues.join(" "))) tally.hit++
			}
		}

		for (const { label, floor } of FLOORS) {
			const { hit, total } = tallies.get(label)!
			const rate = total ? hit / total : 1
			console.error(`gate ${label}: ${hit}/${total} = ${rate.toFixed(4)} (floor ${floor})`)
			expect(rate, `${label} agreement vs rules golden`).toBeGreaterThanOrEqual(floor)
		}
	}, 300_000)
})
```

- [ ] **Step 6: Run everything, capture receipts**

Run: `yarn vitest --run mailwoman/test/v1-parse-gate.test.ts mailwoman/test/api-engine.test.ts` (expect gate PASS with printed per-label rates — paste them in the report) → `yarn tsc -b` → `yarn compile && node mailwoman/out/cli.js openapi 2>/dev/null | head -5`? No — the openapi emit for the API surface: `node api/out/cli.js openapi 2>/dev/null || true`; if the api workspace has no CLI, emit via `mailwoman openapi`. Verify the emitted `ParseOutcome` component shows `components`/`tree` (grep the JSON). If a floor FAILS: do not lower it — report the per-label rate and the first 10 disagreeing inputs, then STOP for adjudication.

- [ ] **Step 7: Commit**

```bash
git add api/engine.ts api/schema.ts mailwoman/api-engine.ts mailwoman/test/api-engine.test.ts mailwoman/test/v1-parse-gate.test.ts
git commit -m "feat(api)!: /v1/parse speaks native neural output (components + tree); weights-gated 501"
```

---

### Task 3: libpostal `/parse` → neural engine

**Files:**

- Modify: `libpostal/cli.ts`
- Test: `libpostal/parse-gate.test.ts` (new)

**Interfaces:**

- Consumes: Task 1's `treeToParseMatches`; `NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })` (photon's pattern, `photon/cli.ts:118`); golden `libpostal/test-fixtures/parse-golden.jsonl`.
- Produces: `serve()` engine backed by neural; friendly weights pre-flight (exit 1 + install hint, photon message shape); the cli docstring's "neural BIO tagger" claim becomes true — update it to name `NeuralAddressClassifier`.

- [ ] **Step 1: Rewire `serve()`** in `libpostal/cli.ts` — replace the `createAddressParser` import with `NeuralAddressClassifier` from `@mailwoman/neural` + `treeToParseMatches` from `./index.ts` (export it from `libpostal/index.ts` if the barrel doesn't already re-export engine.ts wholesale — check). Replace the parser + engine block:

```ts
let classifier: NeuralAddressClassifier

try {
	classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
} catch {
	console.error(
		[
			"✗ no neural weights found — the /parse endpoint needs the model.",
			"",
			"  Install the weights package alongside the server:",
			"    npm i @mailwoman/neural-weights-en-us",
			"",
			"  Docs: https://mailwoman.sister.software/docs/switching/libpostal",
		].join("\n")
	)
	process.exit(1)
}

const engine: LibpostalEngine = {
	async parse(query) {
		return treeToParseMatches(await classifier.parse(query, { postcodeRepair: true }))
	},
	async expand(address) {
		const normalized = normalize(address).normalized
		const expanded = expandAbbreviations(normalized).text

		// Deterministic forms only; dedup while preserving order.
		return [...new Set([address, normalized, expanded])]
	},
}
```

`serve()` becomes `async` — update its invocation at the command dispatch accordingly. Update the file docstring (line ~10) to describe the real wiring. `/expand` untouched.

- [ ] **Step 2: Golden gate test** — `libpostal/parse-gate.test.ts`: same skeleton as Task 2's gate (license header, `weightsPresent()` via the same symlink probe path, `describe.skipIf`, 300s timeout). Body outline:

```ts
// Build the REAL engine exactly as cli.ts does, then replay through the route layer:
const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const engine: LibpostalEngine = {
	parse: async (q) => treeToParseMatches(await classifier.parse(q, { postcodeRepair: true })),
}
const app = createLibpostalApp(engine)
const KNOWN_LABELS = new Set([...Object.values(COMPONENT_TO_LIBPOSTAL), "cedex", "unknown"])

for (const row of goldenRows) {
	const res = await app.request("/parse?query=" + encodeURIComponent(row.input))
	// Wire-shape gate: status 200, and every returned label is a mapped libpostal label
	// or a known pass-through (a label outside KNOWN_LABELS fails the gate).
	// Agreement tally: group both bodies by label, join multi-values with a space,
	// compare with fold() for house_number (floor 0.97), postcode (0.97), road (0.90).
}
// Print the per-label rates, assert the floors.
```

- [ ] **Step 3: Run + receipts**

`yarn vitest --run libpostal/parse-gate.test.ts libpostal/index.test.ts` (paste rates), `yarn tsc -b libpostal`, then live smoke: `yarn compile && node libpostal/out/cli.js serve --port 8198 &` is FORBIDDEN as written — spawn via a foreground script or run the server in background through the harness, query `curl "http://127.0.0.1:8198/parse?query=30%20W%2026th%20St%2C%20New%20York%2C%20NY%2010010"`, verify labels are libpostal vocabulary, then kill ONLY the recorded child PID. Floor failure ⇒ report + STOP (no threshold edits).

- [ ] **Step 4: Commit**

```bash
git add libpostal/cli.ts libpostal/index.ts libpostal/parse-gate.test.ts
git commit -m "feat(libpostal)!: /parse backed by the neural classifier; weights pre-flight; golden gate"
```

---

### Task 4: nominatim — delete the second parse

**Files:**

- Modify: `nominatim/cli.ts`

**Interfaces:**

- Consumes: `GeocodeResult.house_number` / `.street` (`mailwoman/geocode-core.ts:55-100`, populated unconditionally at :765-766).
- Produces: one parse per `/search` instead of two; `road` becomes the full assembled street name (adjudicated improvement, spec Plan-2 amendment 3).

- [ ] **Step 1: Delete** the `streetParts` function (`cli.ts:77-88`), the `parser` construction (`cli.ts:180`), and the `createAddressParser` import (`cli.ts:30`). Replace the call site (`cli.ts:248-256`):

```ts
// The geocode result already carries the parse's street spans (#1041) — no second parse.
if (result.house_number) {
	resolved.address.house_number = result.house_number
}

if (result.street) {
	resolved.address.road = result.street
}
```

- [ ] **Step 2: Live golden comparison (lab host)** — `yarn compile`, then re-run the phase-0 capture against the new build into a SCRATCH path: temporarily copy `nominatim/dev-tools/capture-search-golden.run.ts` logic is NOT needed — instead run it as-is but redirect: `cp nominatim/dev-tools/capture-search-golden.run.ts /tmp/claude-1000/-home-lab-Projects-mailwoman/68bebf18-8fe3-4263-ae64-70c79a08f97c/scratchpad/capture-post-swap.ts`, edit the copy's `OUT_PATH` to the scratchpad, run it, then diff:

```bash
node /tmp/claude-1000/-home-lab-Projects-mailwoman/68bebf18-8fe3-4263-ae64-70c79a08f97c/scratchpad/capture-post-swap.ts
diff <(jq -c '{query, n: (.body|length)}' nominatim/test-fixtures/search-golden.jsonl) \
     <(jq -c '{query, n: (.body|length)}' /tmp/claude-1000/-home-lab-Projects-mailwoman/68bebf18-8fe3-4263-ae64-70c79a08f97c/scratchpad/search-golden.jsonl) | head -20
```

Expected: hit/miss structure identical (same queries answered/empty). Then field-level: extract `{query, house_number, road}` from both files with jq and diff — every difference must be classed: (a) `road` richer by prefix/suffix assembly = expected improvement; (b) `house_number` changed/lost = REGRESSION, stop and report; (c) result-set changes = investigate (the geocode path itself didn't change — any hit/miss diff is unexplained and blocks). Paste the classified diff summary in the report. Do NOT overwrite the committed golden.

- [ ] **Step 3: Receipts + commit**

`yarn tsc -b nominatim` clean; `yarn vitest --run nominatim/index.test.ts` (stub suites unaffected — receipt).

```bash
git add nominatim/cli.ts
git commit -m "feat(nominatim): derive streetParts from the geocode result — second parse deleted (#1041 fields)"
```

---

### Task 5: Branch receipts + PR

**Files:** none new (report + PR only)

- [ ] **Step 1: Full verification sweep** — `yarn tsc -b` (repo), `yarn vitest --run mailwoman/test/legacy-golden-integrity.test.ts` (goldens untouched), the three gate suites (paste all printed rates), `yarn lint` on touched files, `git status` clean.
- [ ] **Step 2: Push + PR** titled "Legacy excision plan 2: production surfaces off the rules parser", body carrying: the three swaps, the gate rates per label vs the pre-registered floors, the nominatim classified diff summary, and the note that `/v1/parse`'s wire change is the v7 breaking change (migration guide lands in plan 5). Same attribution trailers as phase 0.

---

## Self-Review Notes

- **Spec coverage:** §Projection layer (Task 1 + amendments), the three §Production swaps (Tasks 2-4), gates per §Evidence capture as amended (structured, pre-registered floors). Weights guard = plan 3; deletions (`--isolated`, `debug`, arbitration, eval legs, `createAddressParser` itself) = plan 4 — the symbol stays alive here (arbitration + eval harness importers, scout-verified).
- **Floors are pre-registered here, before any gate has run** — a failing floor stops the task for adjudication; it is never edited to pass.
- **Type consistency:** `ParseMatch`/`treeToParseMatches` (Task 1) are what Task 3 wires; `ParseComponent`/`ParseOutcome` (Task 2) match the schema mirror; `fold()` is defined identically in both gate tests (duplicated by design — the files must survive plan-4 deletions independently).
- **Known open judgment for implementers:** if `AddressTree`/`AddressNode` aren't exported from the `@mailwoman/core` barrel, use the `@mailwoman/core/decoder` subpath — and if THAT subpath is missing from the exports map, add it to BOTH maps (dev + publishConfig) per AGENTS.md.
