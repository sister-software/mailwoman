/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CLI integration tests for `mailwoman reverse <lat> <lon>` (#484).
 *
 *   Error-path tests run unconditionally against the compiled CLI (node out/cli.js). The end-to-end
 *   suite gates on both real DB env vars — same pattern as resolve-flag.test.ts and
 *   resolver-wof-sqlite/reverse.test.ts:
 *
 *   - MAILWOMAN_WOF_ADMIN_DB — admin gazetteer with place_bbox R*Tree
 *   - MAILWOMAN_WOF_POLYGONS_DB — polygon sidecar (wof-polygons.db)
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { $public } from "@mailwoman/core/env"
import { childEnv, repoRootPathBuilder } from "@mailwoman/core/utils"
import { describe, expect, test } from "vitest"

const exec = promisify(execFile)

const cliBin = String(repoRootPathBuilder("out", "cli.js"))

const ADMIN_DB = $public.MAILWOMAN_WOF_ADMIN_DB
const POLYGONS_DB = $public.MAILWOMAN_WOF_POLYGONS_DB

/** Strip ANSI escape sequences + ink spinner frames so JSON.parse can consume CLI stdout. */
function stripAnsiSpinner(stdout: string): string {
	const ansi = /\[[0-9;]*[a-zA-Z]/gu
	const cleaned = stdout.replace(ansi, "").trim()
	const objStart = cleaned.search(/[{[]/)

	return objStart >= 0 ? cleaned.slice(objStart) : cleaned
}

// ---------------------------------------------------------------------------
// Error-path tests — run unconditionally, no real DB required.
// ---------------------------------------------------------------------------

describe("mailwoman reverse — argument and DB error paths", () => {
	test("exits non-zero with a clear message when lat/lon are missing", async () => {
		// Pastel intercepts missing-positional-arg BEFORE our React component runs and writes the
		// error to stderr (not stdout). Asserting on stderr here; all other error paths go through
		// the component and land on stdout.
		await expect(
			exec("node", [cliBin, "reverse"], {
				env: childEnv({ MAILWOMAN_WOF_ADMIN_DB: "", NODE_NO_WARNINGS: "1" }),
			})
		).rejects.toMatchObject({
			stderr: expect.stringMatching(/missing required argument|requires two positional arguments/),
		})
	})

	test("exits non-zero when no admin DB is available", async () => {
		await expect(
			exec("node", [cliBin, "reverse", "40.7128", "-74.0060"], {
				env: childEnv({ MAILWOMAN_WOF_ADMIN_DB: "", NODE_NO_WARNINGS: "1" }),
			})
		).rejects.toMatchObject({
			stdout: expect.stringMatching(/needs an admin DB path/),
		})
	})

	test("exits non-zero for an out-of-range latitude", async () => {
		await expect(
			exec("node", [cliBin, "reverse", "91", "0"], {
				env: childEnv({ MAILWOMAN_WOF_ADMIN_DB: "", NODE_NO_WARNINGS: "1" }),
			})
		).rejects.toMatchObject({
			stdout: expect.stringMatching(/Invalid latitude/),
		})
	})

	test("exits non-zero for a non-numeric argument", async () => {
		await expect(
			exec("node", [cliBin, "reverse", "not-a-number", "0"], {
				env: childEnv({ MAILWOMAN_WOF_ADMIN_DB: "", NODE_NO_WARNINGS: "1" }),
			})
		).rejects.toMatchObject({
			stdout: expect.stringMatching(/Invalid latitude/),
		})
	})
})

// ---------------------------------------------------------------------------
// End-to-end tests against the real production DBs.
// ---------------------------------------------------------------------------

describe.skipIf(!ADMIN_DB || !POLYGONS_DB)(
	"mailwoman reverse — end-to-end against MAILWOMAN_WOF_ADMIN_DB + MAILWOMAN_WOF_POLYGONS_DB",
	() => {
		const ENV = childEnv({
			MAILWOMAN_WOF_ADMIN_DB: ADMIN_DB!,
			MAILWOMAN_WOF_POLYGONS_DB: POLYGONS_DB!,
			NODE_NO_WARNINGS: "1",
		})

		test("New York City (40.7128, -74.0060) → JSON hierarchy contains New York + United States", async () => {
			const result = await exec("node", [cliBin, "reverse", "40.7128", "-74.0060"], {
				env: ENV,
				maxBuffer: 4 * 1024 * 1024,
			})
			const json = JSON.parse(stripAnsiSpinner(result.stdout)) as {
				lat: number
				lon: number
				containment: string
				hierarchy: Array<{ id: number; name: string; placetype: string; country: string }>
			}
			expect(json.lat).toBe(40.7128)
			expect(json.lon).toBe(-74.006)
			expect(["polygon", "approximate"]).toContain(json.containment)
			const names = json.hierarchy.map((p) => p.name)
			expect(names).toContain("United States")
			// The hierarchy must reach at least the region (New York state).
			const placetypes = json.hierarchy.map((p) => p.placetype)
			expect(placetypes).toContain("region")
		}, 60_000)

		test("--admin-db flag overrides env var (same result)", async () => {
			const result = await exec(
				"node",
				[cliBin, "reverse", "40.7128", "-74.0060", "--admin-db", ADMIN_DB!, "--polygons-db", POLYGONS_DB!],
				{ env: childEnv({ MAILWOMAN_WOF_ADMIN_DB: "", NODE_NO_WARNINGS: "1" }), maxBuffer: 4 * 1024 * 1024 }
			)
			const json = JSON.parse(stripAnsiSpinner(result.stdout)) as { hierarchy: Array<{ name: string }> }
			const names = json.hierarchy.map((p) => p.name)
			expect(names).toContain("United States")
		}, 60_000)

		test("--format text emits human-readable hierarchy without JSON wrapper", async () => {
			const result = await exec("node", [cliBin, "reverse", "40.7128", "-74.0060", "--format", "text"], {
				env: ENV,
				maxBuffer: 4 * 1024 * 1024,
			})
			const out = result.stdout
			expect(out).toMatch(/containment:/)
			expect(out).toMatch(/wof:\d+/)
			expect(out).not.toMatch(/^\s*\{/u) // not JSON
		}, 60_000)

		test("open ocean (40.0, -40.0) → empty hierarchy, exit 0", async () => {
			const result = await exec("node", [cliBin, "reverse", "40.0", "-40.0"], {
				env: ENV,
				maxBuffer: 4 * 1024 * 1024,
			})
			const json = JSON.parse(stripAnsiSpinner(result.stdout)) as { hierarchy: unknown[] }
			expect(json.hierarchy).toEqual([])
		}, 60_000)

		test("centroid-only mode (no polygon DB) returns approximate containment", async () => {
			// Deliberately strip the polygons DB — every result must be approximate.
			const result = await exec("node", [cliBin, "reverse", "40.7128", "-74.0060"], {
				env: { ...ENV, MAILWOMAN_WOF_POLYGONS_DB: "" },
				maxBuffer: 4 * 1024 * 1024,
			})
			const json = JSON.parse(stripAnsiSpinner(result.stdout)) as {
				containment: string
				hierarchy: Array<{ name: string }>
			}
			expect(json.containment).toBe("approximate")
			expect(json.hierarchy.map((p) => p.name)).toContain("United States")
		}, 60_000)
	}
)
