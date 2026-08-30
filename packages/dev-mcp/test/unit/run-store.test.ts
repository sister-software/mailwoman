/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readDirectory } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { getRun, listRuns, pruneRuns, putRun, RETENTION_DAYS } from "@mailwoman/dev-mcp/run-store"
import type { StoredRun } from "@mailwoman/dev-mcp/run-store"
import { join } from "@mailwoman/platform/path"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function store(): Promise<string> {
	const dir = fixtures.use(await temporaryDirectory("mwdev-runs-")).path

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

describe("putRun / getRun", () => {
	it("round-trips a run with its payload intact", async () => {
		const dir = await store()

		await putRun(run("r1"), dir)

		expect((await getRun("r1", dir))?.payload).toEqual({ rows: 3 })
	})

	it("returns undefined for a run that is not there", async () => {
		expect(await getRun("missing", await store())).toBeUndefined()
	})

	it("returns undefined rather than throwing on a corrupt file", async () => {
		const dir = await store()

		await writeLocalTextFile('{"run_id":"half"', join(dir, "half.json"))

		expect(await getRun("half", dir)).toBeUndefined()
	})
})

describe("listRuns", () => {
	it("orders newest first", async () => {
		const dir = await store()

		await putRun(run("older", { created_at: daysAgo(5) }), dir)
		await putRun(run("newer", { created_at: daysAgo(1) }), dir)

		expect((await listRuns(dir)).map((r) => r.run_id)).toEqual(["newer", "older"])
	})

	it("reports fingerprint agreement only when the caller supplies one to compare", async () => {
		const dir = await store()

		await putRun(run("r1", { tree_fingerprint: "abc123" }), dir)

		expect((await listRuns(dir))[0]!.fingerprint_matches_now).toBeNull()
		expect((await listRuns(dir, "abc123"))[0]!.fingerprint_matches_now).toBe(true)
		expect((await listRuns(dir, "def456"))[0]!.fingerprint_matches_now).toBe(false)
	})

	it("skips a corrupt file instead of failing the whole listing", async () => {
		const dir = await store()

		await putRun(run("good"), dir)
		await writeLocalTextFile("not json at all", join(dir, "bad.json"))

		expect((await listRuns(dir)).map((r) => r.run_id)).toEqual(["good"])
	})

	it("ignores non-JSON files in the directory", async () => {
		const dir = await store()

		await putRun(run("good"), dir)
		await writeLocalTextFile("notes", join(dir, "README.txt"))

		expect(await listRuns(dir)).toHaveLength(1)
	})
})

describe("pruneRuns — the retention rule", () => {
	it("prunes strictly past the age ceiling and keeps what is inside it", async () => {
		const dir = await store()

		await putRun(run("fresh", { created_at: daysAgo(RETENTION_DAYS - 1) }), dir)
		await putRun(run("stale", { created_at: daysAgo(RETENTION_DAYS + 1) }), dir)

		const report = await pruneRuns(NOW, dir)

		expect(report.pruned_by_age).toEqual(["stale"])
		expect((await listRuns(dir)).map((r) => r.run_id)).toEqual(["fresh"])
	})

	it("treats an unparseable timestamp as old", async () => {
		// A run that cannot say when it happened cannot be trusted to describe a current tree, and keeping it forever is
		// the worse failure.
		const dir = await store()

		await putRun(run("undated", { created_at: "whenever" }), dir)

		expect((await pruneRuns(NOW, dir)).pruned_by_age).toEqual(["undated"])
		expect(await listRuns(dir)).toHaveLength(0)
	})

	it("applies the count ceiling to runs the age rule kept", async () => {
		const dir = await store()

		for (let index = 0; index < 5; index++) {
			await putRun(run(`r${index}`, { created_at: daysAgo(index + 1) }), dir)
		}

		const report = await pruneRuns(NOW, dir, 2)

		expect(report.kept).toBe(2)
		expect(report.pruned_by_count).toEqual(["r2", "r3", "r4"])
		expect((await listRuns(dir)).map((r) => r.run_id)).toEqual(["r0", "r1"])
	})

	it("keeps the NEWEST under the count ceiling, not the first written", async () => {
		const dir = await store()

		await putRun(run("written-first-but-old", { created_at: daysAgo(9) }), dir)
		await putRun(run("written-second-but-new", { created_at: daysAgo(2) }), dir)

		await pruneRuns(NOW, dir, 1)

		expect((await listRuns(dir)).map((r) => r.run_id)).toEqual(["written-second-but-new"])
	})

	it("removes the files, not just the listing", async () => {
		const dir = await store()

		await putRun(run("stale", { created_at: daysAgo(RETENTION_DAYS + 1) }), dir)
		await pruneRuns(NOW, dir)

		expect(await readDirectory(dir)).toEqual([])
	})

	it("does NOT prune on a fingerprint mismatch", async () => {
		// A run from another tree is still evidence about that tree. `{kind:"recorded"}` refuses the comparison and says
		// which two fingerprints it saw; deleting it silently would be the worse answer.
		const dir = await store()

		await putRun(run("other-tree", { tree_fingerprint: "somethingelse" }), dir)

		const report = await pruneRuns(NOW, dir)

		expect(report.pruned_by_age).toEqual([])
		expect(report.pruned_by_count).toEqual([])
		expect((await listRuns(dir, "abc123"))[0]!.fingerprint_matches_now).toBe(false)
	})

	it("is a no-op on a store that does not exist yet", async () => {
		expect(await pruneRuns(NOW, join(await store(), "never-created"))).toEqual({
			pruned_by_age: [],
			pruned_by_count: [],
			kept: 0,
		})
	})
})
