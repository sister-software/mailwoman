// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { LicenseDecision } from "@mailwoman/core/license/decision"
import { registerRowTerms, type RegisterTermsInput } from "@mailwoman/corpus/source-register/terms"
import type { USAddressSourceTermsReader } from "@mailwoman/corpus/us/address-records/source-terms"
import { describe, expect, it } from "vitest"

import {
	describeMixedAddressLayer,
	isMixedLicenseExpression,
	ObligationClass,
	renderAttributionNotice,
	tallyObligationClasses,
	type LayerFileReader,
} from "#data/mixed-layer"

const VERSION = "2026-11-13"

const redistribute = (basis: "publisher-grant" | "other-documented") => ({
	"redistribute-data": { permission: "permitted" as const, basis, because: "Read." },
})

const LICENSES: LicenseDecision[] = [
	{
		licenseID: "dc-cc-by",
		state: "elected",
		electedTerms: "Creative Commons Attribution 4.0 International",
		spdx: "CC-BY-4.0",
		retrievedCopy: "receipts/dc/",
		electedBecause: "CC BY 4.0.",
		operations: redistribute("publisher-grant"),
	},
	{
		licenseID: "alachua-facts",
		state: "elected",
		electedTerms: "US factual data published without a use restriction",
		retrievedCopy: "receipts/alachua/",
		electedBecause: "Every field read is empty.",
		reading: { url: "https://www.arcgis.com/sharing/rest/content/items/8c82?f=json", found: "no-statement" },
		operations: redistribute("other-documented"),
	},
	{ licenseID: "cook-refused", state: "refused", refusedBecause: "The county withholds redistribution." },
	{
		licenseID: "overture-terms",
		state: "elected",
		electedTerms: "Overture Maps per-theme terms: Addresses theme under each source's own licence",
		retrievedCopy: "receipts/overture/",
		electedBecause: "Overture grants no licence of its own over the addresses.",
		operations: redistribute("publisher-grant"),
	},
]

const REGISTER: RegisterTermsInput = {
	sources: [
		{ sourceID: "us-dc", license: "dc-cc-by", publisher: "District of Columbia", name: "dc" },
		{ sourceID: "us-alachua", license: "alachua-facts", publisher: "Alachua County GIS", name: "alachua" },
		{ sourceID: "us-cook", license: "cook-refused", publisher: "Cook County", name: "cook" },
		{ sourceID: "us-overture", license: "overture-terms", publisher: "Overture Maps Foundation", name: "overture" },
	],
	licenses: LICENSES,
}

const TABLE: Record<string, string[]> = {
	"openaddresses:us/dc/statewide": ["us-dc"],
	"openaddresses:us/fl/alachua": ["us-alachua"],
	"openaddresses:us/il/cook": ["us-cook"],
	"overture:OpenAddresses/FL/Alachua County": ["us-alachua", "us-overture"],
	"overture:OpenAddresses/IL/Cook County": ["us-overture", "us-cook"],
}

const terms: USAddressSourceTermsReader = (source) => ({
	source,
	rows: (TABLE[source] ?? []).map((row) => registerRowTerms(REGISTER, row)),
})

const FILES: Record<string, unknown> = {
	[`addresses/us/${VERSION}/manifest.json`]: {
		country: "US",
		version: VERSION,
		splitRows: 10_000_000,
		regions: [
			{ region: "us-fl", subdivision: "US-FL", records: 0, lookup: { path: `addresses/us-fl/${VERSION}/lookup.db` } },
			{ region: "us-il", subdivision: "US-IL", records: 0, lookup: { path: `addresses/us-il/${VERSION}/lookup.db` } },
		],
	},
	[`addresses/us-fl/${VERSION}/ATTRIBUTION.json`]: [
		{
			source: "openaddresses:us/fl/alachua",
			authority: null,
			records: 100,
			license: null,
			recorded: { attribution: true, "attribution name": "Alachua County" },
		},
		{ source: "openaddresses:us/dc/statewide", authority: null, records: 7, license: null, recorded: null },
		{ source: "openaddresses:us/fl/unmapped", authority: null, records: 40, license: null, recorded: null },
	],
	[`addresses/us-il/${VERSION}/ATTRIBUTION.json`]: [
		{ source: "openaddresses:us/il/cook", authority: null, records: 900, license: null, recorded: null },
		{ source: "openaddresses:us/fl/alachua", authority: null, records: 1, license: null, recorded: null },
		{ source: "overture:OpenAddresses/FL/Alachua County", authority: null, records: 3, license: null, recorded: null },
		{ source: "overture:OpenAddresses/IL/Cook County", authority: null, records: 2, license: null, recorded: null },
	],
}

const reader: LayerFileReader = {
	origin: "fixture/",
	readJSON: async (path) => {
		if (!(path in FILES)) throw new Error(`${path} is absent`)

		return FILES[path]
	},
	exists: async (path) => path in FILES,
}

const describeFixture = () =>
	describeMixedAddressLayer({ license: "LicenseRef-US-Mixed", version: VERSION, read: reader, terms })

describe("describeMixedAddressLayer", () => {
	it("sums each source over its regions and keeps a source the register does not cover", async () => {
		const description = await describeFixture()

		expect(description.sources.map((source) => source.source)).toEqual([
			"openaddresses:us/dc/statewide",
			"openaddresses:us/fl/alachua",
			"openaddresses:us/fl/unmapped",
			"openaddresses:us/il/cook",
			"overture:OpenAddresses/FL/Alachua County",
			"overture:OpenAddresses/IL/Cook County",
		])

		const alachua = description.sources.find((source) => source.source === "openaddresses:us/fl/alachua")!

		expect(alachua).toMatchObject({ records: 101, regions: ["us-fl", "us-il"], publisher: "Alachua County GIS" })
		expect(description.records).toBe(1053)

		const unmapped = description.sources.find((source) => source.source === "openaddresses:us/fl/unmapped")!

		expect(unmapped).toMatchObject({
			rows: [],
			deciding: null,
			basis: "unregistered",
			attribution: "unknown",
			obligationClass: ObligationClass.Unknown,
		})
	})

	it("reads each source's obligations from the register's reading, not from the layer's one expression", async () => {
		const byID = Object.fromEntries((await describeFixture()).sources.map((source) => [source.source, source]))

		// CC BY 4.0 requires attribution.
		expect(byID["openaddresses:us/dc/statewide"]).toMatchObject({
			spdx: "CC-BY-4.0",
			attribution: "required",
			obligationClass: ObligationClass.Attribution,
		})

		// The register's reading imposes `none`, and OpenAddresses' summary records a credit.
		expect(byID["openaddresses:us/fl/alachua"]).toMatchObject({
			basis: "no-restricting-terms",
			statement: "no-statement",
			attribution: "recorded",
			attributionText: "Alachua County",
		})

		// A refused source's terms restrict use, and the register records them as a refusal only.
		expect(byID["openaddresses:us/il/cook"]).toMatchObject({
			basis: "refused",
			obligationClass: ObligationClass.Unknown,
		})
	})

	it("takes an aggregated row's obligations from its publishing body, and lets the aggregator decide only by blocking", async () => {
		const byID = Object.fromEntries((await describeFixture()).sources.map((source) => [source.source, source]))

		// Overture's own row states terms in its words, and no table reads them.
		// The body's reading governs the row.
		expect(byID["overture:OpenAddresses/FL/Alachua County"]).toMatchObject({
			publisher: "Alachua County GIS",
			basis: "no-restricting-terms",
			obligationClass: ObligationClass.None,
		})

		// The body's refusal decides even where the aggregator's row comes first.
		expect(byID["overture:OpenAddresses/IL/Cook County"]).toMatchObject({
			basis: "refused",
			deciding: expect.objectContaining({ registerSource: "us-cook" }),
		})
	})

	it("throws naming a region whose ledger is missing, rather than describing fewer sources", async () => {
		const missing: LayerFileReader = {
			...reader,
			readJSON: async (path) => {
				if (path.includes("us-il")) throw new Error(`${path} is absent`)

				return reader.readJSON(path)
			},
		}

		await expect(
			describeMixedAddressLayer({ license: "LicenseRef-US-Mixed", version: VERSION, read: missing, terms })
		).rejects.toThrow(`addresses/us-il/${VERSION}/ATTRIBUTION.json is absent`)
	})
})

describe("tallyObligationClasses", () => {
	it("counts every class, so a class with no sources reads as zero rather than missing", async () => {
		const tally = tallyObligationClasses(await describeFixture())

		expect(Object.fromEntries(tally.map((entry) => [entry.obligationClass, entry.sources]))).toEqual({
			[ObligationClass.Unknown]: 3,
			[ObligationClass.ShareAlike]: 0,
			[ObligationClass.Attribution]: 1,
			[ObligationClass.AttributionRecorded]: 1,
			[ObligationClass.None]: 1,
		})
	})
})

describe("renderAttributionNotice", () => {
	it("credits every required and recorded source, lists the unknown ones, and is the same text twice", async () => {
		const notice = renderAttributionNotice(await describeFixture())

		expect(notice).toContain("District of Columbia [openaddresses:us/dc/statewide]")
		expect(notice).toContain("Alachua County [openaddresses:us/fl/alachua]")
		expect(notice).toContain("Cook County [openaddresses:us/il/cook]")
		expect(notice).toContain("(no publisher recorded) [openaddresses:us/fl/unmapped]")
		// An unknown share-alike term is listed with the unknown sources, never as a share-alike source.
		expect(notice).not.toContain("share-alike terms")
		expect(renderAttributionNotice(await describeFixture())).toBe(notice)
	})
})

describe("isMixedLicenseExpression", () => {
	it("matches a mixed identifier inside a compound expression and nothing else", () => {
		expect(isMixedLicenseExpression("LicenseRef-WhosOnFirst-Mixed AND ODbL-1.0")).toBe(true)
		expect(isMixedLicenseExpression("LicenseRef-US-Mixed")).toBe(true)

		expect(isMixedLicenseExpression("LicenseRef-USGov-Public-Domain AND LicenseRef-OpenAddresses-PerSource")).toBe(
			false
		)
	})
})
