import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { describe, expect, it } from "vitest"

import { type ReleaseRequirementSpec, validateReleaseSpec } from "#tools/eval-harness/release/requirements"

const committedPath = new URL("specs/release-requirements.v1.json", import.meta.url).pathname

describe("validateReleaseSpec", () => {
	it("accepts the committed first specification with every threshold unregistered", async () => {
		const spec = validateReleaseSpec(await readLocalJSONFile<unknown>(committedPath))

		expect(spec.objective.minimumImprovement).toBeNull()
		expect(spec.statistics.confidenceLevel).toBeNull()
		expect(spec.requirements.every((req) => req.minimum === null)).toBe(true)
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
