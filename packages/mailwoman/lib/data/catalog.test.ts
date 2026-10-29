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
import { sha256Hex } from "@mailwoman/core/hash"
import {
	type ActiveSelection,
	type ArtifactManifest,
	ArtifactFormat,
	artifactIDFromSHA256,
	artifactSetID,
	type LayerInstallation,
	layerInstallationID,
	type SelectionEntry,
	ServingRole,
	UnreadableArtifactError,
} from "@mailwoman/core/layers"
import { relative } from "path-ts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
	catalogPaths,
	LayerCatalog,
	readActiveSelection,
	replaceActiveSelection,
	rollbackActiveSelection,
	writeInstallation,
	writeRecordAtomically,
} from "#data/catalog"

vi.mock("@mailwoman/core/fs/writers", { spy: true })

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("mw-catalog-")
})

afterEach(async () => {
	vi.restoreAllMocks()
	await scratch[Symbol.asyncDispose]()
})

/**
 * Install one artifact of `bytes` as `role`, writing its file, manifest and installation record.
 */
async function install(
	role: ServingRole,
	fileName: string,
	bytes: string
): Promise<{ entry: SelectionEntry; path: string }> {
	const root = scratch.path.toString()
	const id = artifactIDFromSHA256(sha256Hex(bytes))
	const directory = catalogPaths(root).artifactDirectory(role, id)
	const path = directory(fileName).toString()

	const manifest: ArtifactManifest = {
		id,
		role,
		format: ArtifactFormat.SQLite,
		schemaVersion: 1,
		bytes: bytes.length,
		normalization: role === ServingRole.Candidate ? null : { algorithm: "street-key", version: "1", locale: "us" },
		scope:
			role === ServingRole.Candidate
				? { countries: [], subdivisions: null }
				: { countries: ["US"], subdivisions: ["US-DC"] },
		observedCountries: null,
		coverageEvidence: false,
		sources: [{ publisher: "fixture", release: null, url: null, sha256: null, md5: null }],
		recipe: null,
		builderSHA: null,
		license: "CC0-1.0",
		createdAt: "2026-10-29T00:00:00Z",
	}

	await writers.writeLocalTextFile(bytes, path)
	await writeRecordAtomically(manifest, directory("manifest.json"))

	const set = artifactSetID([{ artifactID: id, role, schemaVersion: 1 }])
	const origin = { kind: "published" as const, entry: role, release: fileName }

	const installation: LayerInstallation = {
		id: layerInstallationID(set, origin),
		artifactSet: set,
		origin,
		artifacts: [{ artifactID: id, role, path: relative(root, path) }],
		installedAt: "2026-10-29T00:00:00Z",
	}

	await writeInstallation(root, installation)

	const scope =
		role === ServingRole.Candidate ? { country: null, subdivision: null } : { country: "US", subdivision: "US-DC" }

	return { entry: { role, scope, order: [{ installationID: installation.id, artifactID: id }] }, path }
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

		const actual = await vi.importActual<typeof writers>("@mailwoman/core/fs/writers")

		vi.mocked(writers.movePath).mockImplementationOnce(async (source, destination) =>
			actual.movePath(source, destination)
		)

		// The first rename writes the history copy.
		// The second, onto active.json, fails.
		vi.mocked(writers.movePath).mockImplementationOnce(async () => {
			throw new Error("injected rename failure")
		})

		await expect(replaceActiveSelection(scratch.path, { basedOn: 1, set: [dc.entry] })).rejects.toThrow(
			/injected rename failure/u
		)

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
