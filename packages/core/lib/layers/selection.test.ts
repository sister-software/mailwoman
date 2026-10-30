/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	type ActiveSelection,
	ActiveSelectionError,
	activeSelectionProblems,
	type ArtifactManifest,
	artifactSetID,
	assertActiveSelection,
	assertSelectionSuccessor,
	type LayerInstallation,
	layerInstallationID,
	selectedSources,
	selectionScopesOf,
	ServingRole,
} from "#layers"
import { CANDIDATE, DACH_OSM, DC_ADDRESS_POINTS, DC_INTERPOLATION, FR_BAN, FR_OSM } from "#test/layer-artifact-fixtures"

function install(manifests: readonly ArtifactManifest[], entry: string): LayerInstallation {
	const artifactSet = artifactSetID(
		manifests.map((manifest) => ({
			artifactID: manifest.id,
			role: manifest.role,
			schemaVersion: manifest.schemaVersion,
		}))
	)

	const origin = { kind: "published", entry, release: "2026-10-28" } as const

	return {
		id: layerInstallationID(artifactSet, origin),
		artifactSet,
		origin,
		artifacts: manifests.map((manifest) => ({
			artifactID: manifest.id,
			role: manifest.role,
			path: `db/${manifest.role}/${manifest.id.slice("sha256:".length)}/artifact`,
		})),
		installedAt: "2026-10-28T00:00:00Z",
	}
}

const candidate = install([CANDIDATE], "candidate")
const dc = install([DC_ADDRESS_POINTS, DC_INTERPOLATION], "us")
const ban = install([FR_BAN], "fr-ban")
const frOSM = install([FR_OSM], "fr-osm")
const dach = install([DACH_OSM], "dach-osm")
const INSTALLATIONS = [candidate, dc, ban, frOSM, dach]

const source = (installation: LayerInstallation, manifest: ArtifactManifest) => ({
	installationID: installation.id,
	artifactID: manifest.id,
})

const SELECTION: ActiveSelection = {
	format: 1,
	generation: 3,
	previousGeneration: 2,
	createdAt: "2026-10-28T00:00:00Z",
	entries: [
		{ role: ServingRole.Candidate, scope: { country: null, subdivision: null }, order: [source(candidate, CANDIDATE)] },
		{
			role: ServingRole.AddressPoints,
			scope: { country: "US", subdivision: "US-DC" },
			order: [source(dc, DC_ADDRESS_POINTS)],
		},
		{
			role: ServingRole.Interpolation,
			scope: { country: "US", subdivision: "US-DC" },
			order: [source(dc, DC_INTERPOLATION)],
		},
		// Today's order for France: the national register, then OpenStreetMap when the register is absent.
		{
			role: ServingRole.AddressPoints,
			scope: { country: "FR", subdivision: null },
			order: [source(ban, FR_BAN), source(frOSM, FR_OSM)],
		},
		// One region's artifact serves several countries through one installation.
		...["AT", "CH", "DE", "LI"].map((country) => ({
			role: ServingRole.AddressPoints,
			scope: { country, subdivision: null },
			order: [source(dach, DACH_OSM)],
		})),
	],
}

describe("assertActiveSelection", () => {
	it("accepts a selection describing every fixture case", () => {
		expect(() => assertActiveSelection(SELECTION, INSTALLATIONS)).not.toThrow()
	})

	it("refuses a selection naming an installation that is not installed", () => {
		expect(() => assertActiveSelection(SELECTION, [candidate, dc, ban, dach])).toThrow(
			new RegExp(`selects installation ${frOSM.id}, which is not installed`)
		)
	})

	it("refuses a source whose installed artifact serves another role", () => {
		const entries = [
			{ role: ServingRole.Interpolation, scope: { country: "FR", subdivision: null }, order: [source(ban, FR_BAN)] },
		]

		expect(() => assertActiveSelection({ ...SELECTION, entries }, INSTALLATIONS)).toThrow(
			/reads interpolation from sha256:[0-9a-f]+, which serves address-points/
		)
	})

	it("reports every malformed field of the document itself", () => {
		const problems = activeSelectionProblems({
			format: 2,
			generation: 0,
			createdAt: "",
			entries: [
				{ role: ServingRole.AddressPoints, scope: { country: "US", subdivision: "FR-75" }, order: [] },
				{ role: ServingRole.AddressPoints, scope: { country: "US", subdivision: "FR-75" }, order: [] },
			],
		})

		expect(problems).toEqual([
			"format 2 is unsupported; this reader reads 1",
			"generation must be a positive integer",
			"previousGeneration is missing; write null for the first generation",
			"createdAt is missing",
			'entries[0] subdivision "FR-75" is not an ISO 3166-2 code inside country "US"',
			"entries[0] order is empty; remove the entry to select nothing",
			'entries[1] subdivision "FR-75" is not an ISO 3166-2 code inside country "US"',
			"entries[1] repeats the role and scope of an earlier entry",
			"entries[1] order is empty; remove the entry to select nothing",
		])
	})

	it("refuses a source listed twice in one order", () => {
		const entries = [
			{
				role: ServingRole.AddressPoints,
				scope: { country: "FR", subdivision: null },
				order: [source(ban, FR_BAN), source(ban, FR_BAN)],
			},
		]

		expect(activeSelectionProblems({ ...SELECTION, entries })).toEqual([`entries[0] lists ${FR_BAN.id} twice`])
	})
})

describe("assertSelectionSuccessor", () => {
	const next = { ...SELECTION, generation: 4, previousGeneration: 3 }

	it("accepts the next generation built on the current one", () => {
		expect(() => assertSelectionSuccessor(SELECTION, next)).not.toThrow()
	})

	it("refuses a replacement built on a generation another writer already replaced", () => {
		const moved = { ...SELECTION, generation: 4, previousGeneration: 3 }

		expect(() => assertSelectionSuccessor(moved, next)).toThrow(ActiveSelectionError)
	})

	it("starts an empty data root at generation 1", () => {
		expect(() =>
			assertSelectionSuccessor(null, { ...SELECTION, generation: 1, previousGeneration: null })
		).not.toThrow()
	})
})

describe("selectedSources", () => {
	it("answers a subdivision before its country and keeps each entry's order", () => {
		expect(selectedSources(SELECTION, ServingRole.AddressPoints, { country: "US", subdivision: "US-DC" })).toEqual([
			source(dc, DC_ADDRESS_POINTS),
		])

		expect(selectedSources(SELECTION, ServingRole.AddressPoints, { country: "FR", subdivision: null })).toEqual([
			source(ban, FR_BAN),
			source(frOSM, FR_OSM),
		])
	})

	it("answers a subdivision with no entry of its own from nothing when its country has none", () => {
		expect(selectedSources(SELECTION, ServingRole.AddressPoints, { country: "US", subdivision: "US-VA" })).toEqual([])
	})

	it("answers an unscoped role for every scope", () => {
		expect(selectedSources(SELECTION, ServingRole.Candidate, { country: "LI", subdivision: null })).toEqual([
			source(candidate, CANDIDATE),
		])
	})
})

describe("layerInstallationID", () => {
	it("is the same for the same set from the same origin and differs by origin", () => {
		const origin = { kind: "published", entry: "us", release: "2026-10-28" } as const

		expect(layerInstallationID(dc.artifactSet, origin)).toBe(dc.id)
		expect(layerInstallationID(dc.artifactSet, { ...origin, release: "2026-11-01" })).not.toBe(dc.id)
	})
})

describe("selectionScopesOf", () => {
	it("gives a multi-country artifact one entry per country and no unscoped entry", () => {
		expect(selectionScopesOf(DACH_OSM.scope)).toEqual(
			["AT", "CH", "DE", "LI"].map((country) => ({ country, subdivision: null }))
		)
	})

	it("gives a subdivision artifact one entry per subdivision, inside its country", () => {
		expect(selectionScopesOf({ countries: ["US"], subdivisions: ["US-DC", "US-MD"] })).toEqual([
			{ country: "US", subdivision: "US-DC" },
			{ country: "US", subdivision: "US-MD" },
		])
	})

	it("gives an artifact scoped to no country the unscoped entry", () => {
		expect(selectionScopesOf({ countries: [], subdivisions: null })).toEqual([{ country: null, subdivision: null }])
	})
})
