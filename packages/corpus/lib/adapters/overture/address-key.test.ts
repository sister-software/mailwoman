// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file A re-run of the overture adapter that adds the region and regroups the postcode keys each row to the
 *   address key of the row it replaces.
 */

import { writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import { describe, expect, it } from "vitest"

import { createOvertureAdapter } from "#adapters/overture/adapter"
import { overtureAddressBlock, overtureAddressKey } from "#adapters/overture/address-key"
import { useScratchDir } from "#test-kit"
import type { CanonicalRow } from "#types"
import { alignRow } from "#utils"

const scratch = useScratchDir("ov-key")

async function render(country: string, rows: Record<string, unknown>[]): Promise<CanonicalRow[]> {
	const input = scratch.path(`overture-${country.toLowerCase()}.corpus.jsonl`)

	await writeLocalJSONLFile(rows, input)

	const rendered: CanonicalRow[] = []

	for await (const row of createOvertureAdapter().rows({ inputPath: input.toString(), country })) {
		rendered.push(row)
	}

	return rendered
}

function keyed(row: CanonicalRow) {
	const aligned = alignRow(row)

	if (aligned.kind !== "labeled") throw new Error(`${row.raw} did not align: ${aligned.row.reason}`)

	const spans = {
		raw: aligned.row.raw,
		span_starts: aligned.row.span_starts!,
		span_ends: aligned.row.span_ends!,
		span_tags: aligned.row.span_tags!,
	}

	return { raw: spans.raw, key: overtureAddressKey(spans), block: overtureAddressBlock(spans) }
}

// The rows v0.8.0 holds were rendered without a region, with the postcode as Overture spells it.
const CASES = [
	{
		country: "CA",
		// The frozen row reads `225 County 2 RD, CARDINAL K0E1E0`.
		before: { street: "County 2 RD", number: "225", postcode: "K0E1E0", locality: "CARDINAL" },
		after: { street: "County 2 RD", number: "225", postcode: "K0E 1E0", locality: "CARDINAL", region: "ON" },
	},
	{
		country: "BR",
		before: { street: "RUA CICERO MARTINS", number: "210", postcode: "15062-260", locality: "São José do Rio Preto" },
		after: {
			street: "RUA CICERO MARTINS",
			number: "210",
			postcode: "15062260",
			locality: "São José do Rio Preto",
			region: "SP",
		},
	},
	{
		country: "MX",
		before: { street: "CALLE ZITACUARO", number: "78", postcode: "52765", locality: "Huixquilucan" },
		after: { street: "CALLE ZITACUARO", number: "78", postcode: "52765", locality: "Huixquilucan", region: "México" },
	},
]

describe("overtureAddressKey", () => {
	it.each(CASES)("keys the $country row with its region and regrouped postcode to the row without", async (fixture) => {
		const [before, after] = (await render(fixture.country, [fixture.before, fixture.after])).map(keyed)

		expect(after!.raw).not.toBe(before!.raw)
		expect(before!.key).not.toBeNull()
		expect(after!.key).toBe(before!.key)
		expect(after!.block).toBe(before!.block)
	})

	it("gives another house number, unit or postcode another key", async () => {
		const base = { street: "County 2 RD", number: "225", postcode: "K0E1E0", locality: "CARDINAL" }

		const keys = (
			await render("CA", [base, { ...base, number: "227" }, { ...base, unit: "4" }, { ...base, postcode: "K0E1E1" }])
		).map((row) => keyed(row).key)

		expect(new Set(keys).size).toBe(keys.length)
	})

	it("keys a row with a country surface to the row without", async () => {
		const row = { street: "RUA CICERO MARTINS", number: "210", postcode: "15062-260", locality: "Campinas" }
		const without = keyed((await render("BR", [row]))[0]!)

		const input = scratch.path("overture-br-country.corpus.jsonl")

		await writeLocalJSONLFile([row], input)

		const withCountry: CanonicalRow[] = []

		for await (const rendered of createOvertureAdapter().rows({
			inputPath: input.toString(),
			country: "BR",
			countryFraction: 1,
		})) {
			withCountry.push(rendered)
		}

		const keyedWith = keyed(withCountry[0]!)

		expect(withCountry[0]!.components.country).toBeTruthy()
		expect(keyedWith.key).toBe(without.key)
	})
})
