/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The active selection is replaced whole or not at all, refuses a writer that planned against an older
 *   generation, rolls back to the generation it replaced, and reports a damaged artifact instead of skipping it.
 */

import { tryReadLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import * as writers from "@mailwoman/core/fs/writers"
import { type ActiveSelection, ServingRole, UnreadableArtifactError } from "@mailwoman/core/layers"
import type { PathBuilderLike } from "path-ts"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
	activateInstallation,
	catalogPaths,
	LayerCatalog,
	readActiveSelection,
	replaceActiveSelection,
	rollbackActiveSelection,
	writeRecordAtomically,
} from "#data/catalog"
import { installFixtureArtifact } from "#test-kit/fixture-registry"

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("mw-catalog-")
})

afterEach(async () => {
	await scratch[Symbol.asyncDispose]()
})

function install(role: ServingRole, fileName: string, bytes: string) {
	return installFixtureArtifact(scratch.path, role, fileName, bytes)
}

describe("replaceActiveSelection", () => {
	it("writes generation 1 from an empty data root and generation 2 on top of it, keeping both for rollback", async () => {
		const candidate = await install(ServingRole.Candidate, "candidate.db", "candidate bytes")
		const dc = await install(ServingRole.AddressPoints, "address-points-us-dc.db", "dc bytes")

		const first = await replaceActiveSelection(scratch.path, { basedOn: null, set: [candidate.entry] })
		const second = await replaceActiveSelection(scratch.path, { basedOn: 1, set: [dc.entry] })

		expect([first.generation, first.previousGeneration]).toEqual([1, null])
		expect([second.generation, second.previousGeneration]).toEqual([2, 1])
		expect(second.entries).toHaveLength(2)

		const catalog = await LayerCatalog.read(scratch.path)

		expect(await catalog.firstPath(ServingRole.Candidate, { country: null, subdivision: null })).toBe(candidate.path)
		expect(await catalog.firstPath(ServingRole.AddressPoints, { country: "US", subdivision: "US-DC" })).toBe(dc.path)
		expect(await catalog.firstPath(ServingRole.AddressPoints, { country: "US", subdivision: "US-AL" })).toBeNull()

		const history = await tryReadLocalJSONFile<ActiveSelection>(catalogPaths(scratch.path).selectionHistory("1.json"))

		expect(history?.generation).toBe(1)
	})

	it("refuses a writer that planned against a generation the selection has moved past", async () => {
		const candidate = await install(ServingRole.Candidate, "candidate.db", "candidate bytes")
		const dc = await install(ServingRole.AddressPoints, "address-points-us-dc.db", "dc bytes")

		await replaceActiveSelection(scratch.path, { basedOn: null, set: [candidate.entry] })

		// Both writers planned against generation 1.
		// The first to replace wins.
		const outcomes = await Promise.allSettled([
			replaceActiveSelection(scratch.path, { basedOn: 1, set: [dc.entry] }),
			replaceActiveSelection(scratch.path, { basedOn: 1, set: [dc.entry] }),
		])

		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)

		expect(String((outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult).reason)).toMatch(
			/selection moved to generation 2 after this plan read 1|holds the selection lock/u
		)

		expect((await readActiveSelection(scratch.path))?.generation).toBe(2)
	})

	it("refuses a selection that names an artifact whose file is missing, leaving the previous generation", async () => {
		const candidate = await install(ServingRole.Candidate, "candidate.db", "candidate bytes")
		const dc = await install(ServingRole.AddressPoints, "address-points-us-dc.db", "dc bytes")

		await replaceActiveSelection(scratch.path, { basedOn: null, set: [candidate.entry] })
		await writers.removePath(dc.path)

		await expect(replaceActiveSelection(scratch.path, { basedOn: 1, set: [dc.entry] })).rejects.toThrow(
			/is not on disk/u
		)

		expect((await readActiveSelection(scratch.path))?.generation).toBe(1)
	})

	it("leaves the previous generation readable when the final rename fails", async () => {
		const candidate = await install(ServingRole.Candidate, "candidate.db", "candidate bytes")
		const dc = await install(ServingRole.AddressPoints, "address-points-us-dc.db", "dc bytes")

		await replaceActiveSelection(scratch.path, { basedOn: null, set: [candidate.entry] })

		// The history copy is written.
		// The write onto active.json fails.
		const writeRecord = async (record: unknown, destination: PathBuilderLike) => {
			if (destination.toString().endsWith("active.json")) throw new Error("injected rename failure")

			await writeRecordAtomically(record, destination)
		}

		await expect(
			replaceActiveSelection(scratch.path, { basedOn: 1, set: [dc.entry] }, { writeRecord })
		).rejects.toThrow(/injected rename failure/u)

		const after = await readActiveSelection(scratch.path)

		expect(after?.generation).toBe(1)
		expect(after?.entries).toEqual([candidate.entry])
	})
})

describe("rollbackActiveSelection", () => {
	it("restores the replaced generation's entries under a new generation", async () => {
		const candidate = await install(ServingRole.Candidate, "candidate.db", "candidate bytes")
		const dc = await install(ServingRole.AddressPoints, "address-points-us-dc.db", "dc bytes")

		await replaceActiveSelection(scratch.path, { basedOn: null, set: [candidate.entry] })
		await replaceActiveSelection(scratch.path, { basedOn: 1, set: [dc.entry] })

		const restored = await rollbackActiveSelection(scratch.path)

		expect([restored.generation, restored.previousGeneration]).toEqual([3, 2])
		expect(restored.entries).toEqual([candidate.entry])
	})

	it("refuses when the selection replaced no earlier generation", async () => {
		const candidate = await install(ServingRole.Candidate, "candidate.db", "candidate bytes")

		await replaceActiveSelection(scratch.path, { basedOn: null, set: [candidate.entry] })

		await expect(rollbackActiveSelection(scratch.path)).rejects.toThrow(/replaced no earlier generation/u)
	})
})

describe("activateInstallation", () => {
	it("selects an installed installation's artifacts for the scope their manifests record", async () => {
		const candidate = await install(ServingRole.Candidate, "candidate.db", "candidate bytes")
		const dc = await install(ServingRole.AddressPoints, "address-points-us-dc.db", "dc bytes")

		await replaceActiveSelection(scratch.path, { basedOn: null, set: [candidate.entry] })

		const next = await activateInstallation(scratch.path, dc.installationID)

		expect(next.generation).toBe(2)
		expect(next.entries).toEqual([candidate.entry, dc.entry])
	})

	it("refuses an installation that is not installed", async () => {
		await expect(activateInstallation(scratch.path, "inst-0000000000000000")).rejects.toThrow(/is not installed/u)
	})
})

describe("LayerCatalog", () => {
	it("answers no selection for a data root without active.json", async () => {
		const catalog = await LayerCatalog.read(scratch.path)

		expect(catalog.generation).toBeNull()
		expect(await catalog.firstPath(ServingRole.Candidate, { country: null, subdivision: null })).toBeNull()
	})

	it("reports a selected artifact whose size no longer matches its manifest as unreadable, naming its path", async () => {
		const candidate = await install(ServingRole.Candidate, "candidate.db", "candidate bytes")

		await replaceActiveSelection(scratch.path, { basedOn: null, set: [candidate.entry] })
		await writers.changeMode(candidate.path, 0o644)
		await writers.truncateFile(candidate.path, 3)

		const catalog = await LayerCatalog.read(scratch.path)

		const failure = await catalog
			.firstPath(ServingRole.Candidate, { country: null, subdivision: null })
			.catch((error: unknown) => error)

		expect(failure).toBeInstanceOf(UnreadableArtifactError)
		expect((failure as UnreadableArtifactError).path).toBe(candidate.path)
		expect((failure as UnreadableArtifactError).reason).toBe("corrupt")
	})

	it("reports an active.json that is not JSON as unreadable rather than as no selection", async () => {
		await writers.writeLocalTextFile("{ not json", catalogPaths(scratch.path).activeSelection)

		await expect(LayerCatalog.read(scratch.path)).rejects.toBeInstanceOf(UnreadableArtifactError)
	})
})
