/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { LicenseReviewState, OperationPermission, PermissionBasis } from "@mailwoman/core/license/decision"
import { describe, expect, it } from "vitest"

import { Basemap, BASEMAP_INPUTS, CITY_MODEL_INPUTS, creditsFor, HILLSHADE_INPUTS } from "#basemaps"
import { basemapBOMComponent } from "#bom"
import { auditStructureRegister, publishProblems, STRUCTURE_SOURCE_REGISTER } from "#register"
import { PUBLISH_OPERATIONS, StructureDetail, type StructureSourceRegister } from "#types"

const SOURCE = {
	sourceID: "zz-example",
	jurisdiction: "zz",
	name: "Example city model",
	publisher: "Example publisher",
	datasetURL: "https://example.test/city-model",
	detail: [StructureDetail.LoD2],
	formats: ["CityGML"],
	license: "zz-example",
}

describe("STRUCTURE_SOURCE_REGISTER", () => {
	it("passes its own audit", () => {
		expect(auditStructureRegister()).toEqual([])
	})

	it("admits no source before a reviewer elects its terms", () => {
		for (const source of STRUCTURE_SOURCE_REGISTER.sources) {
			const decision = STRUCTURE_SOURCE_REGISTER.licenses.find((entry) => entry.licenseID === source.license)

			if (decision?.state === LicenseReviewState.Elected) continue
			expect(publishProblems(source), source.sourceID).not.toEqual([])
		}
	})
})

describe("publishProblems", () => {
	it("admits a source whose elected terms permit every publishing operation", () => {
		const register: StructureSourceRegister = {
			sources: [SOURCE],
			licenses: [
				{
					licenseID: "zz-example",
					state: LicenseReviewState.Elected,
					electedTerms: "Example Open Licence 1.0",
					retrievedCopy: "data/licenses/zz-example.txt",
					electedBecause: "the only grant the publisher offers",
					operations: Object.fromEntries(
						PUBLISH_OPERATIONS.map((operation) => [
							operation,
							{ permission: OperationPermission.Permitted, basis: PermissionBasis.PublisherGrant, because: "§2" },
						])
					),
				},
			],
		}

		expect(publishProblems(SOURCE, register)).toEqual([])
		expect(auditStructureRegister(register)).toEqual([])
	})

	it("names each operation the elected terms leave unreviewed", () => {
		const register: StructureSourceRegister = {
			sources: [SOURCE],
			licenses: [
				{
					licenseID: "zz-example",
					state: LicenseReviewState.Elected,
					electedTerms: "Example Open Licence 1.0",
					retrievedCopy: "data/licenses/zz-example.txt",
					electedBecause: "the only grant the publisher offers",
					operations: {
						fetch: { permission: OperationPermission.Permitted, basis: PermissionBasis.PublisherGrant, because: "§2" },
					},
				},
			],
		}

		expect(publishProblems(SOURCE, register)).toHaveLength(PUBLISH_OPERATIONS.length - 1)
	})
})

describe("basemapBOMComponent", () => {
	it("lists every input with its elected license and credit", () => {
		const component = basemapBOMComponent({
			basemap: Basemap.MailwomanBuild,
			url: "https://public.mailwoman.ai/protomaps/builds/japan-2026-10-22.pmtiles",
			version: "2026-10-22",
			license: "ODbL-1.0",
		})

		const licenses = Object.fromEntries(
			component.properties.filter((p) => p.name.endsWith(":license")).map((p) => [p.name, p.value])
		)

		expect(component.licenses).toEqual([{ expression: "ODbL-1.0" }])
		expect(Object.keys(licenses)).toHaveLength(BASEMAP_INPUTS[Basemap.MailwomanBuild].length)
		expect(licenses["mailwoman:input:international-osm:license"]).toBe("ODbL-1.0")
		expect(licenses["mailwoman:input:international-meta-wri-chm:license"]).toBe("CC-BY-4.0")
	})
})

describe("creditsFor", () => {
	it("returns a credit for every input of every basemap and the hillshade", () => {
		for (const inputs of [...Object.values(BASEMAP_INPUTS), HILLSHADE_INPUTS, CITY_MODEL_INPUTS]) {
			expect(creditsFor(inputs).map((credit) => credit.sourceID)).toEqual(inputs)
		}
	})

	it("refuses a source the register does not hold", () => {
		expect(() => creditsFor(["zz-missing"])).toThrow("zz-missing")
	})
})

describe("auditStructureRegister", () => {
	it("reports a region outside the source's jurisdiction and a dangling license", () => {
		const problems = auditStructureRegister({
			sources: [{ ...SOURCE, region: "DE-HH", license: "missing" }],
			licenses: [],
		})

		expect(problems).toContain('source "zz-example" has region "DE-HH" outside its jurisdiction')
		expect(problems).toContain('source "zz-example" points at license "missing", which is not declared')
	})
})
