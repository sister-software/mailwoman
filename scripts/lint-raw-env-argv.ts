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
 *   is no fourth. Wired into `yarn lint`. Scans ALL .ts/.tsx sources including gitignored
 *   diagnostics (the third sweep's blind spot was `rg` honoring .gitignore).
 *
 *   Run: node scripts/lint-raw-env-argv.ts
 */

import { execFileSync } from "node:child_process"

const BLESSED = new Set([
	"core/env/index.ts",
	"core/env/schema.ts",
	"core/utils/scripting.ts",
	"scripts/lint-raw-env-argv.ts",
])

/** Generated / vendored trees the scan must skip (not source). */
const PRUNE = ["node_modules", "out", ".pi", "docs/build", "docs/.docusaurus", ".git", ".yarn"]

let listing: string
try {
	listing = execFileSync(
		"rg",
		[
			"--no-ignore",
			"--line-number",
			"--type-add",
			"src:*.{ts,tsx}",
			"--type",
			"src",
			...PRUNE.flatMap((d) => ["--glob", `!**/${d}/**`]),
			String.raw`process\.(env|argv)\b`,
			".",
		],
		{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
	)
} catch (error) {
	const status = (error as { status?: number }).status

	if (status === 1) {
		console.log("✓ no raw process.env / process.argv anywhere")
		process.exit(0)
	}
	throw error
}

const offenders = listing
	.trim()
	.split("\n")
	.filter((line) => {
		const file = line.split(":", 1)[0]!.replace(/^\.\//, "")

		return !BLESSED.has(file)
	})

if (offenders.length === 0) {
	console.log(`✓ raw process.env / process.argv confined to the blessed homes (${[...BLESSED].slice(0, 3).join(", ")})`)
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
