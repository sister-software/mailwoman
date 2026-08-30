/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A ceiling on how much of the repo `mailwoman --version` is allowed to load.
 *
 *   `--version` must stay inside the small launcher/router graph. Command implementations and their UI, model, database,
 *   and data-pipeline dependencies are selected only after dispatch.
 *
 *   The counter is `module.registerHooks()`, which sees ESM and CJS alike, injected as a `data:` URL so the guard
 *   needs no committed helper. It runs against the COMPILED CLI (`out/cli.js`) because that is what ships and what
 *   the bin points at; the suite skips when the tree has not been built.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { workspacePath, repoRootPath } from "@mailwoman/core/utils"
import { execFile } from "@mailwoman/platform/child_process"
import { promisify } from "@mailwoman/platform/util"
import { describe, expect, test } from "vitest"

const exec = promisify(execFile)

const cliBin = workspacePath("mailwoman", "out", "cli.js")

/**
 * Current whole-process module count for `mailwoman --version`.
 */
const MEASURED_MODULE_COUNT = 36

/**
 * The ceiling allows launcher changes while rejecting a command or UI graph entering the version path.
 */
const MODULE_COUNT_CEILING = 100

/**
 * `registerHooks` covers ESM and CJS. `node:` builtins are excluded — they are resident before the CLI starts and
 * counting them would make the number depend on the Node version rather than on this repo.
 */
const COUNTING_HOOK =
	"data:text/javascript," +
	encodeURIComponent(
		[
			'const { registerHooks } = process.getBuiltinModule("node:module")',
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

describe.skipIf(!(await pathExists(cliBin)))("mailwoman --version module graph", () => {
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
			`\`mailwoman --version\` now loads ${loaded} modules (baseline ${MEASURED_MODULE_COUNT}). ` +
				"Keep command and UI implementations behind the selected route's dynamic import."
		).toBeLessThan(MODULE_COUNT_CEILING)
	}, 60_000)
})
