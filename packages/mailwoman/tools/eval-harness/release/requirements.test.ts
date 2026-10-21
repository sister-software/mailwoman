import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { describe, expect, it } from "vitest"

import { CURRENT_RELEASE_SPEC } from "#tools/eval-harness/release/current-spec"
import { type ReleaseRequirementSpec, validateReleaseSpec } from "#tools/eval-harness/release/requirements"

const committedPath = new URL("specs/release-requirements.v7.json", import.meta.url).pathname
const specRecord = (version: number) => new URL(`specs/release-requirements.v${version}.json`, import.meta.url).pathname

describe("validateReleaseSpec", () => {
	it("accepts the current v7 specification with every requirement registered and per-check admission", async () => {
		expect(CURRENT_RELEASE_SPEC).toMatch(/release-requirements\.v7\.json$/u)

		const spec = validateReleaseSpec(await readLocalJSONFile<unknown>(committedPath))

		expect(spec.schemaVersion).toBe(3)
		expect(spec.statistics.rowsIndependent).toBe(false)
		expect(spec.statistics.confidenceLevel).not.toBeNull()
		expect(spec.objective.minimumImprovement).not.toBeNull()
		expect(spec.requirements.length).toBeGreaterThan(0)
		expect(spec.requirements.every((req) => req.minimum !== null)).toBe(true)

		expect(spec.provenance.admitted).toEqual({
			minimum: ["verified_unseen", "unseen_by_candidate"],
			comparative: ["verified_unseen"],
		})
	})

	it("carries every v3 requirement value into v4 unchanged", async () => {
		const v3 = await readLocalJSONFile<ReleaseRequirementSpec>(specRecord(3))
		const v4 = await readLocalJSONFile<ReleaseRequirementSpec>(specRecord(4))

		expect(v4.requirements).toEqual(v3.requirements)
		expect(v4.objective).toEqual(v3.objective)
		expect(v4.statistics).toEqual(v3.statistics)
		expect(v4.identities.published).toEqual(v3.identities.published)
	})

	it("differs from v4 only in the po_box_cedex source selector, the rationale and the version", async () => {
		const v4 = await readLocalJSONFile<ReleaseRequirementSpec>(specRecord(4))
		const v5 = await readLocalJSONFile<ReleaseRequirementSpec>(specRecord(5))
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
		const v5 = await readLocalJSONFile<ReleaseRequirementSpec>(specRecord(5))
		const v6 = await readLocalJSONFile<ReleaseRequirementSpec>(specRecord(6))
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
		const v6 = await readLocalJSONFile<ReleaseRequirementSpec>(specRecord(6))
		const v7 = await readLocalJSONFile<ReleaseRequirementSpec>(committedPath)

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

	it("refuses the schema 2 records, which hold a single admitted list", async () => {
		for (const version of [2, 3]) {
			await expect(readLocalJSONFile<unknown>(specRecord(version)).then((s) => validateReleaseSpec(s))).rejects.toThrow(
				/schemaVersion must be 3/u
			)
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
