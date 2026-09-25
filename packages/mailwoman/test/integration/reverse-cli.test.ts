import { parseJSONStrict } from "@mailwoman/core/json"
import { runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { mailwomanCLIPath } from "mailwoman/cli-kit/metadata"
import { $public } from "mailwoman/env"
import { describe, expect, test } from "vitest"

const cliBin = await mailwomanCLIPath()

const ADMIN_DB = $public.MAILWOMAN_WOF_ADMIN_DB
const POLYGONS_DB = $public.MAILWOMAN_WOF_POLYGONS_DB

function stripAnsiSpinner(stdout: string): string {
	const ansi = /\[[0-9;]*[a-zA-Z]/gu
	const cleaned = stdout.replace(ansi, "").trim()
	const objStart = cleaned.search(/[{[]/)

	return objStart >= 0 ? cleaned.slice(objStart) : cleaned
}

describe("mailwoman reverse — argument and DB error paths", () => {
	test("exits non-zero with a clear message when lat/lon are missing", async () => {
		await expect(
			runFile("node", [cliBin, "reverse"], {
				env: childEnv({ MAILWOMAN_WOF_ADMIN_DB: "", NODE_NO_WARNINGS: "1" }),
			})
		).rejects.toMatchObject({
			stderr: expect.stringMatching(/missing required argument|requires two positional arguments/),
		})
	})

	test("exits non-zero when no admin DB is available", async () => {
		await expect(
			runFile("node", [cliBin, "reverse", "40.7128", "-74.0060"], {
				env: childEnv({ MAILWOMAN_WOF_ADMIN_DB: "", NODE_NO_WARNINGS: "1" }),
			})
		).rejects.toMatchObject({ stderr: expect.stringMatching(/needs an admin DB path/) })
	})

	test("exits non-zero for an out-of-range latitude", async () => {
		await expect(
			runFile("node", [cliBin, "reverse", "91", "0"], {
				env: childEnv({ MAILWOMAN_WOF_ADMIN_DB: "", NODE_NO_WARNINGS: "1" }),
			})
		).rejects.toMatchObject({ stderr: expect.stringMatching(/Invalid latitude/) })
	})

	test("exits non-zero for a non-numeric argument", async () => {
		await expect(
			runFile("node", [cliBin, "reverse", "not-a-number", "0"], {
				env: childEnv({ MAILWOMAN_WOF_ADMIN_DB: "", NODE_NO_WARNINGS: "1" }),
			})
		).rejects.toMatchObject({ stderr: expect.stringMatching(/Invalid latitude/) })
	})
})

describe.skipIf(!ADMIN_DB || !POLYGONS_DB)(
	"mailwoman reverse — end-to-end against MAILWOMAN_WOF_ADMIN_DB + MAILWOMAN_WOF_POLYGONS_DB",
	() => {
		const ENV = childEnv({
			MAILWOMAN_WOF_ADMIN_DB: ADMIN_DB!,
			MAILWOMAN_WOF_POLYGONS_DB: POLYGONS_DB!,
			NODE_NO_WARNINGS: "1",
		})

		test("New York City (40.7128, -74.0060) → JSON hierarchy contains New York + United States", async () => {
			const result = await runFile("node", [cliBin, "reverse", "40.7128", "-74.0060"], {
				env: ENV,
				maxBuffer: 4 * 1024 * 1024,
			})

			const json = parseJSONStrict<{
				lat: number
				lon: number
				containment: string
				hierarchy: Array<{ id: number; name: string; placetype: string; country: string }>
				engine: { name: string; license: string; licensee?: string }
			}>(stripAnsiSpinner(result.stdout))

			expect(json.engine.name).toBe("mailwoman")
			expect(json.engine.license).toMatch(/^(AGPL-3\.0-only|LicenseRef-Commercial)$/u)
			expect(json.engine).not.toHaveProperty("licensee")
			expect(json.lat).toBe(40.7128)
			expect(json.lon).toBe(-74.006)
			expect(["polygon", "approximate"]).toContain(json.containment)
			const names = json.hierarchy.map((p) => p.name)
			expect(names).toContain("United States")

			const placetypes = json.hierarchy.map((p) => p.placetype)
			expect(placetypes).toContain("region")
		}, 60_000)

		test("--admin-db flag overrides env var (same result)", async () => {
			const result = await runFile(
				"node",
				[cliBin, "reverse", "40.7128", "-74.0060", "--admin-db", ADMIN_DB!, "--polygons-db", POLYGONS_DB!],
				{ env: childEnv({ MAILWOMAN_WOF_ADMIN_DB: "", NODE_NO_WARNINGS: "1" }), maxBuffer: 4 * 1024 * 1024 }
			)

			const json = parseJSONStrict<{ hierarchy: Array<{ name: string }> }>(stripAnsiSpinner(result.stdout))
			const names = json.hierarchy.map((p) => p.name)
			expect(names).toContain("United States")
		}, 60_000)

		test("--format text emits human-readable hierarchy without JSON wrapper", async () => {
			const result = await runFile("node", [cliBin, "reverse", "40.7128", "-74.0060", "--format", "text"], {
				env: ENV,
				maxBuffer: 4 * 1024 * 1024,
			})

			const out = result.stdout
			expect(out).toMatch(/containment:/)
			expect(out).toMatch(/wof:\d+/)
			expect(out).not.toMatch(/^\s*\{/u)
		}, 60_000)

		test("Open ocean (40.0, -40.0) → empty hierarchy, exit 0", async () => {
			const result = await runFile("node", [cliBin, "reverse", "40.0", "-40.0"], {
				env: ENV,
				maxBuffer: 4 * 1024 * 1024,
			})

			const json = parseJSONStrict<{ hierarchy: unknown[] }>(stripAnsiSpinner(result.stdout))
			expect(json.hierarchy).toEqual([])
		}, 60_000)

		test("centroid-only mode (no polygon DB) returns approximate containment", async () => {
			const result = await runFile("node", [cliBin, "reverse", "40.7128", "-74.0060"], {
				env: { ...ENV, MAILWOMAN_WOF_POLYGONS_DB: "" },
				maxBuffer: 4 * 1024 * 1024,
			})

			const json = parseJSONStrict<{
				containment: string
				hierarchy: Array<{ name: string }>
			}>(stripAnsiSpinner(result.stdout))

			expect(json.containment).toBe("approximate")
			expect(json.hierarchy.map((p) => p.name)).toContain("United States")
		}, 60_000)
	}
)
