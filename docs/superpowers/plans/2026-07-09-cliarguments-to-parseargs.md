# cliArguments → node:util parseArgs Normalization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate every migratable `cliArguments()` call site in favor of native `node:util` `parseArgs`, leaving exactly one documented edge case (verbatim child-process passthrough), and fix the code smells surfaced during triage.

**Architecture:** Each script's hand-rolled argv loop is replaced by a strict `parseArgs` declaration reading `process.argv.slice(2)` by default (no `args:` passed except where a test injects argv). Three CLIs with negative-coordinate positionals switch to the standard `--` separator. The `runScript` exit-code bug (errors exit 0, clobbering `process.exitCode`) is fixed in the same pass since several migrated scripts depend on honest exit codes.

**Tech Stack:** node:util parseArgs, @mailwoman/core/scripting `runIfScript`, vitest, oxlint/oxfmt.

## Global Constraints

- Zero raw `process.env` / `process.argv` (CI-enforced oxlint `sister-software/no-process-globals`). `parseArgs` reads `process.argv.slice(2)` by default — never pass `args:` yourself, EXCEPT `main(argv?)` functions whose tests inject argv (`build-fts-cli.ts` pattern), where `args: argv ? [...argv] : undefined` is correct.
- `erasableSyntaxOnly` — no enums, no ctor param properties. Relative imports carry `.ts` extensions.
- Tabs for indentation; oxfmt formatting (`yarn format`); oxlint (`yarn lint`).
- Scripts run directly under `node` (type stripping) — never `npx tsx` in shebangs or usage text (feedback-no-npx-tsx).
- Tri-state boolean flags use `--x` / `--no-x` (feedback-native-parseargs-for-flags).
- `parseArgs` facts verified on this Node: string options DO NOT consume a following `-`-prefixed value (`--lon -74` throws; `--lon=-74` works); bare `-74.0` positional throws in strict mode; everything after `--` lands in `positionals`; `multiple: true` collects repeated flags including empty strings.
- Preserved external contracts: `resolver-wof-sqlite` bin grammars (spawned by `docs/plugins/demo-assets/resolve.ts` incl. `--in ""`), `publish-release-to-hf.ts` flag set incl. retired `--wof-hot` (documented in RELEASING.md), `build-fts-cli.test.ts` `main(argv)` exit-code contract.
- Deliberate KEEP: `corpus-python/scripts/train_with_resume.ts` `EXTRA_ARGS = cliArguments()` — verbatim passthrough to the python trainer; parseArgs cannot collect undeclared flags.

## Triage ledger (smells found, fixed by task number)

| Smell                                                                          | Where                                                                                                    | Task    |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------- |
| `runScript` exits 0 on error + `postScriptCleanup` clobbers `process.exitCode` | `core/scripting/utils/index.ts`                                                                          | 1       |
| Stale "negative-coordinate positionals" example on `cliArguments` docstring    | `core/scripting/utils/index.ts`                                                                          | 1       |
| Hand-rolled argv switch loops (duplicated)                                     | kryptonite/transliteration/audit/ingest-csv/extract-tuples/4× resolver CLIs/publish-to-hf/3× lookup CLIs | 2–9     |
| `#!/usr/bin/env npx tsx` shebangs + `npx tsx` usage text                       | audit, kryptonite, transliteration, fetch-ban-full, ingest-csv                                           | 2–5     |
| Wrong paths in docstrings (`packages/corpus/...`, `scripts/extract-tuples.ts`) | ingest-csv, fetch-ban-full, extract-tuples                                                               | 4–6     |
| Dead `cliArguments` import                                                     | fetch-ban-full                                                                                           | 5       |
| False "DELIBERATE hand-parse — parseArgs cannot express this" claims           | ingest-csv, extract-tuples, publish-to-hf                                                                | 4, 6, 8 |
| Unknown flags silently ignored (typo hazard in release tooling)                | publish-to-hf                                                                                            | 8       |
| Numeric-sniffing loops silently swallow junk argv                              | 3× lookup CLIs                                                                                           | 9       |
| Undocumented deliberate cliArguments use                                       | train_with_resume                                                                                        | 10      |

---

### Task 1: Fix runScript exit codes + retire stale cliArguments docstring example

**Files:**

- Modify: `core/scripting/utils/index.ts:34-81`

**Interfaces:**

- Produces: `postScriptCleanup(signal?, exitCode?)` — `exitCode` now `number | undefined`; `undefined` means "respect `process.exitCode`". `runScript` errors now exit 1.

- [ ] **Step 1: Write a failing smoke fixture**

Write `/tmp/claude-scratch-runscript-fixture.ts` (scratchpad, not the repo):

```ts
import { runIfScript } from "@mailwoman/core/scripting"

runIfScript(import.meta, () => {
	throw new Error("boom")
})
```

Run: `node /tmp/claude-scratch-runscript-fixture.ts; echo "exit=$?"`
Expected (bug): `exit=0` after the logged error.

- [ ] **Step 2: Fix postScriptCleanup + runScript**

In `core/scripting/utils/index.ts` replace the two functions:

```ts
/**
 * Cleans up services and exits the script cleanly.
 *
 * @param exitCode - Explicit exit code; when omitted, whatever `process.exitCode` the script set (default 0) stands.
 * @internal
 */
export function postScriptCleanup(signal: NodeJS.Signals = "SIGTERM", exitCode?: number): Promise<void> {
	ConsoleLogger.debug(`\n[${signal}] Shutting down...`)

	const timeout = setTimeout(() => {
		ConsoleLogger.error("Script did not exit in a timely manner.")

		ServiceRepository.abortController.abort(signal)

		const services = ServiceRepository.inspect()
		ConsoleLogger.warn(services, `${services.length} did not dispose.`)

		process.exit(1)
	}, 15_000)

	return ServiceRepository.dispose()
		.catch(logScriptError)
		.finally(() => {
			process.exit(exitCode ?? process.exitCode ?? 0)
			clearTimeout(timeout)
		})
}
```

Wait — keep `clearTimeout` BEFORE `process.exit` (order as in the original). Correct body of `.finally`:

```ts
		.finally(() => {
			clearTimeout(timeout)
			process.exit(exitCode ?? process.exitCode ?? 0)
		})
```

```ts
/**
 * Runs a script callback and handles cleanup. A callback that throws exits 1; a clean return exits with
 * `process.exitCode` (default 0).
 *
 * @internal
 */
export function runScript(scriptCallback: ScriptCallback): Promise<void> {
	process.on("SIGINT", postScriptCleanup)
	process.on("SIGTERM", postScriptCleanup)

	return Promise.resolve()
		.then(() => scriptCallback())
		.then(
			() => postScriptCleanup(),
			(error) => {
				logScriptError(error)

				return postScriptCleanup("SIGTERM", 1)
			}
		)
		.catch(() => postScriptCleanup("SIGTERM", 1))
}
```

Note the signal-handler registration still passes the signal name as the first arg and `undefined` as exitCode — Ctrl-C now exits with `process.exitCode ?? 0` instead of hard 0; acceptable and more honest.

- [ ] **Step 3: Update the cliArguments docstring** (same file, lines 72-77) — the negative-coordinate example dies in Task 9:

```ts
/**
 * The ONE blessed accessor for CLI arguments. Everything outside `core/env` + this module is forbidden from touching
 * `process.argv` directly (enforced by the `sister-software/no-process-globals` oxlint rule) — prefer `node:util`
 * `parseArgs` (which reads this same slice by default) and reach for this only where `parseArgs` cannot express the
 * grammar (e.g. verbatim passthrough of undeclared flags to a child process — see
 * `corpus-python/scripts/train_with_resume.ts`).
 */
```

- [ ] **Step 4: Verify the fixture now exits 1**

Run: `node /tmp/claude-scratch-runscript-fixture.ts; echo "exit=$?"`
Expected: logged error, then `exit=1`.

Also verify the clean path still exits 0:
`node -e 'import("@mailwoman/core/scripting")' ...` — simpler: temporarily change the fixture to `() => {}` and expect `exit=0`. Then a `process.exitCode = 3` fixture body should yield `exit=3`.

- [ ] **Step 5: Run core tests + commit**

Run: `yarn workspace @mailwoman/core test 2>&1 | tail -20` (or the repo's equivalent scoped test command; fall back to `yarn vitest run core/scripting` from root if workspaces don't define `test`).
Expected: PASS (no existing test asserts exit-0-on-error).

```bash
git add core/scripting/utils/index.ts
git commit -m "fix(scripting): runScript exits 1 on error and respects process.exitCode"
```

---

### Task 2: corpus shard builders → parseArgs

**Files:**

- Modify: `corpus/scripts/build-kryptonite-shard.ts:1,26-27,32-83,120`
- Modify: `corpus/scripts/build-transliteration-shard.ts:1,39-40,53-110,235`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: local `parseShardArgs(): Args` in each script (renamed from `parseArgs` to avoid shadowing the node:util import).

- [ ] **Step 1: build-kryptonite-shard.ts**

Shebang line 1: `#!/usr/bin/env npx tsx` → `#!/usr/bin/env node`. In the docstring usage block, `npx tsx corpus/scripts/build-kryptonite-shard.ts` → `node corpus/scripts/build-kryptonite-shard.ts`.

Imports: drop `import { cliArguments } from "@mailwoman/core/scripting/utils"`, add `import { parseArgs } from "node:util"` (node-builtin group, alongside `node:fs` imports).

Replace the `Args` interface + `parseArgs` function (lines 32-83) with:

```ts
interface Args {
	jsonl: string
	baseManifest: string
	outDir: string
	corpusVersion: string
	source: string
}

function parseShardArgs(): Args {
	const { values } = parseArgs({
		options: {
			jsonl: { type: "string" },
			"base-manifest": { type: "string" },
			"out-dir": { type: "string" },
			"corpus-version": { type: "string", default: "0.4.0" },
			source: { type: "string", default: "deepseek-kryptonite" },
		},
	})

	if (!values.jsonl) throw new Error("--jsonl required")

	if (!values["base-manifest"]) throw new Error("--base-manifest required")

	if (!values["out-dir"]) throw new Error("--out-dir required")

	return {
		jsonl: values.jsonl,
		baseManifest: values["base-manifest"],
		outDir: values["out-dir"],
		corpusVersion: values["corpus-version"],
		source: values.source,
	}
}
```

Line 120: `const args = parseArgs(cliArguments())` → `const args = parseShardArgs()`.

- [ ] **Step 2: build-transliteration-shard.ts** — same treatment. Shebang + usage text. Replace its `parseArgs` fn:

```ts
function parseShardArgs(): Args {
	const { values } = parseArgs({
		options: {
			jsonl: { type: "string" },
			"base-manifest": { type: "string" },
			"out-dir": { type: "string" },
			"corpus-version": { type: "string", default: "0.4.0" },
			"canonical-path-prefix": { type: "string", default: "/data/" },
			"legacy-path-prefix": { type: "string", default: "/mnt/playpen/mailwoman-data/" },
		},
	})

	if (!values.jsonl) throw new Error("--jsonl required")

	if (!values["base-manifest"]) throw new Error("--base-manifest required")

	if (!values["out-dir"]) throw new Error("--out-dir required")

	return {
		jsonl: values.jsonl,
		baseManifest: values["base-manifest"],
		outDir: values["out-dir"],
		corpusVersion: values["corpus-version"],
		canonicalPathPrefix: values["canonical-path-prefix"],
		legacyPathPrefix: values["legacy-path-prefix"],
	}
}
```

Call site: `const args = parseShardArgs()`.

- [ ] **Step 3: Verify**

Run: `node corpus/scripts/build-kryptonite-shard.ts; echo "exit=$?"`
Expected: logged `--jsonl required` error, `exit=1` (Task 1's fix).
Run: `node corpus/scripts/build-kryptonite-shard.ts --bogus x; echo "exit=$?"`
Expected: parseArgs unknown-option error, `exit=1`.
Same two probes for `build-transliteration-shard.ts`.

- [ ] **Step 4: Commit**

```bash
git add corpus/scripts/build-kryptonite-shard.ts corpus/scripts/build-transliteration-shard.ts
git commit -m "refactor(corpus): shard builders parse argv with node:util parseArgs"
```

---

### Task 3: audit.ts → parseArgs

**Files:**

- Modify: `corpus/scripts/audit.ts:1,16-18,31,366-386`

- [ ] **Step 1: Edit**

Shebang → `#!/usr/bin/env node`; docstring usage lines 16-20: `npx tsx corpus/scripts/audit.ts …` → `node corpus/scripts/audit.ts …` (two occurrences).

Imports: drop `cliArguments` import; add `import { parseArgs } from "node:util"`.

Replace `parseArgv` (lines 366-384) + the runner:

```ts
function parseArgv(): AuditOpts {
	const { values, positionals } = parseArgs({
		options: {
			config: { type: "string" },
			sample: { type: "string" },
		},
		allowPositionals: true,
	})
	const corpusDir = positionals[0]

	if (!corpusDir) {
		console.error("Usage: audit.ts <corpus_dir> [--config <yaml>] [--sample <n>]")
		process.exit(2)
	}

	return {
		corpusDir,
		configPath: values.config,
		sampleShardCount: values.sample ? parseInt(values.sample, 10) : undefined,
	}
}

runIfScript(import.meta, () => audit(parseArgv()))
```

- [ ] **Step 2: Verify**

Run: `node corpus/scripts/audit.ts; echo "exit=$?"` → usage line, `exit=2`.
Run: `node corpus/scripts/audit.ts /nonexistent-dir; echo "exit=$?"` → report with `Total shards: 0`, exit 0.
Run: `yarn vitest run corpus/scripts/audit.test.ts` (from repo root; use the corpus workspace's test command if defined) → PASS.

- [ ] **Step 3: Commit**

```bash
git add corpus/scripts/audit.ts
git commit -m "refactor(corpus): audit.ts parses argv with node:util parseArgs"
```

---

### Task 4: ingest-csv.ts → parseArgs (the "dynamic keys" claim is false)

**Files:**

- Modify: `corpus/scripts/ingest-csv.ts:14-28,37-66`, main (`cliArgs` reads)

The header claims `DELIBERATE hand-parse: dynamic --key value pairs` — but main() reads a fixed set: `input, table, output, sample, separator, skip, no-header, dry-run`. The dynamic part is the inferred SQL schema, not the CLI. Migrate.

- [ ] **Step 1: Edit**

Docstring: usage block `npx tsx packages/corpus/scripts/ingest-csv.ts` → `node corpus/scripts/ingest-csv.ts`; delete the `DELIBERATE hand-parse…` line. Keep the `splitCSVLine` hand-roll comment (that one is true and about CSV, not argv).

Imports: drop `cliArguments`; add `import { parseArgs } from "node:util"`.

Replace the `parseArgs(): Record<string, string>` function (lines 45-66) with nothing — parse inline in `main()`:

```ts
async function main() {
	const { values } = parseArgs({
		options: {
			input: { type: "string" },
			table: { type: "string" },
			output: { type: "string" },
			sample: { type: "string", default: "100" },
			separator: { type: "string", default: "," },
			skip: { type: "string", default: "0" },
			"no-header": { type: "boolean", default: false },
			"dry-run": { type: "boolean", default: false },
		},
	})
	const inputPath = values.input

	if (!inputPath) {
		process.stderr.write(
			"Usage: node corpus/scripts/ingest-csv.ts --input <path.csv> [--table <name>] [--output <path.db>] [--dry-run]\n"
		)
		process.exit(1)
	}

	if (!existsSync(inputPath)) {
		process.stderr.write(`File not found: ${inputPath}\n`)
		process.exit(1)
	}

	const csvName = basename(inputPath, extname(inputPath))
	const outputPath = values.output ?? join(dirname(inputPath), csvName + ".db")

	const opts: IngestOptions = {
		inputPath,
		tableName: values.table ?? csvName.replace(/[^a-zA-Z0-9_]/g, "_"),
		outputPath,
		sampleSize: parseInt(values.sample, 10),
		separator: values.separator,
		skipLines: parseInt(values.skip, 10),
		hasHeader: !values["no-header"],
		dryRun: values["dry-run"],
	}

	await ingestCSV(opts)
}
```

(Also delete the now-stale `// CLI arg parsing (minimal — no yargs…)` banner comment block.)

- [ ] **Step 2: Verify**

Run: `node corpus/scripts/ingest-csv.ts; echo "exit=$?"` → usage, exit 1.
Run a real dry-run against a scratch CSV:

```bash
printf 'a,b\n1,x\n2,y\n' > /tmp/claude-scratch-ingest.csv
node corpus/scripts/ingest-csv.ts --input /tmp/claude-scratch-ingest.csv --dry-run
```

Expected: printed `CREATE TABLE` with columns `a` (INTEGER-ish) + `b` (TEXT), no DB written, exit 0.

- [ ] **Step 3: Commit**

```bash
git add corpus/scripts/ingest-csv.ts
git commit -m "refactor(corpus): ingest-csv parses argv with node:util parseArgs (flag set was fixed, not dynamic)"
```

---

### Task 5: fetch-ban-full.ts — dead import + doc hygiene

**Files:**

- Modify: `corpus/scripts/fetch-sources/fetch-ban-full.ts:1,25,44`

- [ ] **Step 1: Edit**

Line 1 shebang → `#!/usr/bin/env node`. Docstring usage: `npx tsx packages/corpus/scripts/fetch-sources/fetch-ban-full.ts` → `node corpus/scripts/fetch-sources/fetch-ban-full.ts`. Delete line 44 (`import { cliArguments } …` — never used; `parseCLIArgs` already uses native parseArgs).

- [ ] **Step 2: Verify + commit**

Typecheck only — do NOT run it (it downloads ~GBs from adresse.data.gouv.fr). `yarn lint corpus/scripts/fetch-sources/fetch-ban-full.ts` (or full `yarn lint`) → clean.

```bash
git add corpus/scripts/fetch-sources/fetch-ban-full.ts
git commit -m "chore(corpus): drop dead cliArguments import from fetch-ban-full"
```

---

### Task 6: extract-tuples.ts — shards become positionals

**Files:**

- Modify: `scripts/eval/extract-tuples.ts:17-22,28,311-343`

Grammar change: argparse-style greedy `--shards a b c` → variadic positionals (`node scripts/eval/extract-tuples.ts --output out.jsonl [--sqlite wof.db] [--limit N] <shard.parquet>...`). No live callers (only historical docs reference the `.py` ancestor); the sibling `extract-tuples-de-gb.ts` is a separate script.

- [ ] **Step 1: Edit**

Docstring: fix stale path + grammar + delete the DELIBERATE line:

```
 *   Usage: node scripts/eval/extract-tuples.ts\
 *   --output /tmp/tuples.jsonl\
 *   [--sqlite /mnt/playpen/mailwoman-data/wof/admin-global-priority.db]\
 *   [--limit 50000]\
 *   <shard.parquet>...
```

(The old example passed a WOF SQLite DB to `--shards` — wrong slot; the DB belongs to `--sqlite`.)

Imports: drop `cliArguments`; add `import { parseArgs } from "node:util"`.

Replace `parseArgs(): Args` (lines 318-343):

```ts
function parseCLIArgs(): Args {
	const { values, positionals } = parseArgs({
		options: {
			sqlite: { type: "string" },
			output: { type: "string" },
			limit: { type: "string" },
		},
		allowPositionals: true,
	})

	return {
		shards: positionals,
		sqlite: values.sqlite,
		output: values.output,
		limit: values.limit ? parseInt(values.limit, 10) : undefined,
	}
}
```

In `main()`: `const args = parseArgs()` → `const args = parseCLIArgs()`.

- [ ] **Step 2: Verify**

Run: `node scripts/eval/extract-tuples.ts; echo "exit=$?"` → `error: the following arguments are required: --output`, exit 2.
Run: `node scripts/eval/extract-tuples.ts --output /tmp/claude-scratch-tuples.jsonl; echo "exit=$?"` → `Wrote 0 tuples…`, exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/eval/extract-tuples.ts
git commit -m "refactor(eval): extract-tuples takes shards as positionals via parseArgs"
```

---

### Task 7: resolver-wof-sqlite build CLIs (×4) → parseArgs, grammar-preserving

**Files:**

- Modify: `resolver-wof-sqlite/build-fts-cli.ts`
- Modify: `resolver-wof-sqlite/build-fts-cli.test.ts:101-111` (unknown-flag message regex only)
- Modify: `resolver-wof-sqlite/build-coincident-roles-cli.ts`
- Modify: `resolver-wof-sqlite/build-candidate-cli.ts`
- Modify: `resolver-wof-sqlite/build-slim-cli.ts`

**Interfaces:**

- Produces: each keeps `export … main(argv?: readonly string[])` (fts/coincident sync → number; candidate/slim async → Promise<number>). `argv === undefined` ⇒ parseArgs reads process.argv. Entry becomes `runIfScript(import.meta, () => main())` / `runIfScript(import.meta, main)` — **no cliArguments**. Tests keep injecting argv.
- Preserved grammars: `build-fts <db>... [--drop]`; `build-coincident-roles <db>... [--drop|--no-drop]`; `build-candidate --in/--input <db> --out/--output <db> [--postcodes <db>]...`; `build-slim --in <db>... --out <db> [--top N] [--countries CSV] [--drop-names]` incl. `--in ""` empty-value tolerance (spawned by docs/plugins/demo-assets/resolve.ts).

- [ ] **Step 1: build-fts-cli.ts**

Drop the `cliArguments` import; add `import { parseArgs } from "node:util"`. Replace `parseArgs(argv)` local fn + `main`:

```ts
function parseCLIArgs(argv: readonly string[] | undefined): CLIArgs {
	let parsed: ReturnType<typeof parseFTSArgv>

	try {
		parsed = parseFTSArgv(argv)
	} catch (error) {
		stderr.write(`mailwoman-wof-build-fts: ${error instanceof Error ? error.message : String(error)}\n`)
		printUsageAndExit(2)
	}

	if (parsed.values.help) {
		printUsageAndExit(0)
	}

	if (parsed.positionals.length === 0) {
		stderr.write(`mailwoman-wof-build-fts: expected at least one positional arg\n`)
		printUsageAndExit(2)
	}

	return { databasePaths: parsed.positionals, drop: parsed.values.drop }
}

function parseFTSArgv(argv: readonly string[] | undefined) {
	return parseArgs({
		args: argv ? [...argv] : undefined,
		options: {
			drop: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
		allowPositionals: true,
	})
}
```

`main` signature: `export function main(argv?: readonly string[]): number` with `const args = parseCLIArgs(argv)`; body unchanged. Runner: `runIfScript(import.meta, () => main())`.

- [ ] **Step 2: Update the test's unknown-flag expectation** (`build-fts-cli.test.ts:109`): parseArgs words it as `Unknown option '--bogus'…`:

```ts
expect(written).toMatch(/Unknown option/)
```

(Keep the exit-2 assertion untouched.)

- [ ] **Step 3: Run the CLI test file**

Run: `yarn vitest run resolver-wof-sqlite/build-fts-cli.test.ts` (scoped however the workspace runs vitest).
Expected: all 9 tests PASS.

- [ ] **Step 4: build-coincident-roles-cli.ts** — same shape; tri-state `--drop`/`--no-drop`, default rebuild:

```ts
export function main(argv?: readonly string[]): number {
	let parsed: ReturnType<typeof parseRolesArgv>

	try {
		parsed = parseRolesArgv(argv)
	} catch (error) {
		stderr.write(`mailwoman-wof-build-coincident-roles: ${error instanceof Error ? error.message : String(error)}\n`)
		printUsageAndExit(2)
	}

	if (parsed.values.help) {
		printUsageAndExit(0)
	}
	const paths = parsed.positionals

	if (paths.length === 0) {
		printUsageAndExit(2)
	}

	// The relation is a cheap (~2 s) derived table that must reflect the current spr/ancestors, so it
	// rebuilds by default (idempotent). `--no-drop` appends instead — only useful for incremental tests.
	const drop = !parsed.values["no-drop"]
	let worst = 0

	for (const path of paths) {
		const rc = buildOne(path, drop)

		if (rc > worst) {
			worst = rc
		}
	}

	return worst
}

function parseRolesArgv(argv: readonly string[] | undefined) {
	return parseArgs({
		args: argv ? [...argv] : undefined,
		options: {
			drop: { type: "boolean", default: false },
			"no-drop": { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
		allowPositionals: true,
	})
}
```

Runner: `runIfScript(import.meta, () => main())`.

- [ ] **Step 5: build-candidate-cli.ts** — `--in`/`--input` + `--out`/`--output` aliases, repeated `--postcodes`:

```ts
function parseCLIArgs(argv: readonly string[] | undefined): CLIArgs {
	let parsed: ReturnType<typeof parseCandidateArgv>

	try {
		parsed = parseCandidateArgv(argv)
	} catch (error) {
		stderr.write(`mailwoman-wof-build-candidate: ${error instanceof Error ? error.message : String(error)}\n`)
		printUsageAndExit(2)
	}

	if (parsed.values.help) {
		printUsageAndExit(0)
	}
	const input = parsed.values.input ?? parsed.values.in
	const output = parsed.values.output ?? parsed.values.out

	if (!input || !output) {
		printUsageAndExit(1)
	}

	return { input, output, postcodes: parsed.values.postcodes.filter(Boolean) }
}

function parseCandidateArgv(argv: readonly string[] | undefined) {
	return parseArgs({
		args: argv ? [...argv] : undefined,
		options: {
			in: { type: "string" },
			input: { type: "string" },
			out: { type: "string" },
			output: { type: "string" },
			postcodes: { type: "string", multiple: true, default: [] },
			help: { type: "boolean", short: "h", default: false },
		},
	})
}
```

`export async function main(argv?: readonly string[]): Promise<number>` with `const args = parseCLIArgs(argv)`. Runner: `runIfScript(import.meta, () => main())`.

- [ ] **Step 6: build-slim-cli.ts** — repeated `--in` with `--in ""` tolerance, `--top` validation, CSV `--countries`:

```ts
function parseCLIArgs(argv: readonly string[] | undefined): CLIArgs {
	let parsed: ReturnType<typeof parseSlimArgv>

	try {
		parsed = parseSlimArgv(argv)
	} catch (error) {
		stderr.write(`mailwoman-wof-build-slim: ${error instanceof Error ? error.message : String(error)}\n`)
		printUsageAndExit(2)
	}

	if (parsed.values.help) {
		printUsageAndExit(0)
	}

	// Callers pass `--in ""` for a shard (e.g. a custom postcode DB) that isn't built yet — keep
	// only non-empty paths; build-slim skips the rest.
	const inputs = parsed.values.in.filter(Boolean)
	const output = parsed.values.out
	const top = Number(parsed.values.top)

	if (!Number.isFinite(top) || top <= 0) {
		stderr.write(`--top must be a positive number; got '${parsed.values.top}'\n`)
		exit(2)
	}
	const countries = parsed.values.countries
		.split(",")
		.map((c) => c.trim())
		.filter(Boolean)

	if (inputs.length === 0 || !output) {
		printUsageAndExit(2)
	}

	return { inputs, output, topLocalities: top, countries, dropNames: parsed.values["drop-names"] }
}

function parseSlimArgv(argv: readonly string[] | undefined) {
	return parseArgs({
		args: argv ? [...argv] : undefined,
		options: {
			in: { type: "string", multiple: true, default: [] },
			out: { type: "string" },
			top: { type: "string", default: "1000" },
			countries: { type: "string", default: "US" },
			"drop-names": { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	})
}
```

`export async function main(argv?: readonly string[]): Promise<number>` — the old `try { parseArgs } catch { return 2 }` wrapper collapses into `parseCLIArgs`; delegate + progress body unchanged. Runner: `runIfScript(import.meta, () => main())`.

- [ ] **Step 7: Verify all four**

```bash
node resolver-wof-sqlite/build-fts-cli.ts --help; echo "exit=$?"            # usage, exit 0
node resolver-wof-sqlite/build-coincident-roles-cli.ts -h; echo "exit=$?"   # usage, exit 0
node resolver-wof-sqlite/build-candidate-cli.ts --help; echo "exit=$?"      # usage, exit 0
node resolver-wof-sqlite/build-slim-cli.ts --help; echo "exit=$?"           # usage, exit 0
node resolver-wof-sqlite/build-slim-cli.ts --in "" --out /tmp/x.db; echo "exit=$?"  # usage, exit 2 (no non-empty inputs)
node resolver-wof-sqlite/build-fts-cli.ts --bogus; echo "exit=$?"           # Unknown option + usage, exit 2
```

Note: `--help` exits via `printUsageAndExit(0)` inside `runIfScript` — with Task 1's change, `process.exit(0)` fires before cleanup, same as today.

Run the workspace tests: `yarn vitest run resolver-wof-sqlite/` scoped as available → PASS.

- [ ] **Step 8: Commit**

```bash
git add resolver-wof-sqlite/build-fts-cli.ts resolver-wof-sqlite/build-fts-cli.test.ts resolver-wof-sqlite/build-coincident-roles-cli.ts resolver-wof-sqlite/build-candidate-cli.ts resolver-wof-sqlite/build-slim-cli.ts
git commit -m "refactor(resolver-wof-sqlite): build CLIs parse argv with node:util parseArgs"
```

---

### Task 8: publish-release-to-hf.ts → strict parseArgs

**Files:**

- Modify: `scripts/publish-release-to-hf.ts:33,42,44-54,79-110` + every `args.*`/`args[flagKey]` read

⚠ Release tooling. Behavior-preserving except: unknown flags now ERROR instead of being silently ignored (typo protection); a trailing valueless `--flag` now errors instead of being dropped. The retired `--wof-hot` stays declared (RELEASING.md's documented invocation passes it).

- [ ] **Step 1: Replace the parser**

Docstring: delete the `DELIBERATE hand-parse…` line. Imports: keep `childEnv`, drop `cliArguments`; add `import { parseArgs } from "node:util"`.

`REQUIRED_FILES` gets the parseArgs option key instead of the raw flag:

```ts
const REQUIRED_FILES = [
	{ option: "model", remoteName: "model.onnx", description: "ONNX classifier" },
	{ option: "tokenizer", remoteName: "tokenizer.model", description: "SentencePiece tokenizer" },
	{ option: "model-card", remoteName: "model-card.json", description: "Model card JSON" },
	{ option: "fst", remoteName: "fst-en-US.bin", description: "FST gazetteer (filename varies by locale)" },
] as const
```

(Keep the retired-wof-hot.db comment block above it verbatim.)

Replace `ParsedArgs` + `parseArgs()` (lines 79-110):

```ts
function parseCLIArgs() {
	const { values } = parseArgs({
		options: {
			version: { type: "string" },
			locale: { type: "string" },
			label: { type: "string" },
			description: { type: "string" },
			model: { type: "string" },
			tokenizer: { type: "string" },
			"model-card": { type: "string" },
			fst: { type: "string" },
			"model-size": { type: "string" },
			steps: { type: "string" },
			postcodes: { type: "string" },
			"gazetteer-lexicon": { type: "string" },
			polygons: { type: "string" },
			"set-default": { type: "boolean", default: false },
			// Retired 2026-06-20 with the slim wof-hot.db (see REQUIRED_FILES note). Still accepted so
			// RELEASING.md's documented invocations don't hard-fail; the value is ignored.
			"wof-hot": { type: "string" },
		},
	})

	return values
}
```

- [ ] **Step 2: Rename every read site** (mechanical; `args` stays the local name in `main`):

| Old                                                                                                                            | New                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `const args = parseArgs()`                                                                                                     | `const args = parseCLIArgs()`                                                                             |
| `args[flagKey] as string \| undefined` / `args[flagKey] as string` (REQUIRED_FILES loops)                                      | `args[file.option]` (loop variable renamed accordingly; flag text in messages = `` `--${file.option}` ``) |
| `args.modelSize`                                                                                                               | `args["model-size"]`                                                                                      |
| `args.gazetteerLexicon`                                                                                                        | `args["gazetteer-lexicon"]`                                                                               |
| `args.setDefault`                                                                                                              | `args["set-default"]`                                                                                     |
| `args.version`, `args.locale`, `args.label`, `args.description`, `args.model`, `args.postcodes`, `args.polygons`, `args.steps` | unchanged                                                                                                 |

Where the old code did `statSync(args.model as string)` the cast survives or becomes a non-null assertion — `args.model` is `string | undefined` and is guaranteed by the REQUIRED_FILES existence loop before that line; prefer `args.model!`.

- [ ] **Step 3: Verify**

```bash
node scripts/publish-release-to-hf.ts; echo "exit=$?"                          # "✗ --version required", exit 1
node scripts/publish-release-to-hf.ts --version v0.0.0-test; echo "exit=$?"    # "✗ --locale required", exit 1
node scripts/publish-release-to-hf.ts --bogus x; echo "exit=$?"                # parseArgs Unknown option error, exit 1
```

(No HF calls fire before required-flag validation — safe to run.) Cross-check the RELEASING.md invocation flag list (`--version --locale --label --description --model --tokenizer --model-card --fst --wof-hot --gazetteer-lexicon --postcodes --polygons --steps --set-default`) — every one must be declared above.

- [ ] **Step 4: Commit**

```bash
git add scripts/publish-release-to-hf.ts
git commit -m "refactor(release): publish-release-to-hf uses strict parseArgs (typo'd flags now error)"
```

---

### Task 9: lookup CLIs (×3) → parseArgs with `--` positionals

**Files:**

- Modify: `timezone-lookup/cli.ts` (full rewrite below)
- Modify: `nuts-lookup/cli.ts` (same pattern)
- Modify: `un-locode-lookup/cli.ts` (same pattern; `--near` retired)
- Modify: `timezone-lookup/README.md:18`, `nuts-lookup/README.md:17`, `un-locode-lookup/README.md:20`

Grammar change (pre-1.0-style operator tools, shipped 2026-06-26): coordinates remain positionals but negative values now require the standard `--` separator (strict parseArgs's own error tells the user exactly this). `mailwoman-un-locode --near <lat> <lon>` → `mailwoman-un-locode -- <lat> <lon>`. Junk argv no longer silently swallowed.

- [ ] **Step 1: timezone-lookup/cli.ts** — full new content (keep the license header block):

````ts
#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman-timezone` — build the polygon DB, or look up a coordinate's IANA timezone.
 *
 *   ```sh
 *   mailwoman-timezone build --geojson combined-with-oceans.json --out timezone.db
 *   mailwoman-timezone --db timezone.db -- 40.7128 -74.0060
 *   ```
 *
 *   The `--` separates flags from coordinates so negative longitudes parse as positionals.
 */

import { parseArgs } from "node:util"

import { buildTimezoneDB } from "./build.ts"
import { offsetSecForTimezone, TimezoneLookup } from "./index.ts"

const { values, positionals } = parseArgs({
	options: {
		geojson: { type: "string" },
		out: { type: "string" },
		db: { type: "string" },
	},
	allowPositionals: true,
})

if (positionals[0] === "build") {
	if (!values.geojson || !values.out) {
		console.error("Usage: mailwoman-timezone build --geojson <path> --out <db>")
		process.exit(1)
	}
	const { features } = buildTimezoneDB(values.geojson, values.out)
	console.error(`built ${values.out} (${features} features)`)
} else {
	const lat = Number(positionals[0])
	const lon = Number(positionals[1])

	if (!values.db || !Number.isFinite(lat) || !Number.isFinite(lon)) {
		console.error("Usage: mailwoman-timezone --db <db> -- <lat> <lon>")
		process.exit(1)
	}
	const lookup = new TimezoneLookup({ databasePath: values.db })
	const tzid = lookup.find(lat, lon)
	console.log(JSON.stringify({ timezone: tzid, offsetSec: tzid ? offsetSecForTimezone(tzid) : null }))
	lookup.close()
}
````

- [ ] **Step 2: nuts-lookup/cli.ts** — identical pattern: options `{ geojson, out, db }`; build branch calls `buildNutsDB(values.geojson, values.out)` printing `` `built ${values.out} (${regions} regions)` ``; lookup branch prints `JSON.stringify({ nuts: lookup.find(lat, lon) })` via `new NutsLookup({ databasePath: values.db })`; usages `mailwoman-nuts build --geojson <path> --out <db>` / `mailwoman-nuts --db <db> -- <lat> <lon>`.

- [ ] **Step 3: un-locode-lookup/cli.ts** — options `{ csv, out, db, country, name }`; build branch `buildUnLocodeDB(values.csv, values.out)` printing rows/withCoords; lookup branch:

```ts
if (!values.db) {
	console.error("Usage: mailwoman-un-locode --db <db> (--country CC --name NAME | -- <lat> <lon>)")
	process.exit(1)
}
const lookup = new UnLocodeLookup({ databasePath: values.db })
const lat = Number(positionals[0])
const lon = Number(positionals[1])
let code: string | null = null

if (values.country && values.name) {
	code = lookup.byName(values.country, values.name)
} else if (Number.isFinite(lat) && Number.isFinite(lon)) {
	code = lookup.nearest(lat, lon)
}
console.log(JSON.stringify({ unLocode: code }))
lookup.close()
```

File docstring examples drop `--near`.

- [ ] **Step 4: README updates**

- `timezone-lookup/README.md:18`: `npx @mailwoman/timezone-lookup --db timezone.db 40.7128 -74.0060` → `npx @mailwoman/timezone-lookup --db timezone.db -- 40.7128 -74.0060`
- `nuts-lookup/README.md:17`: `… --db nuts.db 52.52 13.405` → `… --db nuts.db -- 52.52 13.405`
- `un-locode-lookup/README.md:20`: `… --db un-locode.db --near 40.7128 -74.0060` → `… --db un-locode.db -- 40.7128 -74.0060`

- [ ] **Step 5: Verify**

```bash
node timezone-lookup/cli.ts; echo "exit=$?"                       # usage, exit 1
node timezone-lookup/cli.ts --db /tmp/none.db -- 40.7 -74.0; echo "exit=$?"   # sqlite open error (parse succeeded), non-zero
node timezone-lookup/cli.ts --db /tmp/none.db 40.7 -74.0 2>&1 | head -3      # parseArgs error mentioning '--'
node un-locode-lookup/cli.ts --db /tmp/none.db --country US --name "New York" 2>&1 | head -3  # sqlite open error (parse succeeded)
```

If a real timezone.db exists under `$MAILWOMAN_DATA_ROOT`, run one true lookup as a positive check.

- [ ] **Step 6: Commit**

```bash
git add timezone-lookup/cli.ts nuts-lookup/cli.ts un-locode-lookup/cli.ts timezone-lookup/README.md nuts-lookup/README.md un-locode-lookup/README.md
git commit -m "refactor(lookups): coordinate CLIs use parseArgs with '--' positionals (drops --near)"
```

---

### Task 10: Mark the surviving deliberate cliArguments use

**Files:**

- Modify: `corpus-python/scripts/train_with_resume.ts:27`

- [ ] **Step 1: Annotate**

```ts
// DELIBERATE cliArguments: EXTRA_ARGS is a verbatim passthrough to `python -m mailwoman_train train`
// — parseArgs cannot collect undeclared flags, and reconstructing them would be lossy.
const EXTRA_ARGS = cliArguments()
```

- [ ] **Step 2: Commit**

```bash
git add corpus-python/scripts/train_with_resume.ts
git commit -m "docs(corpus-python): mark train_with_resume's cliArguments passthrough as deliberate"
```

---

### Task 11: Repo-wide verification

- [ ] **Step 1: Residue check**

Run: `grep -rn 'cliArguments' --include='*.ts' --exclude-dir=node_modules --exclude-dir=out .`
Expected survivors ONLY: `core/scripting/utils/index.ts` (definition), `corpus-python/scripts/train_with_resume.ts` (deliberate), `scripts/AGENTS.md` mention (docs).

- [ ] **Step 2: Lint + format + typecheck**

```bash
yarn lint
yarn format
git diff --stat   # formatter deltas fold into the final commit if any
yarn build 2>&1 | tail -5   # or the repo's tsc -b equivalent; touched workspaces must compile
```

Expected: lint clean, build clean.

- [ ] **Step 3: Test the touched workspaces**

```bash
yarn vitest run resolver-wof-sqlite corpus/scripts 2>&1 | tail -15
```

(Scope per the workspace vitest configs; full `yarn test` acceptable but re-creates dev-weight symlinks — fine locally, do not follow with a publish.)

- [ ] **Step 4: Final commit if the formatter moved anything**

```bash
git add -A && git commit -m "chore: format sweep for parseArgs migration" || true
```
