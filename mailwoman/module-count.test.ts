/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A ceiling on how much of the repo `mailwoman --version` is allowed to load.
 *
 *   Pastel `await import()`s all 139 command modules before commander parses a single argument, so a command's
 *   top-level imports are on EVERY invocation's critical path — including one that only prints a version string. That
 *   is how the CLI came to load onnxruntime, the SentencePiece WASM blob, the AWS S3 client, a Parquet/Thrift stack,
 *   kysely and axios to answer `--version`: 2,712 modules, 16.11 MB of source compiled, 1.36 s. Pushing those imports
 *   into the commands' task bodies took it to 987 modules and 0.47 s.
 *
 *   Nothing about that is self-sustaining. One `import { … } from "@mailwoman/corpus/tools"` added to the top of one
 *   command module puts the whole AWS SDK back, and the only symptom is that every invocation gets slower — no test
 *   fails, no output changes. This is that test. The ceiling is deliberately loose (~20% headroom over the measured
 *   count) because it is guarding against a step change of hundreds, not policing drift of ten; a failure here means
 *   "something heavy went back to a module's top level", and the fix is a dynamic `import()` inside the task body,
 *   not a bigger number here.
 *
 *   The counter is `module.registerHooks()`, which sees ESM and CJS alike, injected as a `data:` URL so the guard
 *   needs no committed helper. It runs against the COMPILED CLI (`out/cli.js`) because that is what ships and what
 *   the bin points at; the suite skips when the tree has not been built.
 */

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { promisify } from "node:util"

import { childEnv } from "@mailwoman/core/scripting/utils"
import { repoRootPath } from "@mailwoman/core/utils"
import { describe, expect, test } from "vitest"

const exec = promisify(execFile)

const cliBin = repoRootPath("mailwoman", "out", "cli.js")

/**
 * Measured 2026-08-13 for `mailwoman --version`: 987 modules, 3.54 MB of source. Named so a failure reads as a
 * regression against a real number rather than against a round one.
 */
const MEASURED_MODULE_COUNT = 987

/**
 * The ceiling. Between it and {@link MEASURED_MODULE_COUNT} is room for a genuinely new command; below it is every
 * heavy leaf the lazy-import sweep removed, each of which is worth hundreds on its own.
 */
const MODULE_COUNT_CEILING = 1200

/**
 * `registerHooks` covers ESM and CJS. `node:` builtins are excluded — they are resident before the CLI starts and
 * counting them would make the number depend on the Node version rather than on this repo.
 */
const COUNTING_HOOK =
	"data:text/javascript," +
	encodeURIComponent(
		[
			'import { registerHooks } from "node:module"',
			"let loaded = 0",
			"registerHooks({",
			"	load(url, context, nextLoad) {",
			'		if (!url.startsWith("node:")) loaded++',
			"		return nextLoad(url, context)",
			"	},",
			"})",
			'process.on("exit", () => process.stderr.write(`MW_MODULE_COUNT=${loaded}\\n`))',
		].join("\n")
	)

describe.skipIf(!existsSync(cliBin))("mailwoman --version module graph", () => {
	test(`loads fewer than ${MODULE_COUNT_CEILING} modules`, async () => {
		const { stdout, stderr } = await exec(process.execPath, ["--import", COUNTING_HOOK, cliBin, "--version"], {
			cwd: repoRootPath(),
			env: childEnv(),
		})

		expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u)

		const reported = /MW_MODULE_COUNT=(\d+)/u.exec(stderr)

		expect(reported, `counter never reported; stderr was:\n${stderr}`).not.toBeNull()

		const loaded = Number(reported![1])

		expect(
			loaded,
			`\`mailwoman --version\` now loads ${loaded} modules (was ${MEASURED_MODULE_COUNT}). Something heavy is ` +
				"imported at the top level of a command module — Pastel imports all 139 of them before argv is parsed. " +
				'Move it inside the command\'s task body: `const { … } = await import("…")`.'
		).toBeLessThan(MODULE_COUNT_CEILING)
	}, 60_000)
})
