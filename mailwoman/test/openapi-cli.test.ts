/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CLI integration test for `mailwoman openapi` (Phase 5 Task 2). Runs the compiled CLI
 *   (`out/cli.js` — the standing "use the compiled CLI" rule) against a stub `createMailwomanAPI({})`
 *   engine: no model, no gazetteer, no data-root env required. The per-package `/openapi.json` tests
 *   (`api/index.test.ts`) already pin the document's content in depth; this test only pins the CLI
 *   wiring itself — that the command exists, prints a real v3.1.0 document to stdout with zero
 *   preamble, and that `--flavor 3.0` switches the diet.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { childEnv } from "@mailwoman/core/scripting/utils"
import { repoRootPath } from "@mailwoman/core/utils"
import { describe, expect, test } from "vitest"

const exec = promisify(execFile)

const cliBin = repoRootPath("mailwoman", "out", "cli.js")

describe("mailwoman openapi", () => {
	test('prints a document starting exactly with {"openapi":"3.1.0" (default flavor, stdout, no model boot)', async () => {
		const { stdout, stderr } = await exec("node", [cliBin, "openapi"], {
			env: childEnv({ NODE_NO_WARNINGS: "1" }),
			maxBuffer: 4 * 1024 * 1024,
		})

		expect(stdout.startsWith('{"openapi":"3.1.0"')).toBe(true)
		expect(stderr).toBe("")

		const doc = JSON.parse(stdout) as { openapi: string; paths: Record<string, unknown> }
		expect(doc.openapi).toBe("3.1.0")
		expect(Object.keys(doc.paths)).toEqual(
			expect.arrayContaining(["/v1/parse", "/v1/geocode", "/v1/batch", "/v1/resolve", "/v1/format"])
		)
	}, 30_000)

	test("--flavor 3.0 prints the 3.0.3 diet", async () => {
		const { stdout } = await exec("node", [cliBin, "openapi", "--flavor", "3.0"], {
			env: childEnv({ NODE_NO_WARNINGS: "1" }),
			maxBuffer: 4 * 1024 * 1024,
		})
		const doc = JSON.parse(stdout) as { openapi: string }
		expect(doc.openapi).toBe("3.0.3")
	}, 30_000)
})
