import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { describe, expect, it } from "vitest"

import { CURRENT_RELEASE_SPEC } from "#tools/eval-harness/release/current-spec"
import { type ReleaseRequirementSpec, validateReleaseSpec } from "#tools/eval-harness/release/requirements"

const committedPath = new URL("specs/release-requirements.v4.json", import.meta.url).pathname
const specRecord = (version: number) => new URL(`specs/release-requirements.v${version}.json`, import.meta.url).pathname

describe("validateReleaseSpec", () => {
	it("accepts the current v4 specification with every requirement registered and per-check admission", async () => {
		expect(CURRENT_RELEASE_SPEC).toMatch(/release-requirements\.v4\.json$/u)

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
		const v4 = await readLocalJSONFile<ReleaseRequirementSpec>(committedPath)

		expect(v4.requirements).toEqual(v3.requirements)
		expect(v4.objective).toEqual(v3.objective)
		expect(v4.statistics).toEqual(v3.statistics)
		expect(v4.identities.published).toEqual(v3.identities.published)
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

		spec.statistics.multipleComparison = "holm-ish" as never

		expect(() => validateReleaseSpec(spec)).toThrow(/unknown method holm-ish/u)
	})

	it("refuses a requirement whose minimum is omitted rather than null", async () => {
		const spec = await readLocalJSONFile<ReleaseRequirementSpec>(committedPath)

		spec.requirements = [{ id: "us", kind: "country", country: "US", reason: "t" } as never]

		expect(() => validateReleaseSpec(spec)).toThrow(/minimum must be present/u)
	})

	it("refuses a malformed artifact digest", async () => {
		const spec = await readLocalJSONFile<ReleaseRequirementSpec>(committedPath)

		spec.identities.candidate.sha256 = "ABC"

		expect(() => validateReleaseSpec(spec)).toThrow(/candidate.sha256/u)
	})
})
