# Migrate `node:readline` → `spliterator`

**Status:** EXECUTED 2026-07-08 — all sites migrated; see "Execution notes" at the end for the
deltas between this plan and what the v3.1.0 API audit + migration actually found.  
**Scope:** 25 files / 27 call sites  
**Goal:** Replace `node:readline` `createInterface` line-by-line streaming with
`spliterator`'s `TextSpliterator`, `JSONSpliterator`, or `CSVSpliterator` — the same
library already used in `core/resources/`, `registry/ingest.ts`, and
`mailwoman/gazetteer-pipeline/`.

## Motivation

`spliterator` is the monorepo's idiomatic streaming-I/O layer. It delivers the same
result as `node:readline` while adding:

- **Lower allocation pressure.** `readline` decodes every line into a V8 string before
  yielding it. `TextSpliterator` operates on byte ranges and decodes once at the
  consumer — large JSONL files spend less time in GC.
- **Deterministic file-handle lifecycle.** `readline`'s `close` event fires
  asynchronously after the stream ends; an early `break` out of a `for await` can
  leave the fd open until GC runs (Node 24+ warns). `AsyncSpliterator` has an
  explicit `[Symbol.asyncDispose]()` lifecycle, and `autoDispose: false` +
  caller-owned handles (the `registry/ingest.ts` pattern) give full control.
- **Subclass specialization.** `CSVSpliterator` / `JSONSpliterator` / `TSVSpliterator`
  each eliminate the per-line `JSON.parse` / `split` boilerplate that clutters
  `readline` loops.
- **Single dependency surface.** Every workspace in the caller set already depends on
  `spliterator` (it's a dependency of `@mailwoman/core`, `@mailwoman/corpus`,
  `mailwoman`, and `@mailwoman/registry`).

## Call-site inventory

| File | Pattern | Spliterator replacement |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----- |
| `corpus/scripts/build-kryptonite-shard.ts:87` | `createInterface({ input: createReadStream(jsonl, "utf8"), crlfDelay: Infinity })` | `TextSpliterator.fromAsync(jsonl)` |
| `corpus/scripts/build-transliteration-shard.ts:116` | same shape | `TextSpliterator.fromAsync(jsonl)` |
| `corpus/scripts/ingest-csv.ts:206,311` | CSV ingest — two passes | `CSVSpliterator.fromAsync(path, { mode: "array" })` ⚠️ |
| `corpus/src/build.ts:338` | `streamJsonl<T>` helper | `JSONSpliterator.fromAsync<T>(path)` |
| `corpus/src/split.ts:219` | shuffle-split of labeled JSONL | `JSONSpliterator.fromAsync(labeledJsonlPath)` (read phase only; write needs `createWriteStream`) |
| `corpus/src/adapters/gnaf/adapter.ts:81` | pipe-delimited G-NAF | `TSVSpliterator.fromAsync` with `delimiter: "                                                    | "` |
| `corpus/src/adapters/openaddresses/adapter.ts:142` | OA GeoJSONL | `JSONSpliterator.fromAsync(adapterOpts.inputPath)` |
| `corpus/src/adapters/overture/adapter.ts:81` | Overture JSONL | `JSONSpliterator.fromAsync(opts.inputPath)` |
| `corpus/src/adapters/synth-po-box/adapter.ts:94` | synthetic PO box JSONL | `JSONSpliterator.fromAsync(options.inputPath)` |
| `corpus/src/adapters/usgov-nad/adapter.ts:252` | NAD GeoJSON | `JSONSpliterator.fromAsync(join(opts.inputPath, shard))` |
| `corpus/src/shard-recipes/fr-admin-split.ts:66` | `readCommunes` CSV | `CSVSpliterator.fromAsync(path, { mode: "object" })` |
| `corpus/src/shard-recipes/locale.ts:220` | OA CSV reservoir sample | `CSVSpliterator.fromAsync(input, { mode: "array" })` |
| `corpus/src/shard-recipes/scaffold.ts:71` | tuple JSONL → `ShardTuple` | `JSONSpliterator.fromAsync<ShardTuple>(input)` |
| `mailwoman/commands/gazetteer/importance.tsx:131` | gzipped TSV via `createInterface({ input: fileStream.pipe(gunzip) })` | `TextSpliterator.fromAsync(fileStream.pipe(gunzip), { delimiter: Delimiters.Tab })` |
| `mailwoman/commands/gazetteer/postcode-intl.tsx:89` | GeoNames TSV | `TSVSpliterator.fromAsync(file)` |
| `mailwoman/corpus-tools/align-shard.ts:40` | canonicalize JSONL + rewrite | `JSONSpliterator.fromAsync(args.input)` (read phase) |
| `scripts/jsonl-to-parquet.ts:159` | validate JSONL → DuckDB | `JSONSpliterator.fromAsync(args.input)` |
| `scripts/eval/audit-po-box-cedex-shard.ts:156` | JSONL audit | `JSONSpliterator.fromAsync(opts.input)` |
| `scripts/eval/reverse-geocode-eval.ts:105` | JSONL eval rows | `JSONSpliterator.fromAsync(args.eval)` |
| `scripts/eval/gauntlet/holdout.ts:101` | JSONL reservoir sample | `JSONSpliterator.fromAsync(src.file)` |
| `scripts/eval/record-matcher/train-cross-gbt.ts:146` | CSV with manual quote handling | `CSVSpliterator.fromAsync(path, { mode: "object", enableQuoteHandling: true })` |
| `scripts/eval/record-matcher/train-org-cross-gbt.ts:129` | same pattern | same |
| `tiger/sdk/fetch.ts:310` | `ogr2ogr` stdout (GeoJSON per line) | `JSONSpliterator.fromAsync(child.stdout)` ⚠️ |
| `tiger/sdk/redistricting.ts:122,203` | pipe-delimited census files | `TSVSpliterator.fromAsync(path, { delimiter: "                                                   | " })` |
| `osm/sdk/extract.ts:127` | `osmconvert` stdout | `TextSpliterator.fromAsync(proc.stdout)` |
| `osm/sdk/street-recovery.ts:126` | `osmconvert` stdout | `TextSpliterator.fromAsync(proc.stdout)` |

> ⚠️ denotes a call site that warrants extra care (see "Risks" below).

**Intentionally kept:**

| File                          | Why                                                                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/bless-package.ts:40` | Interactive TTY prompt — `readline/promises` `question()` is the correct API. Spliterator is a streaming byte-range splitter, not an interactive I/O layer. |

## Migration recipe by pattern

### Pattern A: JSONL (`for await (const line of rl)` + `JSON.parse`)

**Before:**

```ts
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"

const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity })
for await (const line of rl) {
	const row = JSON.parse(line)
	// ...
}
```

**After:**

```ts
import { JSONSpliterator } from "spliterator"

for await (const row of JSONSpliterator.fromAsync<MyType>(path)) {
	// row is already parsed — no JSON.parse needed
}
```

**Affected files (11):** `build.ts`, `split.ts`, `openaddresses/adapter.ts`,
`overture/adapter.ts`, `synth-po-box/adapter.ts`, `usgov-nad/adapter.ts`,
`scaffold.ts`, `align-shard.ts`, `jsonl-to-parquet.ts`,
`audit-po-box-cedex-shard.ts`, `reverse-geocode-eval.ts`, `holdout.ts`

### Pattern B: CSV (`for await (const line …)` + `line.split(",")` or manual split)

**Before:**

```ts
const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
let header: string[] | null = null
for await (const line of rl) {
	const fields = line.split(",")
	if (!header) {
		header = fields
		continue
	}
	const row: Record<string, string> = {}
	for (let i = 0; i < header.length; i++) row[header[i]] = fields[i]
}
```

**After:**

```ts
import { CSVSpliterator } from "spliterator"

for await (const row of CSVSpliterator.fromAsync(path, { mode: "object" })) {
	// row is Record<string, string> with header keys
}
```

> **RESOLVED in v3.1.0:** the column tokenizer now unconditionally preserves empty fields
> (`skipEmpty: false` internally; probed: `"a,,c,"` keeps all 4 columns including trailing
> empties). The `registry/ingest.ts:54` workaround comment is stale on this point.
> **⚠️ NEW known issue found during execution:** `enableQuoteHandling: true` does NOT protect
> embedded delimiters inside quoted fields — the option is applied to row splitting only and
> never reaches the column tokenizer (probed: `"a,x",b` mis-parses into two rows). Any CSV with
> quoted fields must keep manual quote handling over `TextSpliterator`. Upstream fix needed.

**Affected files (3):** `fr-admin-split.ts` ⚠️, `locale.ts` ⚠️,
`train-cross-gbt.ts`, `train-org-cross-gbt.ts`

> ~~For `train-cross-gbt.ts` and `train-org-cross-gbt.ts`, the current code has manual
> quote-handling with `pending` buffers — `CSVSpliterator` with `enableQuoteHandling: true`
> replaces all of that.~~ **Superseded during execution:** `enableQuoteHandling` is broken for
> embedded delimiters (see the resolved/new-issue note under Pattern B). Both trainers kept
> their manual quote/pending logic; only the line-reading layer moved to `TextSpliterator`,
> with a `\r` strip (the CMS hospital CSV is CRLF — load-bearing, see Execution notes).

### Pattern C: Pipe/Custom delimiter (`for await (const line …)` + `line.split("|")` or `"\t"`)

**Before:**

```ts
const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
for await (const line of rl) {
	const fields = line.split("|")
}
```

**After:**

```ts
import { CSVSpliterator, Delimiters } from "spliterator"
// CORRECTED during execution: `delimiter` is the ROW delimiter (leave it default LF).
// The column separator option is `columnDelimiter`. Also note `header: true` is the
// DEFAULT — row 1 is consumed as a header even in mode:"array" — so headerless files
// (GeoNames, census) need `header: false` or they silently lose their first row.

for await (const fields of CSVSpliterator.fromAsync(path, {
	mode: "array",
	columnDelimiter: Delimiters.Pipe,
	header: false,
})) {
	// fields is string[]
}
```

**Affected files (4):** `gnaf/adapter.ts`, `importance.tsx`,
`redistricting.ts:122,203`, `postcode-intl.tsx`

### Pattern D: Child-process stdout

**Before:**

```ts
const proc = spawn("ogr2ogr", [...])
const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity })
for await (const line of rl) {
  const feat = JSON.parse(line)
}
```

**After:**

```ts
import { JSONSpliterator } from "spliterator"

const proc = spawn("ogr2ogr", [...])
for await (const feat of JSONSpliterator.fromAsync(proc.stdout!)) {
  // feat is already parsed
}
```

> spliterator accepts `AsyncChunkIterator` (which is what `Readable.toWeb()` or a
> `Readable` passed directly yields — the same interface `child_process` stdout
> satisfies as an async iterable of chunks). ⚠️ Test this path carefully — `ogr2ogr`
> and `osmconvert` sometimes emit trailing data after the stream appears done.

**Affected files (4):** `tiger/sdk/fetch.ts`, `osm/sdk/extract.ts`,
`osm/sdk/street-recovery.ts`, `locale.ts:218` (unzip pipe)

### Pattern E: Plain text line reader (no per-line parse)

**Before:**

```ts
const rl = createInterface({ input: createReadStream(jsonl, "utf8"), crlfDelay: Infinity })
for await (const line of rl) {
	/* process raw line */
}
```

**After:**

```ts
import { TextSpliterator } from "spliterator"

for await (const line of TextSpliterator.fromAsync(jsonl)) {
	// line is a string — same as readline
}
```

**Affected files (2):** `build-kryptonite-shard.ts`, `build-transliteration-shard.ts`

## Migration order

| Phase | Files                                                                                                                                                                                  | Notes                                                                                                             |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **1** | `scripts/jsonl-to-parquet.ts`, `corpus/src/build.ts` (JSONL → `JSONSpliterator`)                                                                                                       | Lowest risk — JSON has no delimiter ambiguity. These are the most exercised paths (every corpus build hits them). |
| **2** | All adapter JSONL call sites: `openaddresses/adapter.ts`, `overture/adapter.ts`, `synth-po-box/adapter.ts`, `usgov-nad/adapter.ts`, `gnaf/adapter.ts`, `scaffold.ts`, `align-shard.ts` | All JSONL. Same shape as Phase 1.                                                                                 |
| **3** | `scripts/eval/` call sites: `audit-po-box-cedex-shard.ts`, `reverse-geocode-eval.ts`, `holdout.ts`, `train-cross-gbt.ts`, `train-org-cross-gbt.ts`                                     | JSONL + CSV. Eval scripts — low blast radius for regressions.                                                     |
| **4** | CSV sites: `fr-admin-split.ts`, `locale.ts`, `ingest-csv.ts`                                                                                                                           | ⚠️ `skipEmpty` caveat — verify column counts match before landing.                                                |
| **5** | Pipe/TSV sites: `importance.tsx`, `postcode-intl.tsx`, `redistricting.ts`, `build-kryptonite-shard.ts`, `build-transliteration-shard.ts`                                               | Straightforward delimiter substitution.                                                                           |
| **6** | Child-process stdout sites: `tiger/sdk/fetch.ts`, `osm/sdk/extract.ts`, `osm/sdk/street-recovery.ts`, `locale.ts:218`                                                                  | ⚠️ Highest risk — external process pipelines. Test with real data.                                                |

## Risks

1. **`CSVSpliterator` `skipEmpty` bug.** Empty trailing fields are dropped. Any CSV
   with sparse fixed-width columns (NPPES, NAD, census files) will mis-align. The
   `registry/ingest.ts` workaround (manual `split` after `TextSpliterator`) is the
   correct mitigation until spliterator is patched. AUDIT affected call sites before
   migrating.

2. **Child-process backpressure.** `readline` pauses the underlying stream when it
   can't keep up. `TextSpliterator`/`JSONSpliterator` use the same `for await` pull
   model — backpressure is identical. The risk is a **stream teardown race:**
   `readline` fires `close` after the stream ends; `AsyncSpliterator` disposes
   immediately. If the child process writes trailing data after the main payload,
   spliterator may miss it. Test with real `ogr2ogr`/`osmconvert` output.

3. **`createInterface` with `process.stdin`.** `scripts/bless-package.ts` uses
   `readline/promises` for interactive OTP prompting. Spliterator is a byte-range
   splitter, not a line-editor. This call site is intentionally excluded from the
   migration.

4. **`split.ts` write path.** `corpus/src/split.ts:219` uses `createInterface` for
   reading AND `createWriteStream` for writing. Only the **read** phase migrates to
   spliterator. The write path stays on `node:fs` streams — spliterator's `writer`
   module is a different concern and this migration does not touch it.

## Validation

For each phase, verify:

- **JSONL:** byte-identical output for a known fixture (same row count, same values).
- **CSV:** column count matches the pre-migration baseline on a known fixture.
- **Pipe/TSV:** field count and values match.
- **Child-process:** exit code + row count match the `readline` baseline.

## Execution notes (2026-07-08)

Executed by five parallel agents over disjoint file sets, against a pre-flight API audit of the
installed spliterator v3.1.0 (live probes, not docs). Everything above marked "corrected" or
"superseded" came out of that audit. The deltas that mattered:

### API facts the plan missed (probed)

1. **`header: true` is the default in every CSV/TSV mode** — even `mode: "array"` consumes row 1.
   Headerless sites (`fr-admin-split.ts` communes TSV, `postcode-intl.tsx` GeoNames) took
   `header: false`; without it each would have silently dropped its first record.
2. **`delimiter` ≠ column separator.** `delimiter` splits ROWS; `columnDelimiter` splits columns.
3. **CRLF is not normalized** (readline's `crlfDelay: Infinity` was). JSONL sites are immune
   (`\r` is JSON whitespace). Text/CSV sites got a per-file disposition; the live case:
   `cms-pos_hospital-other_2026q1.csv` IS CRLF, and without a `\r` strip the trainer's last
   column (`ZIP_CD`) mis-keys. `importance.tsx` (remote nominatim gz) strips defensively — its
   wikidata id is the last column.
4. **`AsyncDataResource` omits `AsyncChunkIterator`** in the published type although its own
   docstring lists it and the runtime dispatches on `Symbol.asyncIterator`. Stream call sites
   (child stdout, gunzip/unzip pipes) use `as unknown as AsyncDataResource` with a comment.
5. **String streams silently break the byte scanner**: `createReadStream(path, { encoding: "utf8" })`
   yields string chunks the splitter can't scan (probed: all offsets -1). `locale.ts` had exactly
   this; the encoding option was removed so the stream yields Buffers.
6. **Tolerance parity ruled most JSONL sites.** `JSONSpliterator` throws on the first malformed
   row; every adapter/stream site that deliberately skipped bad lines (OA `#` comments,
   non-`Feature` shapes, ogr2ogr noise) stayed on `TextSpliterator` + its existing try/catch.
   `JSONSpliterator` landed only where the original was fail-loud (`build.ts` streamJsonl,
   `split.ts`, the two eval readers).

### Inventory corrections

- `corpus/src/adapters/gnaf/adapter.ts` is a JSONL reader, not pipe-delimited — the PSV reader is
  `assemble.ts`, which already used `PSVSpliterator` before this migration.
- `scripts/eval/gauntlet/holdout.ts` is semicolon-delimited CSV, not JSONL.

### The doc's stated risks, resolved

- **Trailing child-process data (risk 2): refuted.** Synthetic harness — 100k JSONL lines, flush,
  150 ms sleep, 3 more lines — read 100,003/100,003 via spliterator-over-stdout, identical to the
  readline baseline, exit code observed. Early break after 1k lines: clean disposal, no fd
  warnings, child killable/awaitable as before.
- **skipEmpty (risk 1): fixed upstream in v3.1.0** (empty fields preserved; probed).

### Performance (the standing 2026-06-10 benchmark, re-run)

Same protocol (labeled-train.jsonl v0.1.1, 21.8M rows / 11 GB, JSON.parse both arms, checksummed,
warm cache, Node 26.2.0): spliterator v2 measured **0.45×** readline; v3.1.0 measures
**0.91–0.92×** (readline 0.52–0.53M rows/s, spliterator 0.48M rows/s, checksums identical). The
rewrite roughly doubled v2's throughput; the residual ~8% deficit is the price of the fd-lifecycle

- dependency-surface wins, not a blocker.

### Upstream spliterator issues to file

1. `enableQuoteHandling` never reaches the column tokenizer — quoted embedded delimiters mis-parse.
2. `AsyncDataResource` should include `AsyncChunkIterator` (docstring already claims it).
3. Consider a `crlf: true` (or default) row-delimiter normalization to match readline ergonomics.
4. Consider rejecting or decoding string-chunk streams instead of silently failing to match.

### Follow-up

- `registry/ingest.ts:54`'s workaround comment cites the fixed skipEmpty bug as its reason —
  its real remaining reason is the quote-handling gap (issue 1). Update the comment when filing.
- `corpus/scripts/ingest-csv.ts` had a pre-existing launcher-breaking `import { SQLInputValue }`
  (value import of a type under type-stripping) — fixed to `import type` during integration.
