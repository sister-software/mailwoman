// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Every board row must decode to a structurally coherent tree or appear in the
 *   allowlist with a reason. because the check reads the tree against its own interface,
 *   it needs no truth and cannot be satisfied by pinning a new expectation.
 */

import { validateTree } from "@mailwoman/core/decoder"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { parseJSONStrict } from "@mailwoman/core/values/json"
import { resolveWeights } from "@mailwoman/neural/weights"
import { Globerator } from "spliterator/node/fs"
import { describe, expect, it } from "vitest"

import { parseForGeocode } from "#geocode"
import { CASES_DIR } from "#tools/eval-harness/gauntlet/cases/load"

async function weightsPresent(): Promise<boolean> {
	try {
		return await pathExists((await resolveWeights({ locale: "en-us" })).modelPath)
	} catch {
		return false
	}
}

/**
 * An entry requires a written defect first, because a row added here silently
 * converts a defect into a permanent exemption.
 */
const KNOWN_INVALID: Record<string, string> = {
	// Decodes to an invalid tree under the 10.7.0 model (v7.10.0 seed 42), accepted in #2682.
	"gb-vob-2-veneti": "`2 Veneti`: the venue name splits into a house number `2` and a street `Veneti`.",
	// The rows below decode to an invalid tree under the 10.8.0 model (v8.6.3 seed 42), accepted in #2926.
	// The capital reads as the region in the first, the remainder of the `<street>, <city>, <country>`
	// defect #2925 traces to wof-admin's `<place>, <region>, <country>` rows.
	"cn-cs-nanjing-road-huangpu-shanghai":
		"`Nanjing Road, Huangpu, Shanghai`: `Shanghai` reads as the region, so the district `Huangpu` is a dependent_locality with no locality.",
	"gh-ws-digital-address-ga-183-8164-accra":
		"`GA-183-8164, Accra, Ghana`: the GhanaPost digital address reads as a house number with no street.",
	"jp-inner-shi-kamiichi-native":
		"`富山県中新川郡上市町大岩148-7`: under the Latin model, `富山県中新川郡上市町大岩148` reads as one dependent_locality.",
	// The rows below decode to an invalid tree under the 11.2.0 model (v8.9.0 seed 42), accepted in #3127.
	"cn-contrast-script-mixed":
		"`上海市Huangpu区人民路100号`: under the Latin model, the whole input reads as one dependent_locality with no locality.",
	"zw-thin-system-03":
		"`ECONET PARK, 2, HARARE, Zimbabwe`: `ECONET PARK` and `HARARE` both read as localities, and `2` as a house number with no street.",
	// The rows below decode to an invalid tree under the 11.3.0 model (v8.10.0 seed 42), accepted in #3431.
	"am-thin-system-13":
		"`NORASHEN DISTRICT, BUILDING 12, APT 63, AJAPNYAK, YEREVAN, Armenia`: `NORASHEN DISTRICT` reads as the locality and `BUILDING 12` as a unit with no street, and `YEREVAN` as the region.",
	"ec-thin-system-12":
		"`E11-26, AVENIDA LOS GRANADOS Y AVENIDA 6 DE DICIEMBRE, QUITO, Ecuador`: the street intersection reads as a dependent_locality and `E11-26` as a house number with no street.",
	"jp-grouping-corner-bracket-building":
		"`「六本木ヒルズ」東京都港区六本木6-10-1`: under the Latin model, the bracketed building name splits into `六` as the country and `本` as the prefecture.",
	"pg-op4-lake-2":
		"`Lake 2, H7WF+2H8, Tanubada Central Province, Papua New Guinea`: `Lake 2` reads as the locality, and the plus code splits into a dependent_locality `H7WF` and a unit `2H8`.",
	"qa-thin-system-10":
		"`UNIT 117, JBK COMPOUND, SALWA, DOHA, Qatar`: `UNIT 117` reads as a unit with no street, house number or venue, and `JBK COMPOUND` as a dependent_locality.",
	"vn-op-april-30th-park-en":
		"`April 30th Park, 6 Lê Duẩn, Sài Gòn, Hồ Chí Minh, Vietnam`: the street `Lê Duẩn` reads as a dependent_locality, so `6` is a house number with no street.",
}

interface Row {
	id: string
	input: string
}

async function boardRows(): Promise<Row[]> {
	const rows: Row[] = []

	for await (const entry of Globerator.from("*", { cwd: CASES_DIR, absolute: false, onlyFiles: false })) {
		let files: string[]

		try {
			// A country directory contains more than `regression.jsonl`, so reading
			// only the first name undercounts the board.
			files = await Globerator.files("jsonl", { cwd: CASES_DIR(entry), absolute: false, recursive: false }).toArray()
		} catch {
			continue
		}

		for (const name of files) {
			// oxlint-disable-next-line mailwoman/prefer-spliterator -- committed board files, read whole and bounded
			for (const line of (await readLocalTextFile(CASES_DIR(entry, name))).split("\n")) {
				if (!line.trim()) continue

				const row = parseJSONStrict(line) as Partial<Row>

				if (row.id && row.input) {
					rows.push({ id: row.id, input: row.input })
				}
			}
		}
	}

	return rows
}

describe.skipIf(!(await weightsPresent()))("board structural validity", () => {
	it("flags exactly the rows on the known-invalid list, and no others", { timeout: 300_000 }, async () => {
		const { NeuralAddressClassifier } = await import("@mailwoman/neural")
		const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-us" })
		const rows = await boardRows()

		// A sweep that silently read no rows would pass every assertion below.
		expect(rows.length).toBeGreaterThan(500)

		const invalid: string[] = []

		for (const row of rows) {
			// The tree AS the resolver sees IT — after the postcode and stranded-affix repairs.
			const tree = await parseForGeocode(row.input, { classifier })

			if (!validateTree(tree).valid) {
				invalid.push(row.id)
			}
		}

		const unexpected = [...new Set(invalid)].filter((id) => !(id in KNOWN_INVALID)).toSorted()

		const fixed = Object.keys(KNOWN_INVALID)
			.filter((id) => !invalid.includes(id))
			.toSorted()

		expect(
			unexpected,
			`Board row(s) now decoding to a structurally invalid tree: ${unexpected.join(", ")}. Either the parse ` +
				"regressed, or the containment interface is narrower than a capability we ship (which is what the " +
				"sub-venue edge in 8c54b4b48 turned out to be — check that before adding an allowlist entry)."
		).toEqual([])

		expect(
			fixed,
			`KNOWN_INVALID row(s) that now decode cleanly: ${fixed.join(", ")}. Drop the entry — a stale exemption ` +
				"hides the next regression on that row."
		).toEqual([])
	})
})
