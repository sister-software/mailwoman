/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Type-check every workspace's test files.
 *
 *   `tsc -b` deliberately skips them: the build project excludes tests because anything it includes is
 *   emitted into `out/` and then published. That `exclude` suppressed the emit AND the checking, so for
 *   most of this repo's life test files were compiled by vitest's esbuild transform, which strips types
 *   without looking at them.
 *
 *   Each workspace now carries a `tsconfig.test.json` — non-emitting, referencing its own build project
 *   so siblings resolve through their built `.d.ts`. This runs them all and reports per workspace.
 */

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { cpus } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { repoRootPath } from "@mailwoman/core/utils"

const run = promisify(execFile)

/** How many `tsc` invocations to keep in flight. Each is single-threaded and mostly CPU-bound. */
const CONCURRENCY = Math.max(2, Math.min(8, cpus().length - 2))

/** One workspace's result: its name, and the diagnostic lines `tsc` produced. */
interface Result {
	workspace: string
	errors: string[]
}

/**
 * Run `tsc` against one workspace's test project. A non-zero exit carries the diagnostics on stdout, so a rejected
 * promise is the normal path for a workspace with errors.
 */
async function check(workspace: string, repoRoot: string): Promise<Result> {
	const config = join(workspace, "tsconfig.test.json")

	try {
		await run("./node_modules/.bin/tsc", ["-p", config, "--noEmit", "--pretty", "false"], { cwd: repoRoot })

		return { workspace, errors: [] }
	} catch (error) {
		const output = String((error as { stdout?: string }).stdout ?? "")

		return { workspace, errors: output.split("\n").filter((line) => line.includes("error TS")) }
	}
}

const repoRoot = String(repoRootPath())
const entries = await readdir(repoRoot, { withFileTypes: true })
const workspaces = entries
	.filter((entry) => entry.isDirectory() && existsSync(join(repoRoot, entry.name, "tsconfig.test.json")))
	.map((entry) => entry.name)
	.toSorted()

const results: Result[] = []
const queue = [...workspaces]

await Promise.all(
	Array.from({ length: CONCURRENCY }, async () => {
		for (let next = queue.shift(); next; next = queue.shift()) {
			results.push(await check(next, repoRoot))
		}
	})
)

const failed = results.filter((r) => r.errors.length).toSorted((a, b) => b.errors.length - a.errors.length)
const total = failed.reduce((sum, r) => sum + r.errors.length, 0)

for (const { workspace, errors } of failed) {
	console.error(`\n═══ ${workspace} — ${errors.length} error${errors.length === 1 ? "" : "s"}`)

	for (const line of errors) {
		console.error(`  ${line}`)
	}
}

console.error(`\n${total} type error${total === 1 ? "" : "s"} across ${workspaces.length} workspaces' tests.`)

if (total) {
	process.exitCode = 1
}
