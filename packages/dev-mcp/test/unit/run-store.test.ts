/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { getRun, listRuns, pruneRuns, putRun, RETENTION_DAYS } from "@mailwoman/dev-mcp/run-store"
import type { StoredRun } from "@mailwoman/dev-mcp/run-store"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "@mailwoman/platform/fs"
import { tmpdir } from "@mailwoman/platform/os"
import { join } from "@mailwoman/platform/path"
import { afterAll, describe, expect, it } from "vitest"

const dirs: string[] = []

function store(): string {
	const dir = mkdtempSync(join(tmpdir(), "mwdev-runs-"))

	dirs.push(dir)

	return dir
}

const NOW = new Date("2026-08-17T00:00:00.000Z")

function daysAgo(days: number): string {
	return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
}

function run(runID: string, overrides: Partial<StoredRun> = {}): StoredRun {
	return {
		run_id: runID,
		tool: "mwdev_run",
		created_at: daysAgo(1),
		tree_fingerprint: "abc123",
		engine_id: "en-us@4.4.0",
		input_set_id: null,
		payload: { rows: 3 },
		...overrides,
	}
}

afterAll(() => {
	for (const dir of dirs) {
		rmSync(dir, { recursive: true, force: true })
	}
})

describe("putRun / getRun", () => {
	it("round-trips a run with its payload intact", () => {
		const dir = store()

		putRun(run("r1"), dir)

		expect(getRun("r1", dir)?.payload).toEqual({ rows: 3 })
	})

	it("returns undefined for a run that is not there", () => {
		expect(getRun("missing", store())).toBeUndefined()
	})

	it("returns undefined rather than throwing on a corrupt file", () => {
		const dir = store()

		writeFileSync(join(dir, "half.json"), '{"run_id":"half"')

		expect(getRun("half", dir)).toBeUndefined()
	})
})

describe("listRuns", () => {
	it("orders newest first", () => {
		const dir = store()

		putRun(run("older", { created_at: daysAgo(5) }), dir)
		putRun(run("newer", { created_at: daysAgo(1) }), dir)

		expect(listRuns(dir).map((r) => r.run_id)).toEqual(["newer", "older"])
	})

	it("reports fingerprint agreement only when the caller supplies one to compare", () => {
		const dir = store()

		putRun(run("r1", { tree_fingerprint: "abc123" }), dir)

		expect(listRuns(dir)[0]!.fingerprint_matches_now).toBeNull()
		expect(listRuns(dir, "abc123")[0]!.fingerprint_matches_now).toBe(true)
		expect(listRuns(dir, "def456")[0]!.fingerprint_matches_now).toBe(false)
	})

	it("skips a corrupt file instead of failing the whole listing", () => {
		const dir = store()

		putRun(run("good"), dir)
		writeFileSync(join(dir, "bad.json"), "not json at all")

		expect(listRuns(dir).map((r) => r.run_id)).toEqual(["good"])
	})

	it("ignores non-JSON files in the directory", () => {
		const dir = store()

		putRun(run("good"), dir)
		writeFileSync(join(dir, "README.txt"), "notes")

		expect(listRuns(dir)).toHaveLength(1)
	})
})

describe("pruneRuns — the retention rule", () => {
	it("prunes strictly past the age ceiling and keeps what is inside it", () => {
		const dir = store()

		putRun(run("fresh", { created_at: daysAgo(RETENTION_DAYS - 1) }), dir)
		putRun(run("stale", { created_at: daysAgo(RETENTION_DAYS + 1) }), dir)

		const report = pruneRuns(NOW, dir)

		expect(report.pruned_by_age).toEqual(["stale"])
		expect(listRuns(dir).map((r) => r.run_id)).toEqual(["fresh"])
	})

	it("treats an unparseable timestamp as old", () => {
		// A run that cannot say when it happened cannot be trusted to describe a current tree, and keeping it forever is
		// the worse failure.
		const dir = store()

		putRun(run("undated", { created_at: "whenever" }), dir)

		expect(pruneRuns(NOW, dir).pruned_by_age).toEqual(["undated"])
		expect(listRuns(dir)).toHaveLength(0)
	})

	it("applies the count ceiling to runs the age rule kept", () => {
		const dir = store()

		for (let index = 0; index < 5; index++) {
			putRun(run(`r${index}`, { created_at: daysAgo(index + 1) }), dir)
		}

		const report = pruneRuns(NOW, dir, 2)

		expect(report.kept).toBe(2)
		expect(report.pruned_by_count).toEqual(["r2", "r3", "r4"])
		expect(listRuns(dir).map((r) => r.run_id)).toEqual(["r0", "r1"])
	})

	it("keeps the NEWEST under the count ceiling, not the first written", () => {
		const dir = store()

		putRun(run("written-first-but-old", { created_at: daysAgo(9) }), dir)
		putRun(run("written-second-but-new", { created_at: daysAgo(2) }), dir)

		pruneRuns(NOW, dir, 1)

		expect(listRuns(dir).map((r) => r.run_id)).toEqual(["written-second-but-new"])
	})

	it("removes the files, not just the listing", () => {
		const dir = store()

		putRun(run("stale", { created_at: daysAgo(RETENTION_DAYS + 1) }), dir)
		pruneRuns(NOW, dir)

		expect(readdirSync(dir)).toEqual([])
	})

	it("does NOT prune on a fingerprint mismatch", () => {
		// A run from another tree is still evidence about that tree. `{kind:"recorded"}` refuses the comparison and says
		// which two fingerprints it saw; deleting it silently would be the worse answer.
		const dir = store()

		putRun(run("other-tree", { tree_fingerprint: "somethingelse" }), dir)

		const report = pruneRuns(NOW, dir)

		expect(report.pruned_by_age).toEqual([])
		expect(report.pruned_by_count).toEqual([])
		expect(listRuns(dir, "abc123")[0]!.fingerprint_matches_now).toBe(false)
	})

	it("is a no-op on a store that does not exist yet", () => {
		expect(pruneRuns(NOW, join(store(), "never-created"))).toEqual({
			pruned_by_age: [],
			pruned_by_count: [],
			kept: 0,
		})
	})
})
