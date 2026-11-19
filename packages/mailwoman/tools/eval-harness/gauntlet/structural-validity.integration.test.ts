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
import { parseJSONStrict } from "@mailwoman/core/json"
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
	// The capital or main city reads as the region in the first four, the remainder of the
	// `<street>, <city>, <country>` defect #2925 traces to wof-admin's `<place>, <region>, <country>` rows.
	"ae-thin-system-03":
		"`OPP. UNION PAPER MILLS, DUBAI, United Arab Emirates`: `DUBAI` reads as the region, so the landmark is a dependent_locality with no locality.",
	"ae-thin-system-06":
		"`GROUND FLOOR BUKHATIR BUILDING, SHARJAH, United Arab Emirates`: `SHARJAH` reads as the region, so the building is a dependent_locality with no locality.",
	"cn-cs-nanjing-road-huangpu-shanghai":
		"`Nanjing Road, Huangpu, Shanghai`: `Shanghai` reads as the region, so the district `Huangpu` is a dependent_locality with no locality.",
	"vn-op-le-duan-city-twice":
		"`34 Lê Duẩn, Sài Gòn, Hồ Chí Minh, Vietnam`: `Hồ Chí Minh` reads as the region, so `Sài Gòn` is a dependent_locality with no locality. `applyRegionCity` corrects the answer after the parse.",
	"gh-ws-digital-address-ga-183-8164-accra":
		"`GA-183-8164, Accra, Ghana`: the GhanaPost digital address reads as a house number with no street.",
	"jp-inner-shi-kamiichi-native":
		"`富山県中新川郡上市町大岩148-7`: under the Latin model, `富山県中新川郡上市町大岩148` reads as one dependent_locality.",
	// The rows below decode to an invalid tree under the 11.2.0 model (v8.9.0 seed 42), accepted in #3127.
	"ae-street-name-corniche-road":
		"`Corniche Road`: `Corniche` reads as a street_prefix and `Road` as a street_suffix, with no street between them.",
	"ae-thin-system-15":
		"`SHOP S07, BUILDING V04, INTERNATIONAL CITY, DUBAI, United Arab Emirates`: `SHOP S07` and `BUILDING V04` read as units with no street, house number or venue, `DUBAI` as the region and `INTERNATIONAL CITY` as the locality.",
	"cn-contrast-script-mixed":
		"`上海市Huangpu区人民路100号`: under the Latin model, the whole input reads as one dependent_locality with no locality.",
	"cn-contrast-script-native":
		"`上海市黄浦区人民路100号`: under the Latin model, the whole input reads as one dependent_locality with no locality.",
	"cr-thin-system-06":
		"`100 S DE LIGA DE LA CANA LA URUCA, EDIFICIO ALQUIMIA, SAN JOSE, Costa Rica`: `EDIFICIO ALQUIMIA` reads as a dependent_locality and `SAN JOSE` as the region, so no locality anchors it.",
	"cz-full-praha-100-00":
		"`Praha 100 00, Czechia`: the postcode splits, `Praha 100` reads as the locality and `00` as a house number with no street.",
	"gb-op2-antrim-aonb":
		"`Antrim Coast and Glens Area of Outstanding Natural Beauty, Ballymena, United Kingdom`: the AONB reads as a dependent_locality and `Ballymena` as the region, so no locality anchors it.",
	"jp-ws-jingumae-4-12-10-romaji":
		"`4-chōme-12-10 Jingūmae, Shibuya, Tokyo 150-0001, Japan`: `Shibuya` reads as a dependent_locality and `Tokyo` as the region, so no locality anchors it.",
	"us-f3-brooklyn-new-york":
		"`Brooklyn, New York`: `Brooklyn` reads as a dependent_locality and `New York` as the region, so no locality anchors it.",
	"us-f3-brooklyn-new-york-lower":
		"`brooklyn, new york`: the healed `Brooklyn` reads as a dependent_locality and `New York` as the region, so no locality anchors it.",
	"vn-op-city-international-hospital":
		"`Bệnh viện Quốc tế City, 3 Đường Số 17A, An Lạc, Hồ Chí Minh 700000, Vietnam`: `3 Đường Số` and `An Lạc` read as dependent_localities and `Hồ Chí Minh` as the region, so no locality anchors them.",
	"zw-thin-system-03":
		"`ECONET PARK, 2, HARARE, Zimbabwe`: `ECONET PARK` and `HARARE` both read as localities, and `2` as a house number with no street.",
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
