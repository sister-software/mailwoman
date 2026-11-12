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
	"mw-thin-system-02":
		"`SUITE B21, GOLDEN PEACOCK SHOPPING COMPLEX, LILONGWE, Malawi`: the shopping complex reads as a second locality beside `LILONGWE`.",
	// The rows below decode to an invalid tree under the 10.7.0 model (v7.10.0 seed 42), accepted in #2682.
	"ae-thin-system-11":
		"`OFFICE 1809, JBC 2, JLT, DUBAI, United Arab Emirates`: the district `JLT` and `DUBAI` both read as localities.",
	"ae-thin-system-14":
		"`OFFICE 2003 A, SWISS TOWER, CLUSTER Y JUMEIRAH LAKES TOWERS, DUBAI, United Arab Emirates`: `CLUSTER Y JUMEIRAH` and `DUBAI` both read as localities, and `LAKES TOWERS` as a street.",
	"gb-vob-2-veneti": "`2 Veneti`: the venue name splits into a house number `2` and a street `Veneti`.",
	// The rows below decode to an invalid tree under the 10.8.0 model (v8.6.3 seed 42), accepted in #2926.
	// The capital or main city reads as the region in the first seven, the remainder of the
	// `<street>, <city>, <country>` defect #2925 traces to wof-admin's `<place>, <region>, <country>` rows.
	"ae-thin-system-03":
		"`OPP. UNION PAPER MILLS, DUBAI, United Arab Emirates`: `DUBAI` reads as the region, so the landmark is a dependent_locality with no locality.",
	"ae-thin-system-06":
		"`GROUND FLOOR BUKHATIR BUILDING, SHARJAH, United Arab Emirates`: `SHARJAH` reads as the region, so the building is a dependent_locality with no locality.",
	"am-thin-system-13":
		"`NORASHEN DISTRICT, BUILDING 12, APT 63, AJAPNYAK, YEREVAN, Armenia`: `YEREVAN` reads as the region and `BUILDING` as a locality.",
	"cn-cs-nanjing-road-huangpu-shanghai":
		"`Nanjing Road, Huangpu, Shanghai`: `Shanghai` reads as the region, so the district `Huangpu` is a dependent_locality with no locality.",
	"om-thin-system-01":
		"`STREET NO 6516,BUILDING NO-1480,PLOT NO-119,FLAT NO 22, MUSCAT, Oman`: `MUSCAT` reads as the region, and `STREET NO 6516`, `PLOT NO-119` and `FLAT NO 22` as localities.",
	"qa-thin-system-10":
		"`UNIT 117, JBK COMPOUND, SALWA, DOHA, Qatar`: `DOHA` reads as the region and `SALWA` as the locality, so the compound is a dependent_locality beside it.",
	"th-cs-sukhumvit-soi-11-bangkok":
		"`Sukhumvit Soi 11, Bangkok`: `Bangkok` reads as the region, so the soi is a dependent_locality with no locality.",
	"vn-op-le-duan-city-twice":
		"`34 Lê Duẩn, Sài Gòn, Hồ Chí Minh, Vietnam`: `Hồ Chí Minh` reads as the region, so `Sài Gòn` is a dependent_locality with no locality. `applyRegionCity` corrects the answer after the parse.",
	"gh-ws-digital-address-ga-183-8164-accra":
		"`GA-183-8164, Accra, Ghana`: the GhanaPost digital address reads as a house number with no street.",
	"jp-grouping-corner-bracket-building":
		"`「六本木ヒルズ」東京都港区六本木6-10-1`: under the Latin model, `東京都港区六本木6` reads as one street and the building as a dependent_locality.",
	"jp-inner-shi-kamiichi-native":
		"`富山県中新川郡上市町大岩148-7`: under the Latin model, `富山県中新川郡上市町大岩148` reads as one dependent_locality.",
	"jp-interesting-rinrin-ja":
		"`りんりん, 〒506-0025 岐阜県高山市天満町3丁目 57`: under the Latin model, `岐阜県高山市天満町3丁目` reads as one street.",
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
