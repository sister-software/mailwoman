// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `identifiers` family from text to a typed recognition, through the WebAssembly engine.
 *
 *   The grammars and validators have their tests in the Rust crates.
 *   These tests hold the TypeScript boundary and the rule that a bare run of digits is a candidate.
 */

import { describe, expect, it } from "vitest"

import { isDeterministicIdentifier } from "#deterministic/identifiers"
import { identifiers } from "#identifiers"
import { createRecognizer } from "#index"

const recognizer = createRecognizer([identifiers])

function read(text: string) {
	return recognizer.recognize(text).recognitions
}

function payload(text: string, kind: string): unknown {
	const found = read(text).find((recognition) => recognition.kind === kind)

	return found?.validation.status === "validated" ? found.validation.payload : found?.validation
}

describe("the prefixed identifiers", () => {
	it("reads an H3 cell, with and without its prefix, in lower case", () => {
		expect(payload("8928308280FFFFF", "h3.cell")).toEqual({ cell: "8928308280fffff" })
		expect(payload("h3:8928308280fffff", "h3.prefixed_cell")).toEqual({ cell: "8928308280fffff" })
	})

	it("reads a geohash only behind its prefix", () => {
		expect(payload("gh:EZS42", "geohash.prefixed")).toEqual({ hash: "ezs42" })
		expect(read("ezs42")).toEqual([])
	})

	it("reads Who's On First references and Spelunker pages as numbers", () => {
		expect(payload("WOF 85633793", "wof.reference")).toEqual({ id: 85_633_793 })
		expect(payload("https://spelunker.whosonfirst.org/id/85633793/", "wof.spelunker_url")).toEqual({ id: 85_633_793 })

		expect(payload("wof:0", "wof.reference")).toMatchObject({
			status: "rejected",
			rejection: { code: "id_out_of_range" },
		})
	})

	it("reads a GNIS id only behind a prefix", () => {
		expect(payload("gnis:1234567", "gnis.reference")).toEqual({ id: 1_234_567 })
		expect(read("1234567").some((recognition) => recognition.kind.startsWith("gnis."))).toBe(false)
	})
})

describe("the Census GEOID", () => {
	it("reads each level and names its parts", () => {
		expect(payload("06037", "census.geoid_county")).toEqual({ level: "county", state: "06", county: "037" })

		expect(payload("060372047001002", "census.geoid_block")).toEqual({
			level: "block",
			state: "06",
			county: "037",
			tract: "204700",
			block_group: "1",
			block: "1002",
		})
	})

	it("refuses a state code that is not a FIPS code", () => {
		expect(payload("03037", "census.geoid_county")).toMatchObject({
			status: "rejected",
			rejection: { code: "unknown_state_fips" },
		})
	})
})

describe("when an identifier recognition may be trusted", () => {
	it("trusts a prefixed identifier and never a bare run of digits", () => {
		const trusted = (text: string, kind: string) => {
			const found = read(text).find((recognition) => recognition.kind === kind)

			return found ? isDeterministicIdentifier(found, text) : null
		}

		expect(trusted("wof:85633793", "wof.reference")).toBe(true)
		expect(trusted("06037", "census.geoid_county")).toBe(false)
		expect(trusted("8928308280fffff", "h3.cell")).toBe(false)
		expect(trusted("h3:8928308280fffff", "h3.prefixed_cell")).toBe(true)
	})
})
