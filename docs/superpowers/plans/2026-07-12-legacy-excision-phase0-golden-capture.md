# Legacy Excision Phase 0 — Golden Capture & Archive Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the four golden-evidence artifacts (spec §Evidence capture) and prove the npm archive works, before any swap or deletion of the v1 rules parser lands.

**Architecture:** One-shot capture scripts live in each surface's workspace `dev-tools/` (pattern: `mailwoman/dev-tools/generate-trace-fixture.ts`). A static AST extractor rescues the parity corpus inputs+expectations from the 27 test files; capture scripts replay those inputs through the three production surfaces in-process (Hono `app.request()`) or via a self-spawned server (nominatim). Goldens are committed JSONL fixtures — readonly once committed (house rule: never patch, recapture).

**Tech Stack:** TypeScript source-under-node (no build step for scripts), `typescript` compiler API (AST extraction), vitest, Hono `app.request()`, `@mailwoman/core/utils` `readJSONL`/`writeJSONL`.

**Spec:** `docs/superpowers/specs/2026-07-12-legacy-rules-excision-design.md` (§Evidence capture). This is plan 1 of 5 in the v7.0.0 arc; plans 2–5 (projection+swaps, weights guard, excision, seal+ship) are written after this one lands.

## Global Constraints

- **Zero raw `process.env`/`process.argv`** — CI-enforced oxlint rule. The scripts below need neither (no flags; paths are constants). Do not add argument parsing.
- **Run scripts from the repo root** — all paths in the capture scripts are repo-root-relative.
- **Source-under-node:** relative imports use explicit `.ts` extensions. No new package subpaths (nothing here touches `exports` maps).
- **License headers:** every new `.ts` file starts with the standard 4-line header (`@copyright Sister Software` / `@license AGPL-3.0` / `@author Teffen Ellis, et al.`).
- **Tabs for indentation**; oxfmt formats staged files via the pre-commit hook — if the hook rejects, run `yarn format` and re-stage **only your files** (do not commit unrelated `.mdx` churn).
- **Acronym casing:** whole camelCase components (`readJSONL`, not `readJsonl`).
- **`yarn compile` before spawning any `out/cli.js`** — stale `out/` runs old code (Task 6).
- **Never kill by pattern** — the nominatim capture kills only the child PID it spawned (house rule after the photon outage).
- **Goldens are readonly artifacts once committed** — a bad capture is fixed by re-running the script, never by editing the JSONL.
- **Commit per task**, message prefix `feat(phase0):` / `test(phase0):` / `docs(phase0):` as appropriate. Do not push; PR at the end of the plan.

---

### Task 1: Archive probe — prove `@mailwoman/classifiers@6.x` + `mailwoman@6.x` work cold from the registry

**Files:**

- Create: `mailwoman/test-fixtures/legacy-golden/archive-probe.md`

**Interfaces:**

- Produces: a committed probe transcript. The seal step (plan 5) cites it; if the probe FAILS, STOP the plan and report — the fix is a 6.x patch release, decided by the operator.

- [ ] **Step 1: Run the cold-install probe**

```bash
PROBE_DIR=$(mktemp -d)
cd "$PROBE_DIR"
npm init -y > /dev/null
npm install mailwoman@6.0.0 @mailwoman/classifiers@6.0.0 2>&1 | tail -3
node --input-type=module -e '
import { createAddressParser } from "mailwoman"
const parser = createAddressParser()
const solutions = await parser.parse("30 W 26th St, New York, NY 10010")
if (!solutions.length) throw new Error("no solutions")
console.log(JSON.stringify(solutions[0], null, "\t").slice(0, 600))
console.log("PROBE OK:", solutions.length, "solutions")
'
cd /home/lab/Projects/mailwoman
```

Expected: npm install completes without `EUNSUPPORTEDPROTOCOL` (the `workspace:*` translation held), and the node one-liner prints a solution JSON then `PROBE OK: <n> solutions`. If `parser.parse(...)` returns an object instead of an array in this published version, adapt the one-liner to `(await parser.parse(q, {verbose:true})).solutions` and note the shape in the transcript.

- [ ] **Step 2: Write the transcript**

Create `mailwoman/test-fixtures/legacy-golden/archive-probe.md` containing: the date, the exact commands from Step 1, the tail of the npm install output, the printed solution excerpt, and the `PROBE OK` line. Format:

```markdown
# Archive probe — @mailwoman/classifiers@6.0.0 + mailwoman@6.0.0

**Date:** 2026-07-12
**Verdict:** PASS — cold install from the registry constructs and runs the v1 parser.

## Commands

(paste Step 1 commands)

## Output

(paste install tail + solution excerpt + PROBE OK line)
```

- [ ] **Step 3: Commit**

```bash
git add mailwoman/test-fixtures/legacy-golden/archive-probe.md
git commit -m "docs(phase0): archive probe — classifiers@6.0.0 works cold from the registry"
```

---

### Task 2: Parity-corpus extractor — rescue the 27 files' inputs + expectations as JSONL

**Files:**

- Create: `mailwoman/dev-tools/parity-extract.ts` (library)
- Create: `mailwoman/dev-tools/parity-extract.test.ts`
- Create: `mailwoman/dev-tools/extract-parity-corpus.run.ts` (entry script)
- Output: `mailwoman/test-fixtures/legacy-golden/parity-inputs.jsonl`

**Interfaces:**

- Produces: `ParityCase = { file: string; input: string; expected: unknown[]; nonLiteral?: boolean }` — one JSONL row per `assert()` call. Tasks 3–6 consume `parity-inputs.jsonl`; plan 4's parity conversion consumes the same file.

- [ ] **Step 1: Write the failing test**

`mailwoman/dev-tools/parity-extract.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { extractAssertCalls } from "./parity-extract.ts"

const SAMPLE = `
import { assert } from "mailwoman/test-kit"

assert(
	"wrigley field",
	{
		street: ["wrigley field"],
	},
	{
		venue: ["wrigley field"],
	}
)

assert(
	// ---
	"E Cesar Chavez St",
	{
		street: ["E Cesar Chavez St"],
	}
)

assert("no expectations means no solutions")
`

test("extractAssertCalls: literal inputs + expected records, in file order", () => {
	const cases = extractAssertCalls(SAMPLE, "mailwoman/test/address.usa.test.ts")

	expect(cases).toEqual([
		{
			file: "mailwoman/test/address.usa.test.ts",
			input: "wrigley field",
			expected: [{ street: ["wrigley field"] }, { venue: ["wrigley field"] }],
		},
		{
			file: "mailwoman/test/address.usa.test.ts",
			input: "E Cesar Chavez St",
			expected: [{ street: ["E Cesar Chavez St"] }],
		},
		{
			file: "mailwoman/test/address.usa.test.ts",
			input: "no expectations means no solutions",
			expected: [],
		},
	])
})

test("extractAssertCalls: non-literal expected args are recorded as source text and flagged", () => {
	const source = `assert("x", someHelper("y"))`
	const cases = extractAssertCalls(source, "f.test.ts")

	expect(cases).toEqual([{ file: "f.test.ts", input: "x", expected: [`someHelper("y")`], nonLiteral: true }])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest --run mailwoman/dev-tools/parity-extract.test.ts`
Expected: FAIL — `Cannot find module './parity-extract.ts'` (or equivalent resolution error).

- [ ] **Step 3: Write the extractor library**

`mailwoman/dev-tools/parity-extract.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phase-0 legacy excision (spec 2026-07-12): statically extract the `assert(input, ...expected)`
 *   calls from the v1 parity suite (`mailwoman/test/*.test.ts`) so the hand-written inputs +
 *   expectations survive the parser they currently exercise. Literal-only conversion — an expected
 *   arg that isn't a plain JSON literal is recorded as its source text with `nonLiteral: true`.
 */

import ts from "typescript"

export interface ParityCase {
	/** Repo-relative source file the assertion came from. */
	file: string
	/** The address input under test. */
	input: string
	/** The hand-written expected classification records (JSON values), file order preserved. */
	expected: unknown[]
	/** Set when an expected arg wasn't a pure literal; that slot in `expected` holds source text. */
	nonLiteral?: boolean
}

function literalToJSON(node: ts.Expression): { ok: true; value: unknown } | { ok: false } {
	if (ts.isStringLiteralLike(node)) return { ok: true, value: node.text }
	if (ts.isNumericLiteral(node)) return { ok: true, value: Number(node.text) }
	if (node.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true }
	if (node.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false }
	if (node.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null }

	if (ts.isArrayLiteralExpression(node)) {
		const out: unknown[] = []

		for (const element of node.elements) {
			const value = literalToJSON(element)

			if (!value.ok) return { ok: false }
			out.push(value.value)
		}

		return { ok: true, value: out }
	}

	if (ts.isObjectLiteralExpression(node)) {
		const out: Record<string, unknown> = {}

		for (const property of node.properties) {
			if (!ts.isPropertyAssignment(property)) return { ok: false }

			const name =
				ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : undefined

			if (name === undefined) return { ok: false }

			const value = literalToJSON(property.initializer)

			if (!value.ok) return { ok: false }
			out[name] = value.value
		}

		return { ok: true, value: out }
	}

	return { ok: false }
}

/** Extract every top-level-or-nested `assert("input", ...records)` call from one source text. */
export function extractAssertCalls(sourceText: string, fileName: string): ParityCase[] {
	const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true)
	const cases: ParityCase[] = []

	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "assert" &&
			node.arguments.length > 0 &&
			ts.isStringLiteralLike(node.arguments[0])
		) {
			const input = node.arguments[0].text
			const expected: unknown[] = []
			let nonLiteral = false

			for (const arg of node.arguments.slice(1)) {
				const value = literalToJSON(arg)

				if (value.ok) {
					expected.push(value.value)
				} else {
					nonLiteral = true
					expected.push(arg.getText(source))
				}
			}

			cases.push(nonLiteral ? { file: fileName, input, expected, nonLiteral } : { file: fileName, input, expected })
		}

		ts.forEachChild(node, visit)
	}

	visit(source)

	return cases
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest --run mailwoman/dev-tools/parity-extract.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the entry script**

`mailwoman/dev-tools/extract-parity-corpus.run.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phase-0 entry: walk the v1 parity suite, extract every `assert()` case, write
 *   `mailwoman/test-fixtures/legacy-golden/parity-inputs.jsonl`. Run from the repo root:
 *   `node mailwoman/dev-tools/extract-parity-corpus.run.ts`
 */

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { writeJSONL } from "@mailwoman/core/utils"

import { extractAssertCalls, type ParityCase } from "./parity-extract.ts"

const TEST_DIR = "mailwoman/test"
const OUT_PATH = "mailwoman/test-fixtures/legacy-golden/parity-inputs.jsonl"

const cases: ParityCase[] = []
let parityFileCount = 0

for (const entry of readdirSync(TEST_DIR).sort()) {
	if (!entry.endsWith(".test.ts")) continue

	const path = join(TEST_DIR, entry)
	const text = readFileSync(path, "utf8")

	// Only the parity suite imports the shared rules-parser test-kit.
	if (!text.includes(`from "mailwoman/test-kit"`)) continue

	parityFileCount++
	cases.push(...extractAssertCalls(text, path))
}

const written = writeJSONL(OUT_PATH, cases)
const nonLiteralCount = cases.filter((c) => c.nonLiteral).length

console.error(
	`extracted ${written} assert() cases from ${parityFileCount} parity files (${nonLiteralCount} non-literal)`
)
```

- [ ] **Step 6: Run the extractor**

Run: `node mailwoman/dev-tools/extract-parity-corpus.run.ts`
Expected: `extracted <N> assert() cases from 27 parity files (<M> non-literal)` with N = 376 (measured: grep of assert( call sites across the 27 files = 376, verified 2026-07-12; the original ≥400 was an estimate) and M small (likely 0). If parity file count ≠ 27, list the test-kit importers (`grep -l 'mailwoman/test-kit' mailwoman/test/*.test.ts`) and reconcile before proceeding. Spot-check: `head -2 mailwoman/test-fixtures/legacy-golden/parity-inputs.jsonl` shows well-formed rows.

- [ ] **Step 7: Commit**

```bash
git add mailwoman/dev-tools/parity-extract.ts mailwoman/dev-tools/parity-extract.test.ts mailwoman/dev-tools/extract-parity-corpus.run.ts mailwoman/test-fixtures/legacy-golden/parity-inputs.jsonl
git commit -m "feat(phase0): extract v1 parity corpus (27 files) to committed JSONL"
```

---

### Task 3: A4 — raw rules-parser output per parity case

**Files:**

- Create: `mailwoman/dev-tools/capture-parity-raw.run.ts`
- Output: `mailwoman/test-fixtures/legacy-golden/parity-raw.jsonl`

**Interfaces:**

- Consumes: `parity-inputs.jsonl` (Task 2).
- Produces: rows `{ file, input, expected, solutions }` where `solutions` = top-3 verbose `solution.toJSON()` (includes `matches: [{classification, value, …}]`). Plan 4's conversion triage diffs `expected` vs `solutions` vs the neural output.

- [ ] **Step 1: Write the capture script**

`mailwoman/dev-tools/capture-parity-raw.run.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phase-0: replay every parity input through the v1 rules parser and commit the raw solved
 *   output. This is the triage artifact for the parity-corpus conversion — it distinguishes
 *   "the neural parse changed" from "the hand-written assertion encoded a rules idiosyncrasy".
 *   Run from the repo root: `node mailwoman/dev-tools/capture-parity-raw.run.ts`
 */

import { readJSONL, writeJSONL } from "@mailwoman/core/utils"
import { createAddressParser } from "mailwoman"

import { type ParityCase } from "./parity-extract.ts"

const IN_PATH = "mailwoman/test-fixtures/legacy-golden/parity-inputs.jsonl"
const OUT_PATH = "mailwoman/test-fixtures/legacy-golden/parity-raw.jsonl"

const parser = createAddressParser()
const cases = readJSONL<ParityCase>(IN_PATH)
const rows: unknown[] = []

for (const parityCase of cases) {
	const result = await parser.parse(parityCase.input, { verbose: true })

	rows.push({
		file: parityCase.file,
		input: parityCase.input,
		expected: parityCase.expected,
		solutions: result.solutions.slice(0, 3).map((solution) => solution.toJSON()),
	})
}

writeJSONL(OUT_PATH, rows)
console.error(`captured raw rules output for ${rows.length} parity cases`)
```

- [ ] **Step 2: Run it**

Run: `node mailwoman/dev-tools/capture-parity-raw.run.ts`
Expected: `captured raw rules output for <N> parity cases` with N equal to Task 2's count. Check size: `ls -lh mailwoman/test-fixtures/legacy-golden/parity-raw.jsonl` — if over ~15 MB, change `slice(0, 3)` to `slice(0, 1)` and re-run (the top solution is the one test-kit asserts against).

- [ ] **Step 3: Spot-check one row**

Run: `head -1 mailwoman/test-fixtures/legacy-golden/parity-raw.jsonl | node --input-type=module -e "process.stdin.once('data',(d)=>{const r=JSON.parse(d);console.log(r.input, '→', JSON.stringify(r.solutions[0]?.matches ?? r.solutions[0]).slice(0,200))})"`
Expected: the first parity input with its solved matches (classification + value pairs).

- [ ] **Step 4: Commit**

```bash
git add mailwoman/dev-tools/capture-parity-raw.run.ts mailwoman/test-fixtures/legacy-golden/parity-raw.jsonl
git commit -m "feat(phase0): capture raw v1 rules output per parity case (A4)"
```

---

### Task 4: A1 — `/v1/parse` engine goldens (+ the rare-label synthetic inputs)

**Files:**

- Create: `mailwoman/test-fixtures/legacy-golden/synthetic-inputs.txt`
- Create: `mailwoman/dev-tools/capture-v1-parse.run.ts`
- Output: `mailwoman/test-fixtures/legacy-golden/v1-parse-golden.jsonl`

**Interfaces:**

- Consumes: `parity-inputs.jsonl` (Task 2), `createServeEngine()` from `mailwoman/api-engine.ts` (`engine.parse(address, { debug: boolean }) → Promise<ParseOutcome>`).
- Produces: rows `{ input, outcome: ParseOutcome }`. Plan 2's `/v1/parse` swap gate compares its neural output against these **semantically** (component level via the taxonomy bridge — the wire shape changes by design, spec §Evidence capture).

- [ ] **Step 1: Write the synthetic inputs file**

`mailwoman/test-fixtures/legacy-golden/synthetic-inputs.txt` — rare-label coverage (`po_box`, `unit`, `level`, `staircase`, `entrance`, venue, chain, intersection, care-of), exactly this content:

```text
PO Box 1234, Springfield IL 62701
P.O. Box 88, Portland, OR 97201
Postfach 10 01 10, 60311 Frankfurt am Main
Apt 4B, 350 5th Ave, New York, NY 10118
350 5th Ave Apt 4B, New York, NY 10118
Unit 12, 200 George St, Sydney NSW 2000
Level 3, 100 Collins St, Melbourne VIC 3000
Suite 900, 1 Market St, San Francisco, CA 94105
Flat 2, 10 Downing Street, London SW1A 2AA
3rd Floor, 1 Canada Square, London E14 5AB
30 W 26th St 6th Floor, New York, NY 10010
Stiege 2 Tür 14, Praterstraße 5, 1020 Wien
Eingang B, Hauptstraße 12, 10827 Berlin
escalera 2, planta 3, Calle de Alcalá 45, 28014 Madrid
Piso 2, puerta B, Gran Vía 28, 28013 Madrid
Trappa 3, Drottninggatan 71A, 111 36 Stockholm
opgang 2, Nørrebrogade 155, 2200 København N
Bâtiment C, 12 Rue de Rivoli, 75004 Paris
12 Rue de Rivoli, appartement 34, 75004 Paris
Main St & 3rd Ave, Columbus, OH
Hollywood Blvd and Vine St, Los Angeles, CA
Empire State Building, 350 5th Ave, New York, NY
CVS Pharmacy, 630 Lexington Ave, New York, NY
221B Baker Street, London NW1 6XE
1600 Amphitheatre Pkwy, Mountain View, CA 94043
1 Infinite Loop, Cupertino, CA 95014
c/o John Smith, 500 Oak Ln, Austin TX 78701
1-chōme-1-2 Ōtemachi, Chiyoda City, Tōkyō 100-0004
```

- [ ] **Step 2: Write the capture script**

`mailwoman/dev-tools/capture-v1-parse.run.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phase-0: golden `/v1/parse` outcomes from the CURRENT (rules-backed) serve engine, captured at
 *   the engine layer (`createServeEngine().engine.parse`) — the semantic content of the endpoint.
 *   The route/wire wrapper is exercised by `@mailwoman/api`'s own tests, and the v7 swap changes
 *   the wire shape by design, so the gate built on this artifact compares components, not bytes.
 *   Run from the repo root: `node mailwoman/dev-tools/capture-v1-parse.run.ts`
 */

import { readFileSync } from "node:fs"

import { readJSONL, writeJSONL } from "@mailwoman/core/utils"

import { createServeEngine } from "../api-engine.ts"
import { type ParityCase } from "./parity-extract.ts"

const PARITY_PATH = "mailwoman/test-fixtures/legacy-golden/parity-inputs.jsonl"
const SYNTHETIC_PATH = "mailwoman/test-fixtures/legacy-golden/synthetic-inputs.txt"
const OUT_PATH = "mailwoman/test-fixtures/legacy-golden/v1-parse-golden.jsonl"

const parityInputs = readJSONL<ParityCase>(PARITY_PATH).map((c) => c.input)
const syntheticInputs = readFileSync(SYNTHETIC_PATH, "utf8")
	.split("\n")
	.map((line) => line.trim())
	.filter(Boolean)

const inputs = [...new Set([...parityInputs, ...syntheticInputs])]

const { engine, preflight } = await createServeEngine()

if (!preflight.ok) {
	// Degraded boot still serves /v1/parse (rules need no gazetteer) — fine for this capture.
	console.error("note: serve engine booted degraded (parse-only); capture proceeds")
}

if (!engine.parse) throw new Error("serve engine has no parse handler")

const rows: unknown[] = []

for (const input of inputs) {
	rows.push({ input, outcome: await engine.parse(input, { debug: false }) })
}

writeJSONL(OUT_PATH, rows)
console.error(`captured ${rows.length} /v1/parse outcomes`)
```

- [ ] **Step 3: Run it**

Run: `node mailwoman/dev-tools/capture-v1-parse.run.ts`
Expected: `captured <N> /v1/parse outcomes` where N = unique parity inputs + 28 synthetics. (A `note: … degraded` line is acceptable only if the lab data-root is unavailable; on the lab host expect a full boot.) Size check as in Task 3.

- [ ] **Step 4: Commit**

```bash
git add mailwoman/test-fixtures/legacy-golden/synthetic-inputs.txt mailwoman/dev-tools/capture-v1-parse.run.ts mailwoman/test-fixtures/legacy-golden/v1-parse-golden.jsonl
git commit -m "feat(phase0): capture /v1/parse rules-engine goldens + rare-label synthetics (A1)"
```

---

### Task 5: A2 — libpostal drop-in `/parse` wire goldens

**Files:**

- Create: `libpostal/dev-tools/capture-parse-golden.run.ts`
- Output: `libpostal/test-fixtures/parse-golden.jsonl`

**Interfaces:**

- Consumes: `createLibpostalApp`, `LibpostalEngine`, `ParseMatch` from `libpostal/index.ts`; the engine construction mirrors `libpostal/cli.ts:40-59` exactly (same parser, same mapping).
- Produces: rows `{ input, status, body }` where `body` is the exact wire JSON (`[{label, value}]`). Plan 2's libpostal swap gate is **byte-level** non-regression against these.

- [ ] **Step 1: Write the capture script**

`libpostal/dev-tools/capture-parse-golden.run.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phase-0: golden `/parse` wire responses from the CURRENT (rules-backed) libpostal drop-in,
 *   captured in-process via Hono's `app.request()` — exact bytes of the compatibility contract.
 *   The engine below mirrors `cli.ts`'s `serve()` wiring verbatim. Run from the repo root:
 *   `node libpostal/dev-tools/capture-parse-golden.run.ts`
 */

import { readFileSync, writeFileSync } from "node:fs"

import { createAddressParser } from "mailwoman"

import { createLibpostalApp, type LibpostalEngine, type ParseMatch } from "../index.ts"

const PARITY_PATH = "mailwoman/test-fixtures/legacy-golden/parity-inputs.jsonl"
const SYNTHETIC_PATH = "mailwoman/test-fixtures/legacy-golden/synthetic-inputs.txt"
const OUT_PATH = "libpostal/test-fixtures/parse-golden.jsonl"

const parityInputs = readFileSync(PARITY_PATH, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => (JSON.parse(line) as { input: string }).input)
const syntheticInputs = readFileSync(SYNTHETIC_PATH, "utf8")
	.split("\n")
	.map((line) => line.trim())
	.filter(Boolean)

const inputs = [...new Set([...parityInputs, ...syntheticInputs])]

// Mirrors cli.ts serve() — the /parse leg only (expand is normalize-backed and doesn't change in v7).
const parser = createAddressParser()
const engine: LibpostalEngine = {
	async parse(query) {
		const result = await parser.parse(query, { verbose: true })
		const solution = result.solutions[0]

		if (!solution) return []
		const json = solution.toJSON() as { matches?: ParseMatch[] }

		return (json.matches ?? []).map((m) => ({ classification: m.classification, value: m.value }))
	},
}

const app = createLibpostalApp(engine)
const rows: string[] = []

for (const input of inputs) {
	const res = await app.request(`/parse?query=${encodeURIComponent(input)}`)

	rows.push(JSON.stringify({ input, status: res.status, body: await res.json() }))
}

writeFileSync(OUT_PATH, rows.join("\n") + "\n")
console.error(`captured ${rows.length} libpostal /parse responses`)
```

- [ ] **Step 2: Run it**

Run: `node libpostal/dev-tools/capture-parse-golden.run.ts`
Expected: `captured <N> libpostal /parse responses`, N matching Task 4's count. Spot-check: `head -1 libpostal/test-fixtures/parse-golden.jsonl` shows `{"input":…,"status":200,"body":[{"label":…,"value":…}…]}`.

- [ ] **Step 3: Commit**

```bash
git add libpostal/dev-tools/capture-parse-golden.run.ts libpostal/test-fixtures/parse-golden.jsonl
git commit -m "feat(phase0): capture libpostal /parse wire goldens (A2)"
```

---

### Task 6: A3 — nominatim `/search` full-response goldens

**Files:**

- Create: `nominatim/dev-tools/capture-search-golden.run.ts`
- Output: `nominatim/test-fixtures/search-golden.jsonl`

**Interfaces:**

- Consumes: `parity-inputs.jsonl` + `synthetic-inputs.txt`; the compiled `nominatim/out/cli.js serve` (spawned as an own child on port 8199 — full stack: weights + gazetteer from the lab data-root).
- Produces: rows `{ query, status, body }` — full `/search?format=jsonv2&addressdetails=1` wire responses. Plan 2's `streetParts` rework gate is byte-level against these.

- [ ] **Step 1: Compile (spawning `out/cli.js` — stale builds run old code)**

Run: `yarn compile`
Expected: exits 0.

- [ ] **Step 2: Write the capture script**

`nominatim/dev-tools/capture-search-golden.run.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phase-0: golden `/search` wire responses from the CURRENT nominatim drop-in (neural geocode +
 *   rules streetParts recovery). Spawns its own server child on a scratch port and kills ONLY that
 *   PID (house rule: never kill by pattern). Needs the lab data-root (weights + gazetteer).
 *   Run from the repo root AFTER `yarn compile`:
 *   `node nominatim/dev-tools/capture-search-golden.run.ts`
 */

import { spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

const PORT = 8199
const BASE = `http://127.0.0.1:${PORT}`
const PARITY_PATH = "mailwoman/test-fixtures/legacy-golden/parity-inputs.jsonl"
const SYNTHETIC_PATH = "mailwoman/test-fixtures/legacy-golden/synthetic-inputs.txt"
const OUT_PATH = "nominatim/test-fixtures/search-golden.jsonl"

interface ParityRow {
	input: string
	expected: Array<Record<string, unknown> | string>
}

const parity = readFileSync(PARITY_PATH, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line) as ParityRow)

// The streetParts leg only fires when a house number is in play — feed it the cases that have one.
const withHouseNumber = parity
	.filter((row) =>
		row.expected.some((record) => typeof record === "object" && record !== null && "house_number" in record)
	)
	.map((row) => row.input)

const syntheticInputs = readFileSync(SYNTHETIC_PATH, "utf8")
	.split("\n")
	.map((line) => line.trim())
	.filter(Boolean)

const queries = [...new Set([...withHouseNumber.slice(0, 172), ...syntheticInputs])]

const child = spawn("node", ["nominatim/out/cli.js", "serve", "--port", String(PORT)], {
	stdio: ["ignore", "inherit", "inherit"],
})

try {
	const deadline = Date.now() + 180_000

	// Model + gazetteer boot takes a while; poll /status until the server answers.
	for (;;) {
		try {
			const res = await fetch(`${BASE}/status`)

			if (res.ok) break
		} catch {
			// Not listening yet.
		}

		if (Date.now() > deadline) throw new Error("nominatim serve did not become ready within 180s")
		await new Promise((resolve) => setTimeout(resolve, 1000))
	}

	const rows: string[] = []

	for (const query of queries) {
		const res = await fetch(`${BASE}/search?q=${encodeURIComponent(query)}&format=jsonv2&addressdetails=1`)

		rows.push(JSON.stringify({ query, status: res.status, body: await res.json() }))
	}

	writeFileSync(OUT_PATH, rows.join("\n") + "\n")
	console.error(
		`captured ${rows.length} /search responses (${withHouseNumber.length} house-number parity cases available)`
	)
} finally {
	child.kill("SIGTERM")
}
```

- [ ] **Step 3: Run it**

Run: `node nominatim/dev-tools/capture-search-golden.run.ts`
Expected: server boot chatter on stderr, then `captured <N> /search responses (…)` with 100 ≤ N ≤ 200. If the parity corpus yields fewer than 100 house-number cases, do NOT pad with invented queries — capture what exists and note the count in the commit message.

- [ ] **Step 4: Verify the child is gone**

Run: `ss -ltn | grep 8199 || echo "port free"`
Expected: `port free`.

- [ ] **Step 5: Commit**

```bash
git add nominatim/dev-tools/capture-search-golden.run.ts nominatim/test-fixtures/search-golden.jsonl
git commit -m "feat(phase0): capture nominatim /search full-response goldens (A3)"
```

---

### Task 7: Golden-integrity test — CI protects the artifacts

**Files:**

- Create: `mailwoman/test/legacy-golden-integrity.test.ts`

**Interfaces:**

- Consumes: all five committed fixtures (Tasks 2–6).
- Produces: a CI guarantee that the goldens stay parseable and populated until plans 2–4 consume them. Plan 4 deletes this test together with the legacy suite it escorts.

- [ ] **Step 1: Write the test**

`mailwoman/test/legacy-golden-integrity.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phase-0 legacy excision: integrity guard for the committed golden artifacts (spec §Evidence
 *   capture). These files are the non-regression references for the v7 production swaps; this
 *   test fails if one goes missing, truncates, or stops parsing. Deleted in plan 4 along with the
 *   legacy suite once the swaps have landed and their gates carry the load.
 */

import { readFileSync } from "node:fs"

import { expect, test } from "vitest"

function readRows(path: string): unknown[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
}

test("parity-inputs.jsonl: every row has a file, an input, and expected records", () => {
	const rows = readRows("mailwoman/test-fixtures/legacy-golden/parity-inputs.jsonl") as Array<{
		file?: string
		input?: string
		expected?: unknown[]
	}>

	expect(rows.length).toBeGreaterThanOrEqual(370)

	for (const row of rows) {
		expect(typeof row.file).toBe("string")
		expect(typeof row.input).toBe("string")
		expect(Array.isArray(row.expected)).toBe(true)
	}
})

test("parity-raw.jsonl: aligned 1:1 with parity-inputs", () => {
	const inputs = readRows("mailwoman/test-fixtures/legacy-golden/parity-inputs.jsonl")
	const raw = readRows("mailwoman/test-fixtures/legacy-golden/parity-raw.jsonl") as Array<{ solutions?: unknown[] }>

	expect(raw.length).toBe(inputs.length)

	for (const row of raw) {
		expect(Array.isArray(row.solutions)).toBe(true)
	}
})

test("v1-parse-golden.jsonl: outcomes carry solutions arrays", () => {
	const rows = readRows("mailwoman/test-fixtures/legacy-golden/v1-parse-golden.jsonl") as Array<{
		input?: string
		outcome?: { solutions?: unknown[] }
	}>

	expect(rows.length).toBeGreaterThanOrEqual(350)

	for (const row of rows) {
		expect(typeof row.input).toBe("string")
		expect(Array.isArray(row.outcome?.solutions)).toBe(true)
	}
})

test("libpostal parse-golden.jsonl: wire rows are [{label, value}] under status 200", () => {
	const rows = readRows("libpostal/test-fixtures/parse-golden.jsonl") as Array<{
		status?: number
		body?: Array<{ label?: string; value?: string }>
	}>

	expect(rows.length).toBeGreaterThanOrEqual(350)

	for (const row of rows) {
		expect(row.status).toBe(200)

		for (const component of row.body ?? []) {
			expect(typeof component.label).toBe("string")
			expect(typeof component.value).toBe("string")
		}
	}
})

test("nominatim search-golden.jsonl: full responses captured", () => {
	const rows = readRows("nominatim/test-fixtures/search-golden.jsonl") as Array<{ query?: string; status?: number }>

	expect(rows.length).toBeGreaterThanOrEqual(100)

	for (const row of rows) {
		expect(typeof row.query).toBe("string")
		expect(typeof row.status).toBe("number")
	}
})
```

- [ ] **Step 2: Run it**

Run: `yarn vitest --run mailwoman/test/legacy-golden-integrity.test.ts`
Expected: PASS (5 tests). If a count assertion fails, the corresponding capture undershot — revisit that task; do not lower the threshold to green the test.

- [ ] **Step 3: Commit**

```bash
git add mailwoman/test/legacy-golden-integrity.test.ts
git commit -m "test(phase0): integrity guard for the legacy golden artifacts"
```

---

### Task 8: File the arc's board issues + open the phase-0 PR

**Files:** none (GitHub side effects only)

- [ ] **Step 1: File the four board issues from spec §Board issues**

```bash
gh issue create --title "v7 excision: parity-corpus conversion to neural eval fixtures" \
  --body "Convert the rescued v1 parity corpus (mailwoman/test-fixtures/legacy-golden/parity-inputs.jsonl, captured per docs/superpowers/specs/2026-07-12-legacy-rules-excision-design.md §Parity-corpus rescue) into neural eval fixtures. Triage buckets: convert-straight / translate-via-legacyClassificationToComponentTag / drop-as-idiosyncratic (given_name, surname, personal_title, tokenization-quirk cases). Every converted fixture carries provenance: v1-parity:<country>: \"<address>\" mapped: <old→new>. Per-country checklist to follow in the plan-4 PR."

gh issue create --title "v7 excision: libpostal house/near/category labels — revisit if golden gate shows traffic" \
  --body "The toLibpostal projection omits (log-once) libpostal labels the ComponentTag taxonomy can't distinguish: house, near, category. The A2 golden gate (libpostal/test-fixtures/parse-golden.jsonl) will show whether real traffic hits them. If it does, decide a mapping; if not, close after the v7 swaps land. Spec: docs/superpowers/specs/2026-07-12-legacy-rules-excision-design.md §Projection layer."

gh issue create --title "Multilingual directional/suffix lookup helper over libpostal dictionary data" \
  --body "The v7 excision deletes the legacy multilingual DirectionalClassifier/StreetSuffixClassifier; codex/us/* covers US only. The libpostal dictionary DATA stays (core/data/libpostal — live corpus/FST dep). If a consumer needs a multilingual directional/suffix lookup helper, build it codex-style over that data. Not scheduled — demand-driven."

gh issue create --title "variant-aliases has zero runtime importers" \
  --body "Noted while surveying for the v7 excision (unaffected by it): @mailwoman/variant-aliases exports lookupVariantAliases/getAllAliases with no runtime consumers (#166 context). Decide: wire into the pipeline or park explicitly."
```

Expected: four issue URLs printed.

- [ ] **Step 2: Push the branch and open the PR**

Work happened on a branch (create `feat/legacy-excision-phase0` from main before Task 1 if not already on it — if tasks were committed to main locally, move them: `git branch feat/legacy-excision-phase0 && git reset --hard origin/main && git switch feat/legacy-excision-phase0`).

```bash
git push -u origin feat/legacy-excision-phase0
gh pr create --title "Legacy excision phase 0: golden capture + archive probe" \
  --body "$(cat <<'EOF'
Phase 0 of the v7.0.0 legacy rules-parser excision (spec: docs/superpowers/specs/2026-07-12-legacy-rules-excision-design.md).

Captures the four golden-evidence artifacts while the v1 parser still runs, plus the registry cold-install probe:

- A1 `/v1/parse` engine goldens (semantic gate for the neural swap)
- A2 libpostal `/parse` wire goldens (byte-level gate)
- A3 nominatim `/search` full-response goldens (byte-level gate for the streetParts rework)
- A4 raw rules output per parity assertion (conversion triage)
- Archive probe: `@mailwoman/classifiers@6.0.0` + `mailwoman@6.0.0` verified working cold from npm
- Parity corpus rescued to committed JSONL (extractor + integrity guard in CI)

No production code changes. Goldens are readonly artifacts — regenerate via the dev-tools scripts, never edit.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01JzDCii56StaYW7swvA41yC
EOF
)"
```

Expected: PR URL printed; CI green (the new test + the untouched full suite).

---

## Self-Review Notes

- **Spec coverage:** §Evidence capture — all four artifacts (Tasks 3–6) + the probe (Task 1) + "committed as fixtures" (Tasks 2–6) + CI protection (Task 7). §Board issues — Task 8. Remaining spec sections belong to plans 2–5 by design.
- **The probe can fail:** Task 1 explicitly stops the plan for an operator decision (6.x patch) — per spec, this is the one blocking outcome.
- **Type consistency:** `ParityCase` is defined once (Task 2) and imported by Tasks 3–4; the drop-in scripts (Tasks 5–6) parse rows structurally (no cross-workspace type import, avoiding new package dependencies).
- **No placeholders:** every script/test is complete; the only adaptive instructions are guarded fallbacks with exact alternatives (probe output shape, top-3→top-1 size cap, degraded-boot note).
