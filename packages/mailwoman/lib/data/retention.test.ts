/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Prune keeps the active and rollback generations and every generation a live session holds, deletes the
 *   rest, and refuses to delete when the selection moved after planning.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { removePath, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { ServingRole } from "@mailwoman/core/layers"
import { escapeRegExp } from "@mailwoman/core/strings/regexp"
import { resolvePath } from "path-ts"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { catalogPaths, LayerCatalog, replaceActiveSelection } from "#data/catalog"
import { executePrune, holdSelectionLease, planPrune, readLiveLeases } from "#data/retention"
import { installFixtureArtifact } from "#test-kit/fixture-registry"

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("mw-retention-")
})

afterEach(async () => {
	await scratch[Symbol.asyncDispose]()
})

/**
 * Three generations, each selecting a different candidate: A, then B, then C.
 */
async function threeGenerations() {
	const a = await installFixtureArtifact(scratch.path, ServingRole.Candidate, "candidate.db", "release a")
	const b = await installFixtureArtifact(scratch.path, ServingRole.Candidate, "candidate.db", "release b")
	const c = await installFixtureArtifact(scratch.path, ServingRole.Candidate, "candidate.db", "release c")

	await replaceActiveSelection(scratch.path, { basedOn: null, set: [a.entry] })
	await replaceActiveSelection(scratch.path, { basedOn: 1, set: [b.entry] })
	await replaceActiveSelection(scratch.path, { basedOn: 2, set: [c.entry] })

	return { a, b, c }
}

describe("planPrune and executePrune", () => {
	it("keeps the active and rollback generations and deletes the artifact only an older one selected", async () => {
		const { a, b, c } = await threeGenerations()
		const plan = await planPrune(scratch.path)

		expect(plan.retainedGenerations).toEqual([2, 3])
		expect(plan.candidates.map((candidate) => candidate.artifactID)).toEqual([a.entry.order[0]!.artifactID])
		expect(plan.reclaimableBytes).toBe("release a".length)
		// The dry run keeps every file.
		expect(await pathExists(a.path)).toBe(true)

		const result = await executePrune(plan)

		expect(result.deleted).toHaveLength(1)
		expect(await pathExists(a.path)).toBe(false)
		expect(await pathExists(b.path)).toBe(true)
		expect(await pathExists(c.path)).toBe(true)

		const catalog = await LayerCatalog.read(scratch.path)

		expect(await catalog.firstPath(ServingRole.Candidate, { country: null, subdivision: null })).toBe(c.path)
	})

	it("keeps an artifact a running session's generation selects", async () => {
		const { a } = await threeGenerations()

		using _lease = await holdSelectionLease(scratch.path, 1)

		expect((await readLiveLeases(scratch.path)).map((lease) => lease.generation)).toEqual([1])

		const plan = await planPrune(scratch.path)

		expect(plan.retainedGenerations).toEqual([1, 2, 3])
		expect(plan.candidates).toEqual([])
		expect(await pathExists(a.path)).toBe(true)
	})

	it("refuses to delete when an activation moved the selection after planning", async () => {
		const { a, c } = await threeGenerations()
		const plan = await planPrune(scratch.path)

		await replaceActiveSelection(scratch.path, { basedOn: 3, set: [a.entry] })

		await expect(executePrune(plan)).rejects.toThrow(/selection moved from generation 3 to 4 after planning/u)
		expect(await pathExists(a.path)).toBe(true)
		expect(await pathExists(c.path)).toBe(true)
	})

	it("refuses to delete when a session took a lease after planning", async () => {
		const { a } = await threeGenerations()
		const plan = await planPrune(scratch.path)

		using _lease = await holdSelectionLease(scratch.path, 1)

		await expect(executePrune(plan)).rejects.toThrow(/sessions holding generations changed/u)
		expect(await pathExists(a.path)).toBe(true)
	})
})

describe("planPrune's retain count", () => {
	it.each([Number.NaN, Number("not-a-number"), Number.POSITIVE_INFINITY, 0.5, 0, -1, Number.MAX_SAFE_INTEGER + 1])(
		"refuses retain %s before a plan exists",
		async (retain) => {
			const { a, b, c } = await threeGenerations()

			await expect(planPrune(scratch.path, { retain })).rejects.toThrow(/retain must be a positive whole number/u)
			expect(await pathExists(a.path)).toBe(true)
			expect(await pathExists(b.path)).toBe(true)
			expect(await pathExists(c.path)).toBe(true)
		}
	)

	it("keeps only the active generation at retain 1", async () => {
		const { a, b } = await threeGenerations()
		const plan = await planPrune(scratch.path, { retain: 1 })

		expect(plan.retainedGenerations).toEqual([3])

		expect(plan.candidates.map((candidate) => candidate.artifactID).toSorted()).toEqual(
			[a.entry.order[0]!.artifactID, b.entry.order[0]!.artifactID].toSorted()
		)
	})
})

describe("planPrune's reading of retained history", () => {
	/**
	 * A, activated as generation 1, then B as generation 2.
	 */
	async function twoGenerations() {
		const a = await installFixtureArtifact(scratch.path, ServingRole.Candidate, "candidate.db", "release a")
		const b = await installFixtureArtifact(scratch.path, ServingRole.Candidate, "candidate.db", "release b")

		await replaceActiveSelection(scratch.path, { basedOn: null, set: [a.entry] })
		await replaceActiveSelection(scratch.path, { basedOn: 1, set: [b.entry] })

		return { a, b }
	}

	it("refuses when a retained generation's history record is missing, and deletes nothing", async () => {
		const { a, b } = await twoGenerations()
		const history = catalogPaths(scratch.path).selectionHistory("1.json")

		await removePath(history)

		await expect(planPrune(scratch.path)).rejects.toThrow(
			new RegExp(`generation 1 is retained, but its record ${escapeRegExp(history.toString())} is missing`, "u")
		)

		expect(await pathExists(a.path)).toBe(true)
		expect(await pathExists(b.path)).toBe(true)
	})

	it("refuses when a leased generation's history record is missing", async () => {
		const { a } = await threeGenerations()

		await removePath(catalogPaths(scratch.path).selectionHistory("1.json"))

		using _lease = await holdSelectionLease(scratch.path, 1)

		await expect(planPrune(scratch.path)).rejects.toThrow(/generation 1 is retained, but its record .* is missing/u)
		expect(await pathExists(a.path)).toBe(true)
	})

	it("refuses when a retained generation's history record cannot be parsed, naming its path", async () => {
		await twoGenerations()

		const history = catalogPaths(scratch.path).selectionHistory("1.json")

		await writeLocalTextFile("{broken", history)

		await expect(planPrune(scratch.path)).rejects.toThrow(
			new RegExp(`generation 1's record ${escapeRegExp(history.toString())} cannot be read`, "u")
		)
	})

	it("refuses when a retained generation's history record has no entries list", async () => {
		await twoGenerations()

		await writeLocalTextFile(`{"generation":1}`, catalogPaths(scratch.path).selectionHistory("1.json"))

		await expect(planPrune(scratch.path)).rejects.toThrow(/generation 1's record .* has no entries list/u)
	})
})

describe("executePrune's active-generation check", () => {
	it("refuses a plan that lists an artifact the active generation selects, and keeps its bytes", async () => {
		const { c } = await threeGenerations()
		const plan = await planPrune(scratch.path)
		const active = c.entry.order[0]!

		const corrupted = {
			...plan,
			candidates: [
				...plan.candidates,
				{
					installationID: active.installationID,
					artifactID: active.artifactID,
					directory: resolvePath(c.path, ".."),
					bytes: "release c".length,
				},
			],
		}

		await expect(executePrune(corrupted)).rejects.toThrow(/active generation 3 selects/u)
		expect(await pathExists(c.path)).toBe(true)
		expect(await readLocalTextFile(c.path)).toBe("release c")
	})
})
