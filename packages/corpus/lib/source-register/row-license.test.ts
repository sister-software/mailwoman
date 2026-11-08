/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The license id a corpus row's `license` column holds, read from the register.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import type { LicenseDecision } from "@mailwoman/core/license/decision"
import { beforeAll, describe, expect, it } from "vitest"

import {
	type CorpusSourceInput,
	type CorpusSourceInputsFile,
	corpusSourceInputsPath,
	indexCorpusSourceInputs,
} from "#source-register/corpus-inputs"
import { requiredAttributions } from "#source-register/effective-manifest"
import { addressSourceRegisterPath } from "#source-register/register"
import {
	committedRowLicenses,
	createRowLicenses,
	decisionLicenseID,
	inputDecisions,
	type RowLicenses,
} from "#source-register/row-license"
import type { AddressSourceRegister } from "#source-register/types"
import { createLicenseVerdictCache, LicensePolicy } from "#utils/license"

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
		const file = await readLocalJSONFile<CorpusSourceInputsFile>(corpusSourceInputsPath())

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

/**
 * The corpus sources whose rows join text from a share-alike register input with
 * text from another publication, each with the rows that do it.
 *
 * Every other source that reads a share-alike input reads only that input,
 * so its rows stay separate from every other publication's (#2559).
 */
const JOINS_SHARE_ALIKE: ReadonlyMap<string, string> = new Map([
	["coarse-placer-cn-units", "CN rows of the coarse-placer sample, some from osm-cn, rendered with GeoNames places"],
	["spliced-sub-venue", "OpenStreetMap venue and sub-venue names spliced onto other publishers' address skeletons"],
])

describe("a corpus source reading a share-alike input", () => {
	const shareAlikeFree = createLicenseVerdictCache(LicensePolicy.ShareAlikeFree, [])
	let committed: RowLicenses
	let readers: Array<{ source: string; shareAlike: string[]; joinsOthers: boolean }>

	beforeAll(async () => {
		const file = await readLocalJSONFile<CorpusSourceInputsFile>(corpusSourceInputsPath())
		const committedRegister = await readLocalJSONFile<AddressSourceRegister>(addressSourceRegisterPath())
		const decisions = new Map(committedRegister.licenses.map((decision) => [decision.licenseID, decision]))

		committed = await committedRowLicenses()

		// The verdict a share-alike-free build reaches on the decision's own id is what makes an input share-alike.
		const shareAlikeIDs = (read: readonly CorpusSourceInput[]): string[] =>
			inputDecisions(read, decisions)
				.found.map(decisionLicenseID)
				.filter((id) => shareAlikeFree.read(id).refusal)

		readers = Object.entries(file.sources).flatMap(([source, mapping]) => {
			const shareAlike = shareAlikeIDs(mapping.inputs)
			const others = mapping.inputs.filter((each) => !shareAlikeIDs([each]).length)

			return shareAlike.length ? [{ source, shareAlike, joinsOthers: others.length > 0 }] : []
		})
	})

	it("is found in the committed table, so the checks below read real sources", () => {
		expect(readers.map((reader) => reader.source)).toContain("osm")
	})

	it("joins another publication's text only where JOINS_SHARE_ALIKE records it", () => {
		const joined = readers.filter((reader) => reader.joinsOthers).map((reader) => reader.source)

		// A new entry is a new recipe putting share-alike text into rows with another publication's.
		// Record why in JOINS_SHARE_ALIKE, after confirming the two checks below hold for it.
		expect(joined.toSorted()).toEqual([...JOINS_SHARE_ALIKE.keys()].toSorted())
	})

	it("stamps a license column a share-alike-free build refuses", () => {
		const admitted = readers.filter((reader) => !shareAlikeFree.read(committed.licenseOf(reader.source)!).refusal)

		expect(admitted.map((reader) => reader.source)).toEqual([])
	})

	it("joins the attribution group of each share-alike license it reads", () => {
		const records = readers.map((reader) => ({
			source: reader.source,
			corpusRows: 1,
			license: committed.licenseOf(reader.source)!,
			weight: 1,
			drawnRows: 1,
			emittedRows: 1,
			augmentExcluded: false,
			excludedBecause: null,
		}))

		const groups = new Map(requiredAttributions(records).map((group) => [group.license, new Set(group.sources)]))

		const uncredited = readers.flatMap((reader) =>
			reader.shareAlike.filter((id) => !groups.get(id)?.has(reader.source)).map((id) => `${reader.source}: ${id}`)
		)

		expect(uncredited).toEqual([])
	})
})
