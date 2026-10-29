/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ServingRole } from "@mailwoman/core/layers"
import { describe, expect, it } from "vitest"

import { BUNDLES } from "#data/bundles"
import {
	AccessRequirement,
	AvailabilityKind,
	type AvailableArtifact,
	type AvailableDataEntry,
	availableDataEntry,
	availableDataEntryProblems,
	availableDataRegistry,
	availableDataRegistryProblems,
	SizeBasis,
} from "#data/registry"

const US_STREETS = { algorithm: "street-key", version: "1", locale: "us" }

const candidate: AvailableDataEntry = {
	name: "candidate",
	kind: AvailabilityKind.Download,
	capabilities: [ServingRole.Candidate],
	countries: [],
	subdivisions: null,
	dependencies: [],
	access: AccessRequirement.Public,
	license: "ODbL-1.0 AND CDLA-Permissive-2.0 AND CC-BY-4.0",
	artifacts: [
		{
			role: ServingRole.Candidate,
			remotePath: "gazetteer/2026-08-25b/candidate.db",
			expectedID: null,
			md5: null,
			size: { basis: SizeBasis.Verified, bytes: 2_880_921_600 },
			scope: { countries: [], subdivisions: null },
			schemaVersion: 1,
			normalization: null,
		},
	],
	recipe: null,
	activation: "selection",
}

const dcScope = { countries: ["US"], subdivisions: ["US-DC"] }

const dc: AvailableDataEntry = {
	...candidate,
	name: "us-dc",
	capabilities: [ServingRole.AddressPoints, ServingRole.Interpolation],
	countries: ["US"],
	subdivisions: ["US-DC"],
	dependencies: ["candidate"],
	license: "CC0-1.0",
	artifacts: [
		{
			role: ServingRole.AddressPoints,
			remotePath: "street/us/dc/situs.db",
			expectedID: null,
			md5: null,
			size: { basis: SizeBasis.Estimated, bytes: 119_889_920 },
			scope: dcScope,
			schemaVersion: 1,
			normalization: US_STREETS,
		},
		{
			role: ServingRole.Interpolation,
			remotePath: "street/us/dc/interp.db",
			expectedID: null,
			md5: null,
			size: { basis: SizeBasis.Unknown },
			scope: dcScope,
			schemaVersion: 1,
			normalization: US_STREETS,
		},
	],
}

const osmBuild: AvailableDataEntry = {
	...candidate,
	name: "osm-dach",
	kind: AvailabilityKind.Build,
	capabilities: [ServingRole.AddressPoints],
	countries: ["AT", "CH", "DE", "LI"],
	license: "ODbL-1.0",
	dependencies: ["candidate"],
	artifacts: [],
	recipe: "osm",
}

describe("availableDataEntryProblems", () => {
	it.each([candidate, dc, osmBuild])("accepts $name", (entry) => {
		expect(availableDataEntryProblems(entry)).toEqual([])
	})

	it("keeps an unknown size distinct from a recorded one and refuses a size with no basis", () => {
		const { size: _omitted, ...artifact } = dc.artifacts[0]!

		expect(availableDataEntryProblems({ ...dc, artifacts: [artifact as AvailableArtifact] })).toEqual([
			'artifacts[0].size is missing; record {basis: "unknown"} when unrecorded',
		])
	})

	it("refuses an artifact whose role the entry does not declare as a capability", () => {
		expect(availableDataEntryProblems({ ...dc, capabilities: [ServingRole.AddressPoints] })).toEqual([
			"artifacts[1].role interpolation is not among the entry's capabilities",
		])
	})

	it("refuses a street-keyed artifact without a normalization and a gazetteer with one", () => {
		const unkeyed = { ...dc.artifacts[0]!, normalization: null }
		const keyed = { ...candidate.artifacts[0]!, normalization: US_STREETS }

		expect(availableDataEntryProblems({ ...dc, artifacts: [unkeyed, dc.artifacts[1]!] })).toEqual([
			"artifacts[0] is street-keyed (address-points) and records no normalization",
		])

		expect(availableDataEntryProblems({ ...candidate, artifacts: [keyed] })).toEqual([
			"artifacts[0] keys no street (candidate) and records a normalization",
		])
	})

	it("refuses a build entry with download artifacts and no recipe", () => {
		expect(availableDataEntryProblems({ ...osmBuild, recipe: null, artifacts: dc.artifacts.slice(0, 1) })).toEqual([
			"a build entry names its recipe",
			"a build entry lists no download artifacts",
			"artifacts[0].scope names a country the entry does not",
		])
	})
})

describe("availableDataRegistryProblems", () => {
	it("accepts a registry whose dependencies resolve", () => {
		expect(availableDataRegistryProblems([candidate, dc, osmBuild])).toEqual([])
	})

	it("refuses an unregistered dependency, a repeated name and a cycle", () => {
		const looped = { ...candidate, dependencies: ["us-dc"] }

		expect(availableDataRegistryProblems([looped, dc, { ...osmBuild, dependencies: ["tiger"] }, osmBuild])).toEqual([
			"osm-dach: the name is repeated",
			"osm-dach: depends on tiger, which is not registered",
			"dependency cycle: candidate -> us-dc -> candidate",
		])
	})
})

describe("availableDataRegistry", () => {
	it("reads every published bundle as a valid entry", () => {
		expect(availableDataRegistryProblems(availableDataRegistry())).toEqual([])
	})

	it("scopes each per-state US artifact to its subdivision and keys its streets under the US locale", () => {
		const us = availableDataEntry(BUNDLES["us"]!)
		const dcArtifacts = us.artifacts.filter((artifact) => artifact.remotePath.startsWith("street/us/dc/"))

		expect(dcArtifacts.map((artifact) => [artifact.role, artifact.scope, artifact.normalization?.locale])).toEqual([
			[ServingRole.AddressPoints, dcScope, "us"],
			[ServingRole.Interpolation, dcScope, "us"],
		])

		expect(us.dependencies).toEqual(["candidate"])
		expect(us.activation).toBe("selection")
	})

	it("leaves the gazetteer unscoped and records sizes as estimates, never as verified", () => {
		const entry = availableDataEntry(BUNDLES["candidate"]!)

		expect(entry.artifacts[0]!.scope).toEqual({ countries: [], subdivisions: null })
		expect(entry.artifacts[0]!.size.basis).toBe(SizeBasis.Estimated)
		expect(entry.artifacts[0]!.normalization).toBeNull()
	})
})
