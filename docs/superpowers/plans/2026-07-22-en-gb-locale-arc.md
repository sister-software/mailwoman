# en-GB Locale Arc Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship en-GB parsing (with the `dependent_locality` dead-tag resurrection) end to end: PPD-derived corpus shard → 2k probe → resolver artifacts → `@mailwoman/neural-weights-en-gb` overlay package.

**Architecture:** PPD (31.3M rows, on disk) is preprocessed into an OA-shaped tuples CSV consumed by the existing `locale` shard recipe via `districtAsLocality` (the NZ mechanism: DISTRICT→locality, CITY→dependent_locality). The training probe clones the v3.8.5 recipe and adds two NEW mechanisms: `reinit_label_rows` (neutral re-init of classifier rows 7/8 after `init_from`) and `classifier_learning_rate` (a `classifier.`-prefix param group, #727 precedent). Resolver/packaging reuse existing GB scaffolding (`gazetteer postcode-binary` already has GB wired; `uk_postcode` already recognized).

**Tech Stack:** TypeScript (node type-stripping, vitest), Python (torch/Modal), Kysely-free (no DB work in this arc), Pastel CLI.

**Spec:** `docs/superpowers/specs/2026-07-22-en-gb-locale-arc-design.md` (approved 2026-07-22).

## Global Constraints

- Branch: `feat/en-gb-locale-arc`. Commit per task. PRs cut from `origin/main`.
- TS source runs under plain `node`; relative imports use explicit `.ts`; `erasableSyntaxOnly` (no enum/namespace/param-properties).
- Lint/format: oxlint + oxfmt (pre-commit checks formatting — run `npx oxfmt <file>` before committing).
- Compiled CLI for runs: `yarn compile` then `node mailwoman/out/cli.js ...`. Never `npx tsx`.
- Zero raw `process.env`/`process.argv` in shipped code — use `@mailwoman/core/env` + `core/utils/scripting`; data paths via `dataRootPath()` (never hardcode `/mnt/playpen/mailwoman-data`).
- Acronym casing: whole camelCase components (`extractPPD`, not `extractPpd`).
- NEVER wrap `modal run -d` in shell `timeout`. Launch detached, poll with `run_in_background` + until-loops.
- PPD snapshot (frozen): `$MAILWOMAN_DATA_ROOT/ppd/2026-07-22/pp-complete.csv` (31,346,259 rows, md5 recorded). Column order: `0 id, 1 price, 2 date, 3 postcode, 4 type, 5 newbuild, 6 tenure, 7 PAON, 8 SAON, 9 street, 10 locality, 11 town, 12 district, 13 county, 14 category, 15 status`. All fields ALL-CAPS. Modern rows fill `locality` only when ≠ town; 1995-era rows pad `locality`=town (~64% of filled) — drop when equal.
- Label indices (STAGE3, num_labels=33): `B-dependent_locality`=7, `I-dependent_locality`=8. Classifier: `model.classifier` = `nn.Linear(384, 33)`.
- Promotion/ship of any model is the operator's act. Probe grading is reported against the pre-registration in the spec, never silently reinterpreted.

---

### Task 1: GB title-case utility

**Files:**

- Create: `corpus/src/tools/gb-title-case.ts`
- Test: `corpus/src/tools/gb-title-case.test.ts`

**Interfaces:**

- Produces: `titleCaseGB(value: string): string` — used by Task 2's PPD extractor.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { titleCaseGB } from "./gb-title-case.ts"

describe("titleCaseGB", () => {
	it("title-cases plain ALL-CAPS words", () => {
		expect(titleCaseGB("BEULAH HILL")).toBe("Beulah Hill")
		expect(titleCaseGB("GREATER LONDON")).toBe("Greater London")
	})
	it("lowercases linking particles except at start", () => {
		expect(titleCaseGB("BARROW UPON SOAR")).toBe("Barrow upon Soar")
		expect(titleCaseGB("WELLS NEXT THE SEA")).toBe("Wells next the Sea")
		expect(titleCaseGB("THE GREEN")).toBe("The Green")
	})
	it("handles hyphenated names with particles", () => {
		expect(titleCaseGB("STRATFORD-UPON-AVON")).toBe("Stratford-upon-Avon")
		expect(titleCaseGB("WESTON-SUPER-MARE")).toBe("Weston-super-Mare")
	})
	it("keeps letters after apostrophes lowercase", () => {
		expect(titleCaseGB("BISHOP'S STORTFORD")).toBe("Bishop's Stortford")
		expect(titleCaseGB("ST JOHN'S WOOD")).toBe("St John's Wood")
	})
	it("passes through empty and already-mixed strings by re-casing", () => {
		expect(titleCaseGB("")).toBe("")
		expect(titleCaseGB("London")).toBe("London")
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run corpus/src/tools/gb-title-case.test.ts`
Expected: FAIL — `Cannot find module './gb-title-case.ts'`

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * Title-case an ALL-CAPS GB place/street string (#690 — all-caps is OOD for the model).
 * PPD ships every field upper-case; the model trains on natural casing.
 * Particles (upon, super, next, …) stay lowercase mid-name, both between words and
 * between hyphen segments. Letters directly after an apostrophe stay lowercase
 * (BISHOP'S → Bishop's).
 */
const GB_PARTICLES = new Set([
	"upon",
	"on",
	"under",
	"in",
	"by",
	"the",
	"le",
	"la",
	"de",
	"cum",
	"next",
	"with",
	"over",
	"at",
	"super",
	"sub",
	"and",
	"of",
	"y",
	"en",
])

function caseWord(word: string, isFirst: boolean): string {
	if (!word) return word
	const lower = word.toLowerCase()
	if (!isFirst && GB_PARTICLES.has(lower)) return lower
	// Capitalize the first letter only; keep everything after apostrophes lowercase.
	return lower[0]!.toUpperCase() + lower.slice(1)
}

export function titleCaseGB(value: string): string {
	let wordIndex = 0
	return value
		.split(/\s+/)
		.map((token) => {
			const cased = token
				.split("-")
				.map((seg, segIndex) => caseWord(seg, wordIndex === 0 && segIndex === 0))
				.join("-")
			wordIndex += 1
			return cased
		})
		.join(" ")
		.trim()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run corpus/src/tools/gb-title-case.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Format + commit**

```bash
npx oxfmt corpus/src/tools/gb-title-case.ts corpus/src/tools/gb-title-case.test.ts
git add corpus/src/tools/gb-title-case.ts corpus/src/tools/gb-title-case.test.ts
git commit -m "feat(corpus): GB title-case util — PPD all-caps → natural casing (#690)"
```

---

### Task 2: PPD → OA-shaped tuples extractor

**Files:**

- Create: `corpus/src/tools/fetch/ppd.ts`
- Test: `corpus/src/tools/fetch/ppd.test.ts`

**Interfaces:**

- Consumes: `titleCaseGB(value: string): string` from Task 1.
- Produces: `extractPPDTuples(input: AsyncIterable<string[]> | string[][], write: (line: string) => void): PPDExtractStats` and the CLI entry writing `$MAILWOMAN_DATA_ROOT/ppd/2026-07-22/gb-tuples.csv` with header `NUMBER,STREET,CITY,DISTRICT,REGION,POSTCODE` (the exact header `readTuples` indexes by name). Column semantics under `districtAsLocality: true`: `CITY` = PPD locality (→ `dependent_locality`), `DISTRICT` = PPD town (→ `locality`), `REGION` = PPD county.

**Row rules (all deliberate, from the 2026-07-22 profile):**

- Skip rows with non-empty SAON (flats/units — `LocaleBaseTuple` has no `unit`; wave-2).
- Skip rows whose PAON is not house-number-shaped (`/^\d+[A-Za-z]?(\s*-\s*\d+[A-Za-z]?)?$/` — building-name PAONs are out of scope v1). Normalize ranges to `4-6`.
- Skip rows missing street or postcode.
- Emit `CITY` empty when PPD locality equals town (the 1995-era padding) or is empty.
- Title-case STREET/CITY/DISTRICT/REGION via `titleCaseGB`; postcode passes through verbatim.
- Count every skip reason in `PPDExtractStats` — no silent drops.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { extractPPDTuples, type PPDExtractStats } from "./ppd.ts"

// PPD columns: id,price,date,postcode,type,new,tenure,PAON,SAON,street,locality,town,district,county,cat,status
const row = (
	over: Partial<Record<"postcode" | "paon" | "saon" | "street" | "locality" | "town" | "county", string>>
): string[] => {
	const base = {
		postcode: "SE19 3NF",
		paon: "14",
		saon: "",
		street: "BEULAH HILL",
		locality: "",
		town: "LONDON",
		county: "GREATER LONDON",
	}
	const r = { ...base, ...over }
	return [
		"{id}",
		"36995",
		"1995-03-24 00:00",
		r.postcode,
		"F",
		"N",
		"L",
		r.paon,
		r.saon,
		r.street,
		r.locality,
		"CROYDON",
		r.town,
		r.county,
		"A",
		"A",
	].map((v, i) => (i === 11 ? r.town : v)) // town sits at index 11; PPD district (index 12) is dropped by the extractor
}

async function run(rows: string[][]): Promise<{ lines: string[]; stats: PPDExtractStats }> {
	const lines: string[] = []
	const stats = await extractPPDTuples(rows, (line) => lines.push(line))
	return { lines, stats }
}

describe("extractPPDTuples", () => {
	it("emits an OA-shaped line with town→DISTRICT and county→REGION, title-cased", async () => {
		const { lines } = await run([row({})])
		expect(lines[0]).toBe("NUMBER,STREET,CITY,DISTRICT,REGION,POSTCODE")
		expect(lines[1]).toBe('14,"Beulah Hill",,"London","Greater London",SE19 3NF')
	})
	it("fills CITY only when locality differs from town", async () => {
		const { lines } = await run([
			row({ locality: "PLAISTOW", town: "BROMLEY" }),
			row({ locality: "LONDON", town: "LONDON" }),
		])
		expect(lines[1]).toBe('14,"Beulah Hill","Plaistow","Bromley","Greater London",SE19 3NF')
		expect(lines[2]).toBe('14,"Beulah Hill",,"London","Greater London",SE19 3NF')
	})
	it("skips SAON rows, name-PAON rows, and missing street/postcode, counting each", async () => {
		const { lines, stats } = await run([
			row({ saon: "FLAT 2" }),
			row({ paon: "CROWN POINT" }),
			row({ street: "" }),
			row({ postcode: "" }),
			row({}),
		])
		expect(lines).toHaveLength(2) // header + 1 kept
		expect(stats).toMatchObject({ kept: 1, skippedSAON: 1, skippedPAON: 1, skippedNoStreet: 1, skippedNoPostcode: 1 })
	})
	it("normalizes PAON ranges", async () => {
		const { lines } = await run([row({ paon: "4 - 6" })])
		expect(lines[1]!.startsWith("4-6,")).toBe(true)
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run corpus/src/tools/fetch/ppd.test.ts`
Expected: FAIL — `Cannot find module './ppd.ts'`

- [ ] **Step 3: Write the implementation**

```ts
/**
 * HM Land Registry Price Paid Data → OA-shaped GB tuples CSV for the `locale` shard recipe.
 *
 * PPD is E&W-only, ALL-CAPS, and column-structured (no header row). We emit the exact
 * OA header `readTuples` (shard-recipes/locale.ts) indexes by name, mapped for
 * `districtAsLocality: true`: CITY = PPD locality (dependent locality; blank when it
 * merely repeats the town — 1995-era rows pad locality=town), DISTRICT = PPD post town,
 * REGION = county. SAON (flat/unit) rows and building-name PAONs are skipped in v1 and
 * counted — LocaleBaseTuple has no unit field yet.
 *
 * Snapshot provenance: $MAILWOMAN_DATA_ROOT/ppd/<date>/pp-complete.csv (md5 sibling).
 * License: OGL v3 (attribution: HM Land Registry).
 */
import { createReadStream, createWriteStream } from "node:fs"
import { parseArgs } from "node:util"
import { CSVSpliterator } from "spliterator"
import { dataRootPath } from "@mailwoman/core/utils"
import { titleCaseGB } from "../gb-title-case.ts"

const HOUSE_NUMBER_PATTERN = /^\d+[A-Za-z]?(\s*-\s*\d+[A-Za-z]?)?$/

export interface PPDExtractStats {
	kept: number
	skippedSAON: number
	skippedPAON: number
	skippedNoStreet: number
	skippedNoPostcode: number
}

const quote = (value: string): string => (value ? `"${value.replaceAll('"', '""')}"` : "")

export async function extractPPDTuples(
	input: AsyncIterable<string[]> | Iterable<string[]>,
	write: (line: string) => void
): Promise<PPDExtractStats> {
	const stats: PPDExtractStats = { kept: 0, skippedSAON: 0, skippedPAON: 0, skippedNoStreet: 0, skippedNoPostcode: 0 }
	write("NUMBER,STREET,CITY,DISTRICT,REGION,POSTCODE")
	for await (const cells of input) {
		const [, , , postcode, , , , paon, saon, street, locality, town, , county] = cells
		if (saon) {
			stats.skippedSAON++
			continue
		}
		if (!paon || !HOUSE_NUMBER_PATTERN.test(paon)) {
			stats.skippedPAON++
			continue
		}
		if (!street) {
			stats.skippedNoStreet++
			continue
		}
		if (!postcode) {
			stats.skippedNoPostcode++
			continue
		}
		const number = paon.replace(/\s*-\s*/, "-")
		const city = locality && locality !== town ? titleCaseGB(locality) : ""
		write(
			[
				number,
				quote(titleCaseGB(street)),
				quote(city),
				quote(titleCaseGB(town ?? "")),
				quote(titleCaseGB(county ?? "")),
				postcode,
			].join(",")
		)
		stats.kept++
	}
	return stats
}

export async function runPPDExtract(inputPath: string, outputPath: string): Promise<PPDExtractStats> {
	const rows = CSVSpliterator.fromAsync<string[]>(createReadStream(inputPath), {
		mode: "array",
		header: false,
		enableQuoteHandling: true,
	})
	const out = createWriteStream(outputPath)
	const stats = await extractPPDTuples(rows, (line) => out.write(line + "\n"))
	await new Promise<void>((resolvePromise, reject) => out.end((err?: Error) => (err ? reject(err) : resolvePromise())))
	return stats
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			input: { type: "string", default: dataRootPath("ppd", "2026-07-22", "pp-complete.csv") },
			output: { type: "string", default: dataRootPath("ppd", "2026-07-22", "gb-tuples.csv") },
		},
	})
	const stats = await runPPDExtract(values.input, values.output)
	console.log(`[ppd] ${JSON.stringify(stats)}`)
}
```

Note for the implementer: check how `corpus/src/tools/fetch/ban.ts` guards its entrypoint and imports CSV streaming — mirror its exact idioms (`import.meta.main` availability, the CSVSpliterator import specifier) rather than inventing new ones. If `spliterator` exposes a different module path in this workspace, copy the import from `corpus/src/shard-recipes/locale.ts:188` (`readTuples` uses the same class).

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run corpus/src/tools/fetch/ppd.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the real extraction (background, ~31M rows)**

```bash
node corpus/src/tools/fetch/ppd.ts 2>&1 | tail -1
```

Expected: `[ppd] {"kept":<≈24-26M>,"skippedSAON":<≈3M>,"skippedPAON":<≈2-4M>,...}` — record the real numbers in the commit message. Sanity: `head -3` of gb-tuples.csv shows the header + title-cased rows; `wc -l` ≈ kept+1.

- [ ] **Step 6: Format + commit**

```bash
npx oxfmt corpus/src/tools/fetch/ppd.ts corpus/src/tools/fetch/ppd.test.ts
git add corpus/src/tools/fetch/ppd.ts corpus/src/tools/fetch/ppd.test.ts
git commit -m "feat(corpus): PPD extractor — 31.3M Price Paid rows → OA-shaped GB tuples (kept N, skipped saon/paon M/K)"
```

---

### Task 3: Register GB in the locale recipe + country-append fraction

**Files:**

- Modify: `corpus/src/shard-recipes/locale.ts` (the `COUNTRY_SOURCES` map, ~L94; the emit loop for the country fraction)
- Test: `corpus/src/shard-recipes/locale.test.ts`

**Interfaces:**

- Consumes: `gb-tuples.csv` from Task 2; existing `readTuples`/`districtAsLocality`.
- Produces: `COUNTRY_SOURCES.GB` (source name `synth-gb`, corpusVersion bump per file convention); rows built with `--country GB` occasionally (20%) carry `", United Kingdom"` (or another GB surface form) + a `country` component.

- [ ] **Step 1: Write the failing tests**

Add to `corpus/src/shard-recipes/locale.test.ts` (follow the NZ `districtAsLocality` test at L95-121 as the template):

```ts
it("GB tuples: CITY→dependent_locality, DISTRICT→locality via districtAsLocality", async () => {
	const file = await writeFixture(
		"gb.csv",
		[
			"NUMBER,STREET,CITY,DISTRICT,REGION,POSTCODE",
			'14,"Beulah Hill",,"London","Greater London",SE19 3NF',
			'2,"High Street","Plaistow","Bromley","Greater London",BR1 4AA',
		].join("\n")
	)
	const tuples = await readTuples({ path: file, districtAsLocality: true }, () => 0)
	expect(tuples).toEqual([
		{ house_number: "14", street: "Beulah Hill", locality: "London", region: "Greater London", postcode: "SE19 3NF" },
		{
			house_number: "2",
			street: "High Street",
			locality: "Bromley",
			region: "Greater London",
			postcode: "BR1 4AA",
			dependent_locality: "Plaistow",
		},
	])
})
```

(Use the test file's existing fixture-writing helper — do not invent `writeFixture` if the file names it differently; copy the local idiom.)

- [ ] **Step 2: Run to verify the new test passes already or fails only on fixture plumbing**

Run: `yarn vitest run corpus/src/shard-recipes/locale.test.ts`
Expected: the GB test should PASS with no production change (`readTuples` is source-agnostic) — it locks the mapping. If it fails, fix the test fixture, not `readTuples`.

- [ ] **Step 3: Add the `COUNTRY_SOURCES.GB` entry**

In `corpus/src/shard-recipes/locale.ts`, after the NZ entry:

```ts
	GB: {
		source: "synth-gb",
		corpusVersion: "0.9.9",
		parts: [{ path: dataRootPath("ppd", "2026-07-22", "gb-tuples.csv"), districtAsLocality: true }],
	},
```

(Match `corpusVersion` to whatever the sibling entries currently carry — bump only if the file's convention says new sources start a new version.)

- [ ] **Step 4: Add the country-append fraction**

First VERIFY current behavior: read `synthesizeLocaleRow` in `corpus/src/synthesize-german.ts` and check whether `intlFraction` rows already append a country surface form. If they do, this step is config only (set the fraction when building the GB shard) — record the finding and skip the code change. If not, add the fr-admin-split pattern (fr-admin-split.ts L122-128) to the locale recipe's emit loop, gated on a new `LocalePart`-level or recipe-level option so existing locales are byte-identical:

```ts
// In the run loop, after `const synth = synthesizeLocaleRow(...)`:
if (countryFraction > 0 && random() < countryFraction) {
	const forms = COUNTRY_SURFACE_FORMS[country as keyof typeof COUNTRY_SURFACE_FORMS]
	if (forms?.length) {
		const form = forms[Math.floor(random() * forms.length)]!
		synth.raw = `${synth.raw}, ${form}`
		synth.components = { ...synth.components, country: form }
	}
}
```

with `countryFraction` sourced from a new `--country-fraction` recipe option (zod flag in `mailwoman/commands/corpus/shard/index.tsx`, threaded through `ShardRecipeOpts` like `intlFraction`), default `0`. Import `COUNTRY_SURFACE_FORMS` from `@mailwoman/codex` (it already has GB: `["United Kingdom", "UK", "Great Britain", "Britain", "England", "GB", "U.K."]`).

Add a test: with `countryFraction: 1` every emitted row ends with a GB surface form and carries `components.country`; with the option absent, output is byte-identical to before (snapshot two rows with a fixed seed).

- [ ] **Step 5: Run the full corpus test suite**

Run: `yarn vitest run corpus/`
Expected: PASS, zero regressions.

- [ ] **Step 6: Format + commit**

```bash
npx oxfmt corpus/src/shard-recipes/locale.ts corpus/src/shard-recipes/locale.test.ts mailwoman/commands/corpus/shard/index.tsx
git add -A corpus/src/shard-recipes mailwoman/commands/corpus/shard
git commit -m "feat(corpus): GB locale source (PPD tuples) + country-append fraction on the locale recipe"
```

---

### Task 4: Build the GB shard + golden boards

**Files:**

- Create: `mailwoman/eval-harness/fixtures/gb-golden.jsonl` (~120 rows)
- Create: `mailwoman/eval-harness/fixtures/nz-suburb-golden.jsonl` (promoted from `scratchpad/nz-golden-v383/nz.jsonl`, 300 rows / 246 suburb rows — the resurrection read board must be a committed artifact, not scratchpad)
- Output (data, not committed): GB shard JSONL under the corpus build area

**Interfaces:**

- Consumes: Task 3's recipe registration; the compiled CLI.
- Produces: the shard file for Task 7's overlay; both boards in the NZ-board row shape: `{"raw": "...", "components": {...}, "country": "GB", "source": "golden"}`.

- [ ] **Step 1: Compile and build the shard**

```bash
yarn compile
node mailwoman/out/cli.js corpus shard locale --country GB --count 800000 --seed 42 \
  --country-fraction 0.2 --intl-fraction 0.1 \
  --output "$MAILWOMAN_DATA_ROOT/corpus/shards/synth-gb-v1.jsonl"
```

Expected: shard stats printed; row count 800000. (Match `--count`/flags to what the CA/MX shard build used if the recipe's own docs give a different convention — check the config header in `corpus-python/.../v3.8.4-latam-probe.yaml` for the latam shard's provenance line.)

- [ ] **Step 2: Formatter + shape verification (acceptance criterion 1)**

Spot-check 20 random rows: every row parses as JSON, `raw` reads as a plausible GB address in `number street, [dependent locality,] Town, [County,] POSTCODE` order with natural casing, ~20% end in a GB country form, rows with `dependent_locality` in components show it in `raw`. Verify BIO `labels` cover `B-dependent_locality` on those rows:

```bash
shuf -n 20 "$MAILWOMAN_DATA_ROOT/corpus/shards/synth-gb-v1.jsonl" | python3 -c "import json,sys; [print(json.loads(l)['raw']) for l in sys.stdin]"
grep -c 'B-dependent_locality' "$MAILWOMAN_DATA_ROOT/corpus/shards/synth-gb-v1.jsonl"
```

Expected: dependent_locality present on a substantial fraction (PPD profile says ~35-38% of source rows carry a distinct locality). If `raw` shows ALL-CAPS or `locality==dependent_locality` duplicates, stop and fix Task 2/3 — do not train on a malformed shard.

- [ ] **Step 3: Build the GB golden board**

Generate 120 rows from the PPD tail (held-out modern rows, NOT rows used in the shard — use `tail -1000000` sampling with a different seed), stratified: 60 with dependent_locality, 40 without, 20 with a country suffix. Same row shape as the NZ board. Hand-eyeball all 120 before committing (the operator reviews this file in the task's PR).

- [ ] **Step 4: Promote the NZ board**

```bash
cp scratchpad/nz-golden-v383/nz.jsonl mailwoman/eval-harness/fixtures/nz-suburb-golden.jsonl
```

Verify: 300 lines, 246 with `dependent_locality`.

- [ ] **Step 5: Commit**

```bash
git add mailwoman/eval-harness/fixtures/gb-golden.jsonl mailwoman/eval-harness/fixtures/nz-suburb-golden.jsonl
git commit -m "feat(eval): GB golden board (120 rows) + promote NZ suburb board (246-row dependent_locality read)"
```

---

### Task 5: Pipeline diagnostic — does "dependent locality, town" survive decode?

**Files:**

- Test: `core/decoder/build-tree.test.ts` (add cases; file exists — find the sibling test for `emitSpans`)

**Why:** the spec assumed the word-consistency heal lumps "suburb, city" into one locality span. Exploration found both merge mechanisms (`span-bridge.ts` `bridgeable`, `build-tree.ts` `emitSpans`) explicitly refuse to merge across commas. Diagnose before fixing (superpowers:systematic-debugging): prove the pipeline preserves the distinction, or find the real lumper.

- [ ] **Step 1: Write the characterization test**

Add an `emitSpans`-level case: token sequence for `"Plimmerton, Porirua"` labeled `B-dependent_locality` + `B-locality` (comma between) must yield TWO spans with distinct tags; and the same-tag case `B-locality "Springfield" , B-locality "Chicago"` must stay two spans (documents the comma guard).

- [ ] **Step 2: Run**

Run: `yarn vitest run core/decoder/build-tree.test.ts neural/span-bridge.test.ts`
Expected: PASS with no production change. If it PASSES: the "heal lumps" claim is falsified at pipeline level — the lumping seen in the NZ probes was the MODEL emitting one span (which the resurrection addresses). Update the spec's Phase 3 heal bullet with this finding and delete the heal-fix acceptance criterion. If it FAILS: keep the test, fix the merge guard it exposes, and record which mechanism it was.

- [ ] **Step 3: Commit (either outcome)**

```bash
git add -A core/decoder neural docs/superpowers/specs/2026-07-22-en-gb-locale-arc-design.md
git commit -m "test(decoder): characterize dependent_locality/locality comma separation (spec Phase-3 diagnostic)"
```

---

### Task 6: Training mechanisms — `reinit_label_rows` + `classifier_learning_rate`

**Files:**

- Modify: `corpus-python/src/mailwoman_train/train.py` (`build_optimizer` L133-180; the `init_from` block L416-427)
- Modify: the `TrainConfig` dataclass (find it where `span_head_learning_rate` is declared — same file or `config.py`; add both fields with `None`/empty defaults so every existing config parses unchanged)
- Test: `corpus-python/tests/test_resurrection.py` (create; if the tests dir has another name, follow the existing pytest layout — check `corpus-python/pyproject.toml` for testpaths)

**Design constraint (do not "simplify" this):** Adam's update is scale-invariant in the gradient (m̂/√v̂), so a gradient hook that scales rows 7/8 CANNOT create an effective per-row LR. The row carve-out must be a real param group. Since AdamW groups operate on whole tensors and `classifier` is one `nn.Linear(384, 33)`, the group is the WHOLE classifier (prefix `classifier.`), exactly parallel to the shipped `span_head_learning_rate` prefix mechanism. The row-level precision comes from `reinit_label_rows` (only rows 7/8 are reset); the live rows ride the hot LR for 2k steps and the pre-registered guards (golden us/fr, boards, presets) catch any drift.

- [ ] **Step 1: Write failing tests**

```python
import torch
from mailwoman_train.labels import LABEL_TO_ID
from mailwoman_train.train import build_optimizer, reinit_label_rows


class TinyModel(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.encoder = torch.nn.Linear(4, 4)
        self.classifier = torch.nn.Linear(4, 33)


def test_classifier_learning_rate_makes_two_groups():
    m = TinyModel()
    optim = build_optimizer(m, learning_rate=1e-5, weight_decay=0.01, classifier_learning_rate=1e-3)
    lrs = sorted(g["lr"] for g in optim.param_groups)
    assert lrs == [1e-5, 1e-3]
    hot = next(g for g in optim.param_groups if g["lr"] == 1e-3)
    assert sum(p.numel() for p in hot["params"]) == 33 * 4 + 33  # classifier.weight + bias only


def test_no_override_is_single_group():
    m = TinyModel()
    optim = build_optimizer(m, learning_rate=1e-5, weight_decay=0.01)
    assert len(optim.param_groups) == 1


def test_reinit_label_rows_resets_only_named_rows():
    m = TinyModel()
    with torch.no_grad():
        m.classifier.weight.fill_(0.0)
        m.classifier.bias.fill_(0.0)
        m.classifier.weight[7].fill_(-9.0)  # B-dependent_locality, the baked-dead row
        m.classifier.bias[7] = -9.0
    before = m.classifier.weight.clone()
    reinit_label_rows(m, ["B-dependent_locality", "I-dependent_locality"])
    idx_b = LABEL_TO_ID["B-dependent_locality"]
    assert idx_b == 7
    # Reset rows equal the live-row mean (0.0 here), untouched rows unchanged.
    assert torch.allclose(m.classifier.weight[7], torch.zeros(4))
    assert float(m.classifier.bias[7]) == 0.0
    live = [i for i in range(33) if i not in (7, 8)]
    assert torch.equal(m.classifier.weight[live], before[live])
```

- [ ] **Step 2: Run to verify failure**

Run: `cd corpus-python && uv run pytest tests/test_resurrection.py -v`
Expected: FAIL — `ImportError: cannot import name 'reinit_label_rows'`

- [ ] **Step 3: Implement**

In `train.py`, extend `build_optimizer` with a second carve-out, preserving byte-identical single-group behavior when no override is set:

```python
def build_optimizer(
    model,
    *,
    learning_rate: float,
    weight_decay: float,
    span_head_learning_rate: float | None = None,
    classifier_learning_rate: float | None = None,
) -> AdamW:
    """... (keep the existing docstring; append:)

    `classifier_learning_rate` carves the output head (`classifier.`) into its own group —
    the dead-tag resurrection lever (#456/#1100): a re-initialized output row (see
    `reinit_label_rows`) cannot climb out of a baked-negative neighborhood at the encoder's
    fine-tune LR, and Adam's gradient scale-invariance rules out hook-based row scaling.
    """
    trainable = [(n, p) for n, p in model.named_parameters() if p.requires_grad]
    carveouts: list[tuple[tuple[str, ...], float, str]] = []
    if span_head_learning_rate is not None:
        carveouts.append((("span_scorer.", "semi_crf."), span_head_learning_rate, "span_head_learning_rate"))
    if classifier_learning_rate is not None:
        carveouts.append((("classifier.",), classifier_learning_rate, "classifier_learning_rate"))
    if not carveouts:
        return AdamW([p for _, p in trainable], lr=learning_rate, weight_decay=weight_decay)
    groups = []
    rest = trainable
    for prefixes, lr, key in carveouts:
        head = [p for n, p in rest if n.startswith(prefixes)]
        rest = [(n, p) for n, p in rest if not n.startswith(prefixes)]
        if not head:
            raise RuntimeError(f"train.{key} is set but no params match {prefixes}")
        print(f"[{key}] {sum(p.numel() for p in head):,} params @ {lr}")
        groups.append({"params": head, "lr": lr})
    groups.insert(0, {"params": [p for _, p in rest], "lr": learning_rate})
    return AdamW(groups, lr=learning_rate, weight_decay=weight_decay)


def reinit_label_rows(model, labels: list[str]) -> None:
    """Reset the named BIO labels' classifier rows (weight + bias) to the mean of the LIVE rows.

    The dead-tag mechanism: init_from a checkpoint where a tag never fires leaves its output
    row deeply negative; class weights only scale a vanishing gradient (v382/v383 no-ops).
    Mean-of-live re-init (the FVT mean-init precedent) puts the row back on the decision
    surface so the resurrection LR can steer it.
    """
    from .labels import LABEL_TO_ID

    rows = [LABEL_TO_ID[label] for label in labels]
    with torch.no_grad():
        live = [i for i in range(model.classifier.out_features) if i not in rows]
        mean_w = model.classifier.weight[live].mean(dim=0)
        mean_b = model.classifier.bias[live].mean()
        for i in rows:
            model.classifier.weight[i] = mean_w
            model.classifier.bias[i] = mean_b
    print(f"[reinit_label_rows] rows {rows} ← live-row mean ({labels})")
```

Wire-in at the `init_from` block (train.py ~L427, immediately after the `load_state_dict` print):

```python
        reinit = list(getattr(cfg.train, "reinit_label_rows", []) or [])
        if reinit:
            if not init_from:
                raise ValueError("train.reinit_label_rows requires train.init_from")
            reinit_label_rows(model, reinit)
```

And at the `build_optimizer` call site (~L464-469) add `classifier_learning_rate=getattr(cfg.train, "classifier_learning_rate", None),`. Add both fields to the TrainConfig dataclass (`classifier_learning_rate: float | None = None`, `reinit_label_rows: list[str] = field(default_factory=list)`).

- [ ] **Step 4: Run tests**

Run: `cd corpus-python && uv run pytest tests/test_resurrection.py -v`
Expected: 3 PASS. Then the full suite: `uv run pytest` — zero regressions.

- [ ] **Step 5: Commit**

```bash
git add corpus-python/src/mailwoman_train/train.py corpus-python/tests/test_resurrection.py <config-file-if-separate>
git commit -m "feat(train): dead-tag resurrection levers — reinit_label_rows + classifier_learning_rate param group"
```

---

### Task 7: Probe config + corpus overlay + volume sync

**Files:**

- Create: `corpus-python/src/mailwoman_train/configs/v3.10.0-gb-probe.yaml`
- Data: corpus overlay `v0.14.0-gb` on the Modal volume

- [ ] **Step 1: Verify the v385 checkpoint path on the volume**

```bash
modal volume ls mailwoman-data /data/ 2>/dev/null || modal volume ls <volume-name>
```

Find the exact dir holding the shipped v385 step-008000 checkpoint (the v3.8.5 config's `output_dir` string was a reused `output-v384-latam-probe-s42` — do NOT trust the config header; list the volume). Record the real path; it becomes `init_from`.

- [ ] **Step 2: Write the config**

Clone `v3.8.5-latam-8k.yaml` verbatim, then apply EXACTLY these deltas (header comment documents each, per config-header discipline):

- `data.corpus_dir:` → the v0.14.0-gb overlay path (Step 3)
- `data.source_weights:` add `synth-gb: 6.0`
- `model.class_weights:` `B-dependent_locality: 0.3` → `1.0`, `I-dependent_locality: 0.3` → `1.0` (the third suppressor: re-init + hot LR are useless under a 0.3 downweight)
- `train.output_dir: /data/output-v3100-gb-probe-s42/checkpoints`
- `train.init_from:` the verified v385 step-008000 path
- `train.max_steps: 2000`
- `train.classifier_learning_rate: 1.0e-3`
- `train.reinit_label_rows: ["B-dependent_locality", "I-dependent_locality"]`
- `train.trackio_run_name: v3.10.0-gb-probe-s42`

Header must carry the pre-registered reads verbatim from the spec (PRIMARY: dependent_locality emission on the 246-row NZ board + GB board; GUARDS: golden us/fr noise, digit + FR fragment boards, 6 demo presets byte-identical; FALLBACK: locality-mapped ship, no knob-spinning) and `Launch: modal run -d corpus-python/modal/train_remote.py --config v3.10.0-gb-probe.yaml --resume none`.

- [ ] **Step 3: Build + sync the corpus overlay**

Follow `corpus-python/modal/CLAUDE.md` (the runbook is the authority): overlay `synth-gb-v1.jsonl` onto the v0.13.0-latam corpus as `v0.14.0-gb` exactly the way v0.13.0 overlaid latam onto v0.11.0 (the runbook documents the overlay + `sync_v0XX` procedure, R2 push, manifest check for stray `/mnt` paths, stale `__pycache__` clear).

- [ ] **Step 4: Startup-census dry-run check (the NZ allowlist lesson)**

After launch (Task 8) the FIRST verification is the startup census: GB rows DRAWN > 0 from `synth-gb`. If the census log truncates (the v383 gap), grade the source multinomial locally with the data_loader against the overlay manifest before letting the run continue.

- [ ] **Step 5: Commit**

```bash
git add corpus-python/src/mailwoman_train/configs/v3.10.0-gb-probe.yaml
git commit -m "feat(train): v3.10.0-gb-probe config — GB shard + dependent_locality resurrection (re-init + classifier LR + class-weight 1.0)"
```

---

### Task 8: Launch + grade the probe (operational)

- [ ] **Step 1: Launch detached** — `modal run -d corpus-python/modal/train_remote.py --config v3.10.0-gb-probe.yaml --resume none` (never wrapped in `timeout`). Verify census per Task 7 Step 4.
- [ ] **Step 2: On completion** — export + quantize per the runbook two-step (`export_onnx` then `quantize_onnx` → `model-v3100-gb-probe-int8.onnx`), package-shaped.
- [ ] **Step 3: Grade against the pre-registration** — NZ 246-row board, GB 120-row board, golden us/fr, digit + FR fragment boards, 6 demo presets byte-identical (use the eval-harness; never compare across harnesses — the #727 lesson).
- [ ] **Step 4: Report** — reads vs pre-registration, verbatim, to the operator. PASS → operator decides 8k. FAIL on primary → invoke the pre-registered fallback (locality-mapped), no knob iteration.

---

### Task 9: Resolver + packaging (independent of probe outcome)

**Files:**

- Create: `neural-weights-en-gb/package.json`, `neural-weights-en-gb/README.md`, `neural-weights-en-gb/.npmignore`, `neural-weights-en-gb/scripts/link-dev-weights.ts`
- Modify: `release.config.json` (locales + softFeed), `.github/workflows/publish.yml` (HF artifact list + cp fallback), root `package.json`/workspace registration if the workspaces glob requires it

- [ ] **Step 1: Build + verify `postcode-gb.bin`**

```bash
yarn compile
node mailwoman/out/cli.js gazetteer postcode-binary --out /tmp/claude-1000/-home-lab-Projects-mailwoman/fdc2d5da-e8ed-459b-bf6c-2749f4b7021b/scratchpad/gb-bin --locale "GB:$MAILWOMAN_DATA_ROOT/wof/postalcode-gb.db"
```

Expected: `postcode-gb.bin` written (outward-aggregated, ~3k records). Verify with a node one-liner: `new PostcodeBinaryResolver(...)` from `@mailwoman/neural` resolves `SW1A` and the outward of a full code (`SW1A 1AA` → outward fallback) to plausible London coords.

- [ ] **Step 2: Create the workspace (clone fr-fr byte-for-byte, then edit)**

`neural-weights-en-gb/package.json` — copy `neural-weights-fr-fr/package.json` and change: name `@mailwoman/neural-weights-en-gb`, description (en-gb wording), `files` entry `postcode-fr.bin` → `postcode-gb.bin`, repository.directory. KEEP: `"dependencies": { "@mailwoman/neural-weights-en-us": "workspace:*" }`, `"mailwoman": { "baseWeights": "@mailwoman/neural-weights-en-us" }`, the license string, the `!*.test.ts` excludes. Copy `.npmignore` and the `link-dev-weights.ts` script from fr-fr, adjusting the linked file set — and include the anchor-lexicon + postcode-bin siblings (the link-dev-weights gap memory: fresh worktrees parse anchor-OFF when those aren't linked).

- [ ] **Step 3: Wire the release path (the postcode-de outage lesson — day one, not ship time)**

- `release.config.json`: `"locales": ["en-us", "fr-fr", "en-gb"]`; `softFeed.postcodeDBByCountry` add `"gb": "postalcode-gb.db"`.
- `.github/workflows/publish.yml`: add `postcode-gb.bin` to the HF fetch + the hardcoded artifact guard list (L124, 155-161); extend the cp fallback block so en-gb receives the shared lexicons (mirror the fr-fr lines).
- Run `node scripts/copy-weights.ts` locally and verify it materializes en-gb without error.

- [ ] **Step 4: Resolution smoke check**

`resolveWeights({ locale: "en-gb" })` from `@mailwoman/neural` must resolve: model/tokenizer from the en-us base (`source` suffixed `+base`), `postcode-gb.bin` locally. Add/extend the weights test alongside `neural/test/weights.test.ts`'s fr-fr case.

- [ ] **Step 5: Standalone-install probe** (core-standalone memory): `yarn pack` the new workspace, install outside the repo next to the base package, `resolveWeights` — catches undeclared hoisted deps and symlink leaks.

- [ ] **Step 6: Format + commit**

```bash
git add -A neural-weights-en-gb release.config.json .github/workflows/publish.yml scripts/copy-weights.ts neural/test
git commit -m "feat(weights): @mailwoman/neural-weights-en-gb overlay — postcode-gb.bin + full release-path wiring"
```

---

### Task 10: Post-probe (operator-gated — NOT executed with this plan)

8k run on probe PASS → full gate battery + gauntlet → `mailwoman release hf` staging → CI publish (per the mailwoman-release skill) → GB demo presets in `docs/src/shared/demo-helpers.ts` (2 entries, one with dependent locality) → demo redeploy → eval ledger-append → talk numbers. Each is its own session-level decision; listed here only so the arc's tail is visible.

---

## Self-review notes

- Spec coverage: Phase 0 done pre-plan (PPD+Code-Point on disk); Phase 1 = Tasks 1-4; Phase 2 = Tasks 6-8; Phase 3 = Tasks 5+9 (heal fix became a diagnostic per exploration — spec updated in Task 5); Phase 4 = Task 9; Phase 5 = Task 10 (gated). EPC/ONSPD are wave-2 by spec and appear in no task.
- Type consistency: `titleCaseGB` (1→2), `extractPPDTuples`/`PPDExtractStats` (2), `synth-gb` source name (3→7), board filenames (4→8), `reinit_label_rows`/`classifier_learning_rate` (6→7) — names match across tasks.
- Known unknowns flagged inline rather than guessed: exact `TrainConfig` file, pytest layout, fixture-helper name in `locale.test.ts`, v385 volume path, overlay procedure (runbook-owned). Each has a verify-first step.
