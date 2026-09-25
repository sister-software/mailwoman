import { parseJSONStrict } from "@mailwoman/core/json"
import { runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { mailwomanCLIPath } from "mailwoman/cli-kit/metadata"
import { describe, expect, test } from "vitest"

const cliBin = await mailwomanCLIPath()

describe("mailwoman openapi", () => {
	test('Prints a document starting exactly with {"openapi":"3.1.0" (default flavor, stdout without model boot)', async () => {
		const { stdout, stderr } = await runFile("node", [cliBin, "openapi"], {
			env: childEnv({ NODE_NO_WARNINGS: "1" }),
			maxBuffer: 4 * 1024 * 1024,
		})

		expect(stdout.startsWith('{"openapi":"3.1.0"')).toBe(true)

		expect(stderr).toMatch(/^mailwoman is licensed [^\n]*\nA commercial license waives that obligation: [^\n]*\n$/u)

		const doc = parseJSONStrict<{ openapi: string; paths: Record<string, unknown> }>(stdout)
		expect(doc.openapi).toBe("3.1.0")

		expect(Object.keys(doc.paths)).toEqual(
			expect.arrayContaining(["/v1/parse", "/v1/geocode", "/v1/batch", "/v1/resolve", "/v1/format"])
		)
	}, 30_000)

	test("--flavor 3.0 prints the 3.0.3 diet", async () => {
		const { stdout } = await runFile("node", [cliBin, "openapi", "--flavor", "3.0"], {
			env: childEnv({ NODE_NO_WARNINGS: "1" }),
			maxBuffer: 4 * 1024 * 1024,
		})

		const doc = parseJSONStrict<{ openapi: string }>(stdout)
		expect(doc.openapi).toBe("3.0.3")
	}, 30_000)
})
