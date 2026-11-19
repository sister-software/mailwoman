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

const committedPath = releaseSpecPath(13)

/**
 * The two fields schema 3 records hold as single pins.
 */
interface SchemaThreePins {
	identities: { dataset: { id: string | null; sha256: string | null } }
	evaluations: Record<"development" | "confirmation", { id: string | null; description: string }>
}

describe("validateReleaseSpec", () => {
	it("accepts the current v13 specification with every threshold registered and per-check admission", async () => {
		expect(CURRENT_RELEASE_SPEC).toMatch(/release-requirements\.v13\.json$/u)

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

	it("carries every v7 threshold into v8 and registers both evaluation collections", async () => {
		const v7 = await readLocalJSONFile<ReleaseRequirementSpec>(releaseSpecPath(7))

		const v8 = await readLocalJSONFile<Omit<ReleaseRequirementSpec, keyof SchemaThreePins> & SchemaThreePins>(
			releaseSpecPath(8)
		)

		expect(v8.requirements).toEqual(v7.requirements)
		expect(v8.objective).toEqual(v7.objective)
		expect(v8.statistics).toEqual(v7.statistics)
		expect(v8.identities.dataset.id).toBe(v8.evaluations.confirmation.id)
		expect(v8.evaluations.development.id).not.toBeNull()
	})

	it("differs from v8 in the listed collections, postal_unit's venue exclusion and the geocode check only", async () => {
		const v8 = await readLocalJSONFile<ReleaseRequirementSpec>(releaseSpecPath(8))
		const v9 = validateReleaseSpec(await readLocalJSONFile<unknown>(releaseSpecPath(9)))
		const byID = (spec: ReleaseRequirementSpec) => new Map(spec.requirements.map((req) => [req.id, req]))
		const before = byID(v8)
		const after = byID(v9)

		for (const [id, req] of before) {
			if (id === "postal_unit") continue

			expect(after.get(id), id).toEqual(req)
		}

		const postalUnit = after.get("postal_unit")!

		expect(postalUnit).toMatchObject({ minimum: 0.85, select: { withoutTags: ["venue"] } })

		expect({ ...postalUnit, reason: null, select: { ...postalUnit.select, withoutTags: undefined } }).toEqual({
			...before.get("postal_unit"),
			reason: null,
			select: { ...before.get("postal_unit")!.select, withoutTags: undefined },
		})

		expect([...after.keys()].filter((id) => !before.has(id))).toEqual(["geocode"])
		expect(after.get("geocode")).toMatchObject({ kind: "geocode", countries: v9.objective.countries, maxLoss: 0.01 })
		expect(v9.objective).toEqual(v8.objective)
		expect(v9.statistics).toEqual(v8.statistics)
		expect(v9.provenance).toEqual(v8.provenance)
		expect({ ...v9.identities, dataset: null }).toEqual({ ...v8.identities, dataset: null })
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

	it("differs from v9 in postal_unit's no-loss form and the development collection only", async () => {
		const v9 = validateReleaseSpec(await readLocalJSONFile<unknown>(releaseSpecPath(9)))
		const v10 = validateReleaseSpec(await readLocalJSONFile<unknown>(releaseSpecPath(10)))

		const byID = (spec: ReleaseRequirementSpec) => new Map(spec.requirements.map((req) => [req.id, req]))
		const before = byID(v9)
		const after = byID(v10)

		expect([...after.keys()]).toEqual([...before.keys()])

		for (const [id, req] of before) {
			if (id === "postal_unit") continue

			expect(after.get(id), id).toEqual(req)
		}

		const postalUnit = after.get("postal_unit")!

		expect("minimum" in postalUnit).toBe(false)
		expect(postalUnit).toMatchObject({ kind: "capability", maxLoss: 0, select: before.get("postal_unit")!.select })
		expect(v10.objective).toEqual(v9.objective)
		expect(v10.statistics).toEqual(v9.statistics)
		expect(v10.provenance).toEqual(v9.provenance)
		expect(v10.identities).toEqual(v9.identities)
		expect(v10.evaluations.confirmation.ids).toEqual(v9.evaluations.confirmation.ids)
		expect(v10.evaluations.development.ids).not.toEqual(v9.evaluations.development.ids)
		expect(v10.rationale).toMatch(/Confirmation reads before registration/u)
	})

	it("differs from v10 in the confirmation collections and the dataset identity only", async () => {
		const v10 = validateReleaseSpec(await readLocalJSONFile<unknown>(releaseSpecPath(10)))
		const v11 = validateReleaseSpec(await readLocalJSONFile<unknown>(releaseSpecPath(11)))

		expect(v11.requirements).toEqual(v10.requirements)
		expect(v11.objective).toEqual(v10.objective)
		expect(v11.statistics).toEqual(v10.statistics)
		expect(v11.provenance).toEqual(v10.provenance)
		expect({ ...v11.identities, dataset: null }).toEqual({ ...v10.identities, dataset: null })
		expect(v11.identities.candidate.sha256).toBeNull()
		expect(v11.evaluations.development.ids).toEqual(v10.evaluations.development.ids)
		expect(v11.identities.dataset.map((entry) => entry.id)).toEqual(v11.evaluations.confirmation.ids)

		const retired = new Set(v10.evaluations.confirmation.ids)

		expect(v11.evaluations.confirmation.ids.filter((id) => retired.has(id))).toEqual([])
		expect(v11.rationale).toMatch(/Confirmation reads before registration/u)
	})

	it("drafts v12 from v11 with an added development collection and no candidate", async () => {
		const v11 = validateReleaseSpec(await readLocalJSONFile<unknown>(releaseSpecPath(11)))
		const v12 = validateReleaseSpec(await readLocalJSONFile<unknown>(releaseSpecPath(12)))

		const development = (spec: ReleaseRequirementSpec) => ({
			...spec,
			specVersion: null,
			rationale: null,
			evaluations: { ...spec.evaluations, development: null },
		})

		expect(development(v12)).toEqual(development(v11))
		expect(v12.identities.candidate.sha256).toBeNull()
		expect(v12.evaluations.development.ids.slice(0, -1)).toEqual(v11.evaluations.development.ids)
		expect(v12.evaluations.development.ids.at(-1)).toMatch(/^heldout-dev-v0\.8\.21@/u)
		expect(v12.rationale).toMatch(/Reads of v11/u)
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

	it("pins each role's collections, and names the confirmation collections as the dataset identity", async () => {
		const v9 = validateReleaseSpec(await readLocalJSONFile<unknown>(releaseSpecPath(9)))

		expect(v9.evaluations.development.ids).toHaveLength(2)
		expect(v9.identities.dataset.map((entry) => entry.id)).toEqual(v9.evaluations.confirmation.ids)
		expect(v9.rationale).toMatch(/Confirmation reads before registration/u)
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

	it("carries every v3 requirement value into v4 unchanged", async () => {
		const v3 = await readLocalJSONFile<ReleaseRequirementSpec>(releaseSpecPath(3))
		const v4 = await readLocalJSONFile<ReleaseRequirementSpec>(releaseSpecPath(4))

		expect(v4.requirements).toEqual(v3.requirements)
		expect(v4.objective).toEqual(v3.objective)
		expect(v4.statistics).toEqual(v3.statistics)
		expect(v4.identities.published).toEqual(v3.identities.published)
	})

	it("differs from v4 only in the po_box_cedex source selector, the rationale and the version", async () => {
		const v4 = await readLocalJSONFile<ReleaseRequirementSpec>(releaseSpecPath(4))
		const v5 = await readLocalJSONFile<ReleaseRequirementSpec>(releaseSpecPath(5))
		const v4Selector = v4.requirements.find((req) => req.id === "po_box_cedex")!.select
		const v5Selector = v5.requirements.find((req) => req.id === "po_box_cedex")!.select

		expect(v5.specVersion).toBe("5")
		expect(v5.rationale).not.toBe(v4.rationale)
		expect(v5Selector?.sources).toEqual([...v4Selector!.sources!, "invented-postal-guideline"])

		const withoutChanges = (spec: ReleaseRequirementSpec) => ({
			...spec,
			specVersion: null,
			rationale: null,
			requirements: spec.requirements.map((req) =>
				req.id === "po_box_cedex" ? { ...req, select: { ...req.select, sources: null } } : req
			),
		})

		expect(withoutChanges(v5)).toEqual(withoutChanges(v4))
	})

	it("differs from v5 only by the postal_unit capability, the rationale and the version", async () => {
		const v5 = await readLocalJSONFile<ReleaseRequirementSpec>(releaseSpecPath(5))
		const v6 = await readLocalJSONFile<ReleaseRequirementSpec>(releaseSpecPath(6))
		const added = v6.requirements.filter((req) => !v5.requirements.some((old) => old.id === req.id))

		expect(v6.specVersion).toBe("6")
		expect(v6.rationale).not.toBe(v5.rationale)
		expect(v6.rationale).toMatch(/#2764/u)
		expect(v6.rationale).toMatch(/Bonferroni family from 14 checks .* to 15/u)

		expect(added).toEqual([
			expect.objectContaining({
				id: "postal_unit",
				kind: "capability",
				metric: "exact_parse",
				minimum: 0.85,
				select: { kinds: ["address"], sources: ["invented-postal-unit-guideline"] },
			}),
		])

		expect(added[0]!.reason).toMatch(/#2764/u)

		const withoutChanges = (spec: ReleaseRequirementSpec) => ({
			...spec,
			specVersion: null,
			rationale: null,
			requirements: spec.requirements.filter((req) => req.id !== "postal_unit"),
		})

		expect(withoutChanges(v6)).toEqual(withoutChanges(v5))
	})

	it("differs from v6 only in the scorer revision, the rationale and the version", async () => {
		const v6 = await readLocalJSONFile<ReleaseRequirementSpec>(releaseSpecPath(6))
		const v7 = await readLocalJSONFile<ReleaseRequirementSpec>(releaseSpecPath(7))

		expect(v7.specVersion).toBe("7")
		expect(v7.rationale).not.toBe(v6.rationale)
		expect(v7.rationale).toMatch(/Only the scorer's street normalization changed\. Every threshold is unchanged/u)
		expect(v7.identities.scorer.id).toBe(v6.identities.scorer.id)
		expect(v7.identities.scorer.revision).not.toBe(v6.identities.scorer.revision)

		const withoutChanges = (spec: ReleaseRequirementSpec) => ({
			...spec,
			specVersion: null,
			rationale: null,
			identities: { ...spec.identities, scorer: { ...spec.identities.scorer, revision: null } },
		})

		expect(withoutChanges(v7)).toEqual(withoutChanges(v6))
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
