# Pastel Arc Phase 0: core helpers + cli-kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the shared foundations the migration phases consume: `readJSONL`/`writeJSONL`/`iterateJSONL`, stats + `formatPercent`, `sha256File` in `@mailwoman/core/utils`; and `mailwoman/cli-kit` (command types + `useCommandTask` + `CheckList`) / `mailwoman/test-kit` extracted from `mailwoman/sdk` with deprecated shims.

**Architecture:** New pure modules in `core/utils/` re-exported from the existing `@mailwoman/core/utils` subpath (no exports-map change). `mailwoman/sdk/cli.ts` and `mailwoman/sdk/test/` move to `mailwoman/cli-kit/` and `mailwoman/test-kit/`; the old files become one-line deprecated re-export shims so the published `./sdk/*` subpaths keep resolving; new `./cli-kit` + `./test-kit` subpaths are added to BOTH exports maps. `cli-kit` stays a plain `.ts` (components via `createElement`, no JSX) so the dev `node →` source condition keeps working under type stripping.

**Tech Stack:** node:crypto, spliterator (already a core dep), react hooks + ink (already mailwoman deps), vitest.

## Global Constraints (from the spec)

- New core helpers use acronym casing: `readJSONL`, not `readJsonl` (don't join the #875 debt).
- Dual exports maps: any new subpath is added to BOTH `exports` (with `node →` source condition first) and `publishConfig.exports` (types first, then default).
- `erasableSyntaxOnly`; relative imports carry `.ts` extensions; tabs; oxfmt.
- Canonical percentile = the gate scripts' shape (nearest-rank floor, `null` on empty) — gate parity in Phase 5 depends on this exact semantics.
- `sdk/` submodules mean data acquisition — cli/test helpers move out; shims stay until next major.
- Tool/kit modules never touch argv or call `process.exit(0)` implicitly; `useCommandTask` owns exit codes (error → 1).

---

### Task 1: `core/utils/jsonl.ts`

**Files:**

- Create: `core/utils/jsonl.ts`
- Create: `core/utils/jsonl.test.ts`
- Modify: `core/utils/index.ts` (add re-export)

**Interfaces:**

- Produces: `readJSONL<T>(path: string): T[]`, `writeJSONL(path: string, rows: Iterable<unknown>): number`, `iterateJSONL<T>(path: string): AsyncIterable<T>`

- [ ] **Step 1: Write the failing test** (`core/utils/jsonl.test.ts`)

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { iterateJSONL, readJSONL, writeJSONL } from "./jsonl.ts"

describe("jsonl", () => {
	it("round-trips rows and skips blank lines", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jsonl-"))
		const path = join(dir, "rows.jsonl")
		const rows = [{ a: 1 }, { b: "two" }]

		expect(writeJSONL(path, rows)).toBe(2)
		expect(readJSONL(path)).toEqual(rows)

		// Blank + whitespace-only lines are skipped, trailing newline tolerated.
		writeFileSync(path, '{"a":1}\n\n  \n{"b":"two"}\n', "utf8")
		expect(readJSONL(path)).toEqual(rows)

		const streamed = []
		for await (const row of iterateJSONL(path)) streamed.push(row)
		expect(streamed).toEqual(rows)
	})
})
```

- [ ] **Step 2: Run it** — `node_modules/.bin/vitest run core/utils/jsonl.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** (`core/utils/jsonl.ts`)

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   JSON Lines helpers — the canonical home for the `split("\n") + JSON.parse` idiom that was
 *   re-rolled across ~88 scripts (2026-07-09 dedupe survey). `iterateJSONL` streams via spliterator
 *   for files too large to slurp.
 */

import { readFileSync, writeFileSync } from "node:fs"

import { TextSpliterator } from "spliterator"

/** Read an entire JSONL file into memory. Blank and whitespace-only lines are skipped. */
export function readJSONL<T>(path: string): T[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as T)
}

/** Write rows as JSONL (one `JSON.stringify` per line, trailing newline). Returns the row count. */
export function writeJSONL(path: string, rows: Iterable<unknown>): number {
	let count = 0
	let out = ""

	for (const row of rows) {
		out += JSON.stringify(row) + "\n"
		count++
	}
	writeFileSync(path, out, "utf8")

	return count
}

/** Stream a JSONL file row-by-row without loading it whole. Blank lines are skipped. */
export async function* iterateJSONL<T>(path: string): AsyncIterable<T> {
	for await (const line of TextSpliterator.fromAsync(path)) {
		if (!line.trim()) continue
		yield JSON.parse(line) as T
	}
}
```

Add to `core/utils/index.ts` after the `python-random` line: `export * from "./jsonl.ts"`

- [ ] **Step 4: Run it** — same command → PASS.

- [ ] **Step 5: Commit** — `git add core/utils/jsonl.ts core/utils/jsonl.test.ts core/utils/index.ts && git commit -m "feat(core): readJSONL/writeJSONL/iterateJSONL — canonical JSONL helpers"`

---

### Task 2: `core/utils/stats.ts`

**Files:**

- Create: `core/utils/stats.ts`, `core/utils/stats.test.ts`
- Modify: `core/utils/index.ts`

**Interfaces:**

- Produces: `percentile(xs: readonly number[], p: number): number | null`, `median(xs: readonly number[]): number | null`, `formatPercent(numerator: number, denominator: number, digits?: number): string`

- [ ] **Step 1: Failing test** (`core/utils/stats.test.ts`)

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { formatPercent, median, percentile } from "./stats.ts"

describe("stats", () => {
	it("percentile matches the gate scripts' nearest-rank shape", () => {
		// The exact copy migrated from oa-resolver-eval/resolver-eval — Phase 5 gate parity
		// depends on THIS semantics: sort ascending, index = floor(p/100 * n), clamped.
		const xs = [10, 1, 5, 3, 8]
		expect(percentile(xs, 50)).toBe(5)
		expect(percentile(xs, 90)).toBe(10)
		expect(percentile(xs, 0)).toBe(1)
		expect(percentile(xs, 100)).toBe(10)
		expect(percentile([], 50)).toBeNull()
		expect(xs).toEqual([10, 1, 5, 3, 8]) // input not mutated
	})

	it("median is percentile(50)", () => {
		expect(median([3, 1, 2])).toBe(2)
		expect(median([])).toBeNull()
	})

	it("formatPercent renders k/n with digits and an em-dash on zero denominator", () => {
		expect(formatPercent(1, 8)).toBe("12.5%")
		expect(formatPercent(1, 3, 2)).toBe("33.33%")
		expect(formatPercent(0, 0)).toBe("—")
	})
})
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** (`core/utils/stats.ts`)

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Small stats helpers — the canonical home for the `percentile`/`median` copies (~15) and the
 *   `pct` percentage-format lambdas (~40) the 2026-07-09 dedupe survey found across eval scripts.
 *
 *   `percentile` is byte-for-byte the gate scripts' nearest-rank implementation
 *   (oa-resolver-eval.ts / resolver-eval.ts) — Phase 5 gate parity depends on this exact semantics;
 *   do not "upgrade" it to linear interpolation.
 */

/** Nearest-rank percentile over an unsorted sample; `null` on an empty sample. `p` in [0, 100]. */
export function percentile(xs: readonly number[], p: number): number | null {
	if (xs.length === 0) return null
	const s = [...xs].sort((a, b) => a - b)

	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}

/** `percentile(xs, 50)`. */
export function median(xs: readonly number[]): number | null {
	return percentile(xs, 50)
}

/** Format `numerator / denominator` as a fixed-digit percentage (`"12.5%"`); `"—"` when `denominator` is 0. */
export function formatPercent(numerator: number, denominator: number, digits = 1): string {
	if (denominator === 0) return "—"

	return ((100 * numerator) / denominator).toFixed(digits) + "%"
}
```

Add `export * from "./stats.ts"` to `core/utils/index.ts`.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -m "feat(core): percentile/median/formatPercent — canonical stats helpers (gate-parity semantics)"`

---

### Task 3: `core/utils/hash.ts`

**Files:**

- Create: `core/utils/hash.ts`, `core/utils/hash.test.ts`
- Modify: `core/utils/index.ts`

**Interfaces:**

- Produces: `sha256File(path: string): Promise<string>`, `sha256Hex(data: string | NodeJS.ArrayBufferView): string`

- [ ] **Step 1: Failing test** (`core/utils/hash.test.ts`)

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { sha256File, sha256Hex } from "./hash.ts"

// echo -n "mailwoman" | sha256sum
const MAILWOMAN_SHA256 = "0a4370674a5c1c573036f8f9d3fe864ee9c7bd1fbba31857c7a913b6ca4e5e39"

describe("hash", () => {
	it("sha256Hex hashes a string", () => {
		expect(sha256Hex("mailwoman")).toBe(MAILWOMAN_SHA256)
	})

	it("sha256File streams a file to the same digest", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "hash-")), "f.txt")
		writeFileSync(path, "mailwoman")
		expect(await sha256File(path)).toBe(MAILWOMAN_SHA256)
	})
})
```

(Compute the real constant with `echo -n "mailwoman" | sha256sum` before writing the test and paste the actual value — the one above is a placeholder to be REPLACED at implementation time.)

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** (`core/utils/hash.ts`)

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   File/content hashing — the canonical home for the ~12 `sha256OfFile` clones the 2026-07-09
 *   dedupe survey found across the corpus fetch scripts.
 */

import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"

/** Streaming SHA-256 of a file, hex-encoded. */
export async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256")

	for await (const chunk of createReadStream(path)) {
		hash.update(chunk as Buffer)
	}

	return hash.digest("hex")
}

/** SHA-256 of in-memory content, hex-encoded. */
export function sha256Hex(data: string | NodeJS.ArrayBufferView): string {
	return createHash("sha256").update(data).digest("hex")
}
```

Add `export * from "./hash.ts"` to `core/utils/index.ts`.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -m "feat(core): sha256File/sha256Hex — canonical hashing helpers"`

---

### Task 4: `mailwoman/cli-kit` (move + hook + CheckList + shim + exports)

**Files:**

- Create: `mailwoman/cli-kit/index.ts` (absorbs `sdk/cli.ts` types; adds `useCommandTask`, `CheckList`)
- Modify: `mailwoman/sdk/cli.ts` → one-line deprecated shim
- Modify: `mailwoman/package.json` (both exports maps: add `./cli-kit`)
- Modify: 51 importers — `sed` `sdk/cli.ts` → `cli-kit/index.ts` (same directory depth, pure string swap)
- Modify: `mailwoman/commands/gazetteer/verify.tsx` (retrofit as the hook's proof)
- Modify: `AGENTS.md` (root — one line: `sdk/` submodules = data acquisition)

**Interfaces:**

- Produces:
  - `CommandComponent<O, P?>` / `PositionalCommandComponent<T>` / `CommandProps<O, P?>` (moved unchanged)
  - `type CommandTaskState<T> = { status: "running" } | { status: "done"; result: T } | { status: "error"; message: string }`
  - `useCommandTask<T>(task: () => Promise<T>, exitCode?: (result: T) => number): CommandTaskState<T>`
  - `interface Check { ok: boolean; check: string; detail?: string }` + `CheckList({ checks, verdict? }): React.ReactElement`

- [ ] **Step 1: Create `mailwoman/cli-kit/index.ts`** — the existing `sdk/cli.ts` content (license header + the three type helpers, verbatim) followed by:

```ts
import { Box, Text } from "ink"
import { createElement as h, useEffect, useState } from "react"

/** The lifecycle of a command's one-shot async task. */
export type CommandTaskState<T> =
	{ status: "running" } | { status: "done"; result: T } | { status: "error"; message: string }

/**
 * Run a command's one-shot async task and own the exit-code discipline: rejection renders the error
 * and exits 1; resolution exits with `exitCode(result)` (default 0), always AFTER the final frame
 * committed. Replaces the copy-pasted useEffect/useState/setImmediate dance in every command.
 */
export function useCommandTask<T>(task: () => Promise<T>, exitCode?: (result: T) => number): CommandTaskState<T> {
	const [state, setState] = useState<CommandTaskState<T>>({ status: "running" })

	// One-shot by design: the task closure captures its options at mount, so deps stay empty.
	useEffect(() => {
		void task().then(
			(result) => setState({ status: "done", result }),
			(error: unknown) =>
				setState({ status: "error", message: error instanceof Error ? (error.stack ?? error.message) : String(error) })
		)
	}, [])

	useEffect(() => {
		if (state.status === "running") return
		const code = state.status === "error" ? 1 : (exitCode?.(state.result) ?? 0)
		setImmediate(() => process.exit(code))
	}, [state])

	return state
}

/** One ✓/✗ line in a {@linkcode CheckList}. */
export interface Check {
	ok: boolean
	check: string
	detail?: string
}

/**
 * The ✓/✗ check-list + PASS/FAIL renderer (extracted from `gazetteer verify`). Built with
 * `createElement`, not JSX, so this module stays plain `.ts` — importable under node's type
 * stripping (the dev `node →` exports condition).
 */
export function CheckList({ checks, verdict }: { checks: readonly Check[]; verdict?: boolean }): React.ReactElement {
	const lines = checks.map((c, i) =>
		h(
			Text,
			{ key: i, color: c.ok ? "green" : "red" },
			`${c.ok ? "✓" : "✗"} ${c.check}${c.detail ? `: ${c.detail}` : ""}`
		)
	)
	const summary =
		verdict === undefined
			? null
			: h(
					Text,
					{ color: verdict ? "green" : "red" },
					`${verdict ? "PASS" : "FAIL"} (${checks.filter((c) => c.ok).length}/${checks.length} checks)`
				)

	return h(Box, { flexDirection: "column" }, ...lines, summary)
}
```

- [ ] **Step 2: Shim `mailwoman/sdk/cli.ts`** (replace entire body below the license header):

```ts
/**
 * @deprecated Moved to `mailwoman/cli-kit` (`./cli-kit` subpath) — `sdk/` submodules mean data
 *   acquisition. This shim keeps the published `./sdk/cli` subpath alive; remove at the next major
 *   (bundle with the #875 batch).
 */
export * from "../cli-kit/index.ts"
```

- [ ] **Step 3: Exports maps** — in `mailwoman/package.json` add to `exports`:

```json
"./cli-kit": {
	"node": "./cli-kit/index.ts",
	"default": "./out/cli-kit/index.js",
	"types": "./out/cli-kit/index.d.ts"
}
```

and to `publishConfig.exports`:

```json
"./cli-kit": {
	"types": "./out/cli-kit/index.d.ts",
	"default": "./out/cli-kit/index.js"
}
```

- [ ] **Step 4: Repoint the 51 importers**

```bash
grep -rl 'sdk/cli.ts' mailwoman --include='*.tsx' --include='*.ts' | grep -v /out/ | grep -v sdk/cli.ts | xargs perl -pi -e 's{sdk/cli\.ts}{cli-kit/index.ts}g'
```

- [ ] **Step 5: Retrofit `gazetteer/verify.tsx`** — replace the two useState + two useEffect blocks with:

```tsx
const GazetteerVerify: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const dbPath = options.db ?? join(wofDir(), "admin-global-priority.db")
			console.error(`Verifying ${dbPath}...`)
			const db = new DatabaseSync(dbPath, { readOnly: true })
			const structural = verifyAdmin(db, loadDefaultBaseline())
			db.close()
			const checks = [...structural.checks]
			let ok = structural.ok

			if (options.reversePanel) {
				const reverse = await verifyReversePanel(dbPath)
				checks.push(...reverse.checks)
				ok = ok && reverse.ok
			}

			return { ok, checks }
		},
		(result) => (result.ok ? 0 : 1)
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <CheckList checks={state.result.checks} verdict={state.result.ok} />

	return null
}
```

(imports become `import { type CommandComponent, CheckList, useCommandTask } from "../../cli-kit/index.ts"`; drop the now-unused `Box`/`useEffect`/`useState` imports.)

- [ ] **Step 6: AGENTS.md** — add to the "Workspace + test conventions" bullet list: `- **\`sdk/\` submodules mean data acquisition\*\* (fetch/extract/shard-provider — see \`ban/sdk\`, \`osm/sdk\`, \`tiger/sdk\`). CLI helpers live in \`mailwoman/cli-kit/\`, the parser test harness in \`mailwoman/test-kit/\` — do not grow a new \`sdk/cli\`.`

- [ ] **Step 7: Verify** — `yarn compile` clean; `node mailwoman/out/cli.js gazetteer verify --help` prints usage exit 0; `grep -rn 'sdk/cli' mailwoman --include='*.tsx' | grep -v out/` → only the shim.

- [ ] **Step 8: Commit** — `git commit -m "feat(cli-kit): extract mailwoman/sdk/cli → cli-kit with useCommandTask + CheckList (sdk = data acquisition)"`

---

### Task 5: `mailwoman/test-kit` (move + shim + exports)

**Files:**

- Create: `mailwoman/test-kit/index.ts` (the current `sdk/test/index.ts` content, unchanged)
- Modify: `mailwoman/sdk/test/index.ts` → deprecated shim (`export * from "../../test-kit/index.ts"` with the same `@deprecated` docstring pattern as Task 4 Step 2)
- Modify: `mailwoman/package.json` — add `./test-kit` to both maps (same shape as Task 4 Step 3, with `./test-kit/index.*` paths)
- Modify: importers — `grep -rl 'sdk/test' mailwoman/test docs --include='*.ts' | grep -v /out/` then `perl -pi -e 's{sdk/test(/index\.ts)?}{test-kit/index.ts}g'` on relative imports and `s{mailwoman/sdk/test}{mailwoman/test-kit}g` on bare specifiers (check both forms exist before running; adjust the regex to what grep shows)

- [ ] **Step 1: Move + shim + exports + repoint** (as listed above).
- [ ] **Step 2: Verify** — `yarn compile` clean; `node_modules/.bin/vitest run mailwoman/test/address.usa.test.ts` → PASS.
- [ ] **Step 3: Commit** — `git commit -m "feat(test-kit): extract mailwoman/sdk/test → test-kit (sdk = data acquisition)"`

---

### Task 6: Phase gate

- [ ] `yarn lint` → clean. `yarn compile` → clean. `yarn typecheck:scripts` → clean.
- [ ] `node_modules/.bin/vitest run core/utils mailwoman/test mailwoman/commands` → PASS.
- [ ] `node mailwoman/out/cli.js --help` and `node mailwoman/out/cli.js gazetteer verify --help` → exit 0.
- [ ] Merge branch to main (local, no push), delete branch.
