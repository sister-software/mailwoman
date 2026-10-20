/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The license id a corpus row's `license` column holds, read from the register.
 */

import { describe, expect, it } from "vitest"

import { indexCorpusSourceInputs } from "#source-register/corpus-inputs"
import { committedRowLicenses, createRowLicenses, decisionLicenseID } from "#source-register/row-license"
import type { AddressSourceRegister, LicenseDecision } from "#source-register/types"

const ELECTED = { licenseID: "ogl-gb", state: "elected", electedTerms: "OGL v3", spdx: "OGL-UK-3.0" } as LicenseDecision
const UNSTATED = { licenseID: "lo-fr", state: "elected", electedTerms: "Licence Ouverte" } as LicenseDecision
const UNCHECKED = { licenseID: "unchecked-us-census", state: "unchecked" } as LicenseDecision

const register: Pick<AddressSourceRegister, "licenses"> = { licenses: [ELECTED, UNSTATED, UNCHECKED] }

const input = (license: string) => ({ registerSource: `${license}-source`, license, reads: "fixture" })

const inputs = indexCorpusSourceInputs({
	sources: {
		gb: { inputs: [input("ogl-gb")] },
		mixed: { aliases: ["synth-mixed"], inputs: [input("unchecked-us-census"), input("ogl-gb"), input("ogl-gb")] },
		fr: { inputs: [input("lo-fr")] },
		authored: { inputs: [], authored: ["a hand-written table"] },
		stray: { inputs: [input("no-such-decision")] },
	},
})

describe("decisionLicenseID", () => {
	it("takes an elected SPDX identifier and names every other decision by its own key", () => {
		expect(decisionLicenseID(ELECTED)).toBe("OGL-UK-3.0")
		expect(decisionLicenseID(UNSTATED)).toBe("LicenseRef-lo-fr")
		expect(decisionLicenseID(UNCHECKED)).toBe("LicenseRef-unchecked-us-census")
	})
})

describe("createRowLicenses", () => {
	const licenses = createRowLicenses(register, inputs)

	it("joins a source's distinct input ids with AND, under every spelling", () => {
		expect(licenses.licenseOf("gb")).toBe("OGL-UK-3.0")
		expect(licenses.licenseOf("mixed")).toBe("LicenseRef-unchecked-us-census AND OGL-UK-3.0")
		expect(licenses.licenseOf("synth-mixed")).toBe(licenses.licenseOf("mixed"))
		expect(licenses.licenseOf("fr")).toBe("LicenseRef-lo-fr")
	})

	it("answers null for a source with no register input, and require refuses it", () => {
		expect(licenses.licenseOf("authored")).toBeNull()
		expect(licenses.licenseOf("unmapped")).toBeNull()
		expect(() => licenses.require("authored", "fixture")).toThrow(/maps the source to no register source/u)
		expect(() => licenses.require("unmapped", "fixture")).toThrow(/does not map the source/u)
	})

	it("refuses an input naming a decision the register does not declare", () => {
		expect(() => licenses.licenseOf("stray")).toThrow(/does not declare/u)
	})
})

describe("committedRowLicenses", () => {
	it("gives every source with a register input an SPDX or LicenseRef id, and none to an authored-only source", async () => {
		const committed = await committedRowLicenses()
		const { readLocalJSONFile } = await import("@mailwoman/core/fs/readers")
		const { corpusSourceInputsPath } = await import("#source-register/corpus-inputs")
		const file = await readLocalJSONFile<{ sources: Record<string, { inputs: unknown[] }> }>(corpusSourceInputsPath())

		for (const [source, mapping] of Object.entries(file.sources)) {
			const id = committed.licenseOf(source)

			if (!mapping.inputs.length) {
				expect(id, source).toBeNull()

				continue
			}

			for (const term of id!.split(" AND ")) {
				expect(term, source).toMatch(/^(LicenseRef-[A-Za-z0-9.-]+|[A-Za-z0-9][A-Za-z0-9.+-]*)$/u)
			}
		}
	})
})
