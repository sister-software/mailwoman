// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { describe, expect, it } from "vitest"

import { CURRENT_RELEASE_SPEC, releaseSpecPath } from "#tools/eval-harness/release/current-spec"
import {
	capabilityProbeSources,
	PENDING_COLLECTION_SUFFIX,
	type ReleaseRequirementSpec,
	validateReleaseSpec,
} from "#tools/eval-harness/release/requirements"

const committedPath = CURRENT_RELEASE_SPEC

describe("validateReleaseSpec", () => {
	it("accepts the current v17 specification with every threshold registered and per-check admission", async () => {
		expect(CURRENT_RELEASE_SPEC).toMatch(/release-requirements\.v17\.json$/u)

		const spec = validateReleaseSpec(await readLocalJSONFile<unknown>(committedPath))

		expect(spec.schemaVersion).toBe(4)
		expect(spec.statistics.rowsIndependent).toBe(false)
		expect(spec.statistics.confidenceLevel).not.toBeNull()
		expect(spec.objective.minimumImprovement).not.toBeNull()
		expect(spec.requirements.length).toBeGreaterThan(0)
		expect(spec.requirements.every((req) => (req.kind === "geocode" ? req.maxLoss : req.minimum) !== null)).toBe(true)

		expect(spec.provenance.admitted).toEqual({
			minimum: ["verified_unseen", "unseen_by_candidate"],
			comparative: ["verified_unseen"],
		})
	})

	it("names as capability probes the sources of po_box_cedex, postal_unit, venue_unit and country_token", async () => {
		const spec = validateReleaseSpec(await readLocalJSONFile<unknown>(committedPath))
		const probes = capabilityProbeSources(spec)

		for (const id of ["po_box_cedex", "postal_unit", "venue_unit", "country_token"]) {
			const req = spec.requirements.find((candidate) => candidate.id === id)

			expect(req?.kind, id).toBe("capability")
			expect(req!.select!.sources!.length, id).toBeGreaterThan(0)

			for (const source of req!.select!.sources!) {
				expect(probes.has(source), source).toBe(true)
			}
		}

		expect(probes.has("invented-postal-guideline")).toBe(true)
		expect(probes.has("invented-postal-unit-guideline")).toBe(true)
	})

	it("refuses a collection pinned as a placeholder until it is frozen", async () => {
		const spec = await readLocalJSONFile<ReleaseRequirementSpec>(committedPath)
		const pending = `heldout-confirm-v0.8.20${PENDING_COLLECTION_SUFFIX}`

		expect(() =>
			validateReleaseSpec({
				...spec,
				evaluations: { ...spec.evaluations, confirmation: { ...spec.evaluations.confirmation, ids: [pending] } },
			})
		).toThrow(/holds the placeholder heldout-confirm-v0\.8\.20@pending/u)
	})

	it("registers the v8.9.0 candidate in v13 and keeps every other v12 value", async () => {
		const v12 = validateReleaseSpec(await readLocalJSONFile<unknown>(releaseSpecPath(12)))
		const v13 = validateReleaseSpec(await readLocalJSONFile<unknown>(releaseSpecPath(13)))

		const unchanged = (spec: ReleaseRequirementSpec) => ({
			...spec,
			specVersion: null,
			rationale: null,
			identities: { ...spec.identities, candidate: null },
		})

		expect(unchanged(v13)).toEqual(unchanged(v12))
		expect(v13.identities.candidate.sha256).toBe("d51bb0efa5a61e5fc7233b94f0f7c9946be988100b230bc6b17c40808112b39f")
		expect(v13.rationale).toMatch(/Reads of v12/u)
	})

	it("refuses a role pin in the schema 3 shape, an empty role and a dataset id pinned twice in one role", async () => {
		const spec = await readLocalJSONFile<Record<string, Record<string, Record<string, unknown>>>>(committedPath)
		const ids = spec.evaluations!.development!.ids as string[]

		expect(() =>
			validateReleaseSpec({
				...spec,
				evaluations: { ...spec.evaluations, development: { id: ids[0], description: "d" } },
			})
		).toThrow(/schema 3's single pin/u)

		expect(() =>
			validateReleaseSpec({ ...spec, evaluations: { ...spec.evaluations, development: { ids: [], description: "d" } } })
		).toThrow(/development.ids must be a non-empty array/u)

		const twice = ids[0]!.replace(/@[0-9a-f]{16}$/u, "@0000000000000000")

		expect(() =>
			validateReleaseSpec({
				...spec,
				evaluations: { ...spec.evaluations, development: { ids: [ids[0], twice], description: "d" } },
			})
		).toThrow(/pins heldout-dev-v0.8.18 a second time/u)

		expect(() =>
			validateReleaseSpec({ ...spec, identities: { ...spec.identities, dataset: { id: ids[0], sha256: null } } })
		).toThrow(/a single object is schema 3/u)
	})

	it("refuses a geocode requirement with a minimum and a withoutTags tag outside the schema", async () => {
		const spec = await readLocalJSONFile<ReleaseRequirementSpec>(committedPath)
		const geocode = spec.requirements.find((req) => req.kind === "geocode")!

		expect(() => validateReleaseSpec({ ...spec, requirements: [{ ...geocode, minimum: 0.9 }] })).toThrow(
			/registers no minimum/u
		)

		expect(() =>
			validateReleaseSpec({
				...spec,
				requirements: [{ ...geocode, sameModelAdmitted: ["verified_unseen", "unknown"] }],
			})
		).toThrow(/admits unknown/u)

		const postalUnit = spec.requirements.find((req) => req.id === "postal_unit")!

		expect(() =>
			validateReleaseSpec({
				...spec,
				requirements: [{ ...postalUnit, select: { ...postalUnit.select, withoutTags: ["named_complex"] } }],
			})
		).toThrow(/withoutTags\[0\] must be one of/u)
	})

	it("refuses the earlier schema records: single admitted lists through schema 2, single pins in schema 3", async () => {
		for (const version of [2, 3, 4, 5, 6, 7, 8]) {
			await expect(
				readLocalJSONFile<unknown>(releaseSpecPath(version)).then((s) => validateReleaseSpec(s))
			).rejects.toThrow(/schemaVersion must be 4/u)
		}

		const spec = await readLocalJSONFile<Record<string, Record<string, unknown>>>(committedPath)

		spec.provenance!.admitted = ["verified_unseen"]

		expect(() => validateReleaseSpec(spec)).toThrow(/single list, retired in schema 3/u)
	})

	it("refuses a comparative class that minimum checks do not admit or that one model may have trained on", async () => {
		const spec = await readLocalJSONFile<ReleaseRequirementSpec>(committedPath)

		spec.provenance.admitted = { minimum: ["unseen_by_candidate"], comparative: ["verified_unseen"] }

		expect(() => validateReleaseSpec(spec)).toThrow(/minimum checks do not admit/u)

		spec.provenance.admitted = { minimum: ["unseen_by_candidate"], comparative: ["unseen_by_candidate"] }

		expect(() => validateReleaseSpec(spec)).toThrow(/not established unseen by the published model/u)
	})

	it("refuses a specification that omits rowsIndependent", async () => {
		const spec = await readLocalJSONFile<Record<string, Record<string, unknown>>>(committedPath)

		delete spec.statistics!.rowsIndependent

		expect(() => validateReleaseSpec(spec)).toThrow(/rowsIndependent must be present/u)
	})

	it("refuses the retired resampling fields", async () => {
		const spec = await readLocalJSONFile<Record<string, Record<string, unknown>>>(committedPath)

		spec.statistics!.resamples = 2000

		expect(() => validateReleaseSpec(spec)).toThrow(/resamples is retired/u)
	})

	it("refuses an unknown multiple-comparison method", async () => {
		const spec = await readLocalJSONFile<ReleaseRequirementSpec>(committedPath)

		const malformed = { ...spec, statistics: { ...spec.statistics, multipleComparison: "holm-ish" } }

		expect(() => validateReleaseSpec(malformed)).toThrow(/unknown method holm-ish/u)
	})

	it("refuses a requirement whose minimum is omitted rather than null", async () => {
		const spec = await readLocalJSONFile<ReleaseRequirementSpec>(committedPath)

		const malformed = { ...spec, requirements: [{ id: "us", kind: "country", country: "US", reason: "t" }] }

		expect(() => validateReleaseSpec(malformed)).toThrow(/minimum must be present/u)
	})

	it("refuses a malformed artifact digest", async () => {
		const spec = await readLocalJSONFile<ReleaseRequirementSpec>(committedPath)

		spec.identities.candidate.sha256 = "ABC"

		expect(() => validateReleaseSpec(spec)).toThrow(/candidate.sha256/u)
	})
})
