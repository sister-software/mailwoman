/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	type ArtifactManifest,
	ArtifactManifestError,
	type ArtifactSourceInput,
	artifactIDFromSHA256,
	artifactManifestProblems,
	artifactSetID,
	artifactSetProblems,
	assertArtifactManifest,
	assertArtifactSet,
	readerIncompatibility,
	ServingRole,
} from "#layers"
import {
	CANDIDATE,
	DACH_OSM,
	DC_ADDRESS_POINTS,
	DC_INTERPOLATION,
	FR_BAN,
	LAYER_FIXTURES,
	MORPHOLOGY_FST,
	MORPHOLOGY_PAIRS,
} from "#test/layer-artifact-fixtures"

function member(manifest: ArtifactManifest) {
	return { artifactID: manifest.id, role: manifest.role, schemaVersion: manifest.schemaVersion }
}

describe("artifactIDFromSHA256", () => {
	it("refuses a 32-character MD5 where a SHA-256 belongs", () => {
		expect(() => artifactIDFromSHA256("d41d8cd98f00b204e9800998ecf8427e")).toThrow(/64 lowercase hex/)
	})
})

describe("assertArtifactManifest", () => {
	it.each(LAYER_FIXTURES.map((fixture) => [fixture.role, fixture.format, fixture]))(
		"accepts the %s %s fixture",
		(_role, _format, fixture) => {
			expect(artifactManifestProblems(fixture)).toEqual([])
		}
	)

	it("requires normalization for a street-keyed role", () => {
		expect(artifactManifestProblems({ ...DC_ADDRESS_POINTS, normalization: null })).toEqual([
			"role address-points keys rows by street and requires normalization {algorithm, version, locale}",
		])
	})

	it("refuses normalization on a role that keys no street", () => {
		expect(artifactManifestProblems({ ...CANDIDATE, normalization: DC_ADDRESS_POINTS.normalization })).toEqual([
			"role candidate keys no street, so it records no normalization",
		])
	})

	it("reports a field the build omitted rather than reading it as unrecorded", () => {
		const { observedCountries: _omitted, ...rest } = DC_ADDRESS_POINTS

		expect(() => assertArtifactManifest(rest, "dc")).toThrow(ArtifactManifestError)

		expect(artifactManifestProblems(rest)).toEqual([
			"observedCountries is missing; write null when the build did not record them",
		])
	})

	it("reports every missing source field and a malformed source digest", () => {
		const { md5: _omitted, ...source } = { ...DC_ADDRESS_POINTS.sources[0]!, sha256: "abc" }

		expect(artifactManifestProblems({ ...DC_ADDRESS_POINTS, sources: [source as ArtifactSourceInput] })).toEqual([
			"sources[0].md5 is missing; write null when unrecorded",
			"sources[0].sha256 is not 64 lowercase hex characters",
		])
	})

	it("refuses a subdivision outside the scoped countries and a lowercase country", () => {
		expect(
			artifactManifestProblems({ ...DC_ADDRESS_POINTS, scope: { countries: ["us"], subdivisions: ["FR-75"] } })
		).toEqual([
			'scope country "us" is not an uppercase ISO 3166-1 alpha-2 code',
			'scope subdivision "FR-75" is not an ISO 3166-2 code in the scoped countries',
		])
	})

	it("refuses a format the role does not read", () => {
		expect(artifactManifestProblems({ ...MORPHOLOGY_FST, format: "sqlite" })).toEqual([
			"role street-morphology does not read format sqlite",
		])
	})
})

describe("artifact sets", () => {
	const fstSet = {
		id: artifactSetID([member(MORPHOLOGY_FST), member(MORPHOLOGY_PAIRS)]),
		members: [member(MORPHOLOGY_FST), member(MORPHOLOGY_PAIRS)],
	}

	it("binds a non-SQLite set by digest, independent of member order", () => {
		expect(artifactSetID([member(MORPHOLOGY_PAIRS), member(MORPHOLOGY_FST)])).toBe(fstSet.id)
		expect(() => assertArtifactSet(fstSet, LAYER_FIXTURES)).not.toThrow()
	})

	it("accepts DC address points with interpolation keyed the same way", () => {
		const members = [member(DC_ADDRESS_POINTS), member(DC_INTERPOLATION)]

		expect(artifactSetProblems({ id: artifactSetID(members), members }, LAYER_FIXTURES)).toEqual([])
	})

	it("refuses members whose streets were normalized differently", () => {
		const members = [member(DC_ADDRESS_POINTS), member(FR_BAN)]
		const problems = artifactSetProblems({ id: artifactSetID(members), members }, LAYER_FIXTURES)

		expect(problems).toHaveLength(1)
		expect(problems[0]).toMatch(/key streets differently/)
	})

	it("refuses a missing manifest, a schema disagreement and an identity that is not the members' digest", () => {
		const members = [member(MORPHOLOGY_FST), { ...member(MORPHOLOGY_PAIRS), schemaVersion: 2 }]

		expect(artifactSetProblems({ id: fstSet.id, members }, [MORPHOLOGY_FST, MORPHOLOGY_PAIRS])).toEqual([
			`member ${MORPHOLOGY_PAIRS.id} is listed at schema 2 and its manifest says 1`,
			`set id ${fstSet.id} is not the digest of its members, ${artifactSetID(members)}`,
		])

		expect(artifactSetProblems(fstSet, [MORPHOLOGY_FST])).toContain(`member ${MORPHOLOGY_PAIRS.id} has no manifest`)
	})
})

describe("readerIncompatibility", () => {
	const reader = {
		role: ServingRole.AddressPoints,
		schemaVersions: [1],
		normalizations: [{ algorithm: "street-key", version: "1", locale: "de" }],
	}

	it("opens the multi-country region with a matching normalization", () => {
		expect(readerIncompatibility(DACH_OSM, reader)).toBeNull()
	})

	it("refuses an unsupported normalization instead of choosing a default", () => {
		expect(readerIncompatibility(FR_BAN, reader)).toMatch(/normalization .* is unsupported/)
	})

	it("refuses an unsupported schema version", () => {
		expect(readerIncompatibility({ ...DACH_OSM, schemaVersion: 2 }, reader)).toMatch(/schema 2 is unsupported/)
	})
})
