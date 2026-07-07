/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Enforce the zero-raw-access rule: `process.env` and `process.argv` may appear ONLY in their
 *   blessed homes — `core/env/` (the `$public`/`$private` implementation) and
 *   `core/utils/scripting.ts` (`cliArguments`, `childEnv`, `scriptEntryPath`, `runIfScript`).
 *   Everywhere else: read config through `$public`/`$private`, parse arguments with `node:util`
 *   `parseArgs` (its default IS `process.argv.slice(2)` — don't pass `args:` yourself), build child
 *   environments with `childEnv()`, and stub env in tests with `vi.stubEnv`.
 *
 *   Ran that gauntlet three times by hand in one week (2026-07-07/08); this script exists so there
 *   is no fourth. Wired into `yarn lint` + the Test workflow. Pure-Node walk (CI has no ripgrep)
 *   over ALL .ts/.tsx sources including gitignored diagnostics (the third sweep's blind spot was
 *   the search tooling honoring .gitignore).
 *
 *   Run: node scripts/lint-raw-env-argv.ts
 */

import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

const ROOT = new URL("..", import.meta.url).pathname

const BLESSED = new Set([
	"core/env/index.ts",
	"core/env/schema.ts",
	"core/utils/scripting.ts",
	"scripts/lint-raw-env-argv.ts",
])

/** Generated / vendored directory names the walk must skip (not source). */
const PRUNE = new Set(["node_modules", "out", ".pi", "build", ".docusaurus", ".git", ".yarn", "__pycache__"])

const PATTERN = /process\.(env|argv)\b/

const offenders: string[] = []

function walk(dir: string): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			// Hidden dirs (.claude worktrees, .git, .yarn, …) are never source.
			if (!PRUNE.has(entry.name) && !entry.name.startsWith(".")) walk(join(dir, entry.name))
			continue
		}

		if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue
		const path = join(dir, entry.name)
		const rel = relative(ROOT, path)

		if (BLESSED.has(rel)) continue
		const lines = readFileSync(path, "utf8").split("\n")

		for (const [i, line] of lines.entries()) {
			if (PATTERN.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`)
		}
	}
}

walk(ROOT)

if (offenders.length === 0) {
	console.log("✓ raw process.env / process.argv confined to the blessed homes (core/env, core/utils/scripting.ts)")
	process.exit(0)
}

console.error(`✗ raw process.env / process.argv outside the blessed homes (${offenders.length}):\n`)

for (const line of offenders) {
	console.error(`  ${line}`)
}
console.error(
	"\nUse $public/$private (@mailwoman/core/env), parseArgs (node:util — no `args:` line needed)," +
		"\ncliArguments()/childEnv()/scriptEntryPath()/runIfScript (@mailwoman/core/utils), or vi.stubEnv in tests."
)
process.exit(1)
