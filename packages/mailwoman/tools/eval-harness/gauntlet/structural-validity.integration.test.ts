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
	// Decodes to an invalid tree under the 11.3.0 model (v8.10.0 seed 42), accepted in #3431.
	"am-thin-system-13":
		"`NORASHEN DISTRICT, BUILDING 12, APT 63, AJAPNYAK, YEREVAN, Armenia`: `NORASHEN DISTRICT` reads as the locality and `BUILDING 12` as a unit with no street, and `YEREVAN` as the region.",
	// Decodes to an invalid tree under the 11.4.0 model (v8.13.0 seed 42), accepted in #3521.
	"ae-thin-system-15":
		"`SHOP S07, BUILDING V04, INTERNATIONAL CITY, DUBAI, United Arab Emirates`: `SHOP S07` and `BUILDING V04` read as units with no street or house number.",
	// The rows below decode to an invalid tree under the 11.5.0 model (v8.19.0 seed 42), accepted in #3549.
	"ae-thin-system-08":
		"`UNIT 05K, AG TOWER JLT, CLUSTER I, DUBAI, United Arab Emirates`: `UNIT 05K` reads as a unit with no street or venue, `AG TOWER JLT` as the locality and `CLUSTER I` as a subregion.",
	"ae-thin-system-14":
		"`OFFICE 2003 A, SWISS TOWER, CLUSTER Y JUMEIRAH LAKES TOWERS, DUBAI, United Arab Emirates`: `OFFICE 2003` reads as a unit and `A` as a house number with no street.",
	"al-thin-system-07":
		"`AUTOSTRADA TR-DR KM 8, KASHAR, TIRANE, Albania`: `AUTOSTRADA TR-DR` reads as the locality and `KM` as a house number with no street.",
	"cr-thin-system-06":
		"`100 S DE LIGA DE LA CANA LA URUCA, EDIFICIO ALQUIMIA, SAN JOSE, Costa Rica`: the building `EDIFICIO ALQUIMIA` reads as a dependent_locality after the street.",
	"de-cs-hamburg-city-region-same":
		"`Rathausmarkt 1, Hamburg, Hamburg 20095`: the first `Hamburg` reads as a dependent_locality, so the tree has no locality.",
	"fo-op2-akraberg":
		"`Akraberg Lighthouse, 98VC+JHM, Akraberg 970, Faroe Islands`: the plus code `98VC+JHM` reads as the locality and the postcode `970` as a house number with no street.",
	"gh-ws-digital-address-ga-183-8164-accra":
		"`GA-183-8164, Accra, Ghana`: the GhanaPost digital address reads as a house number with no street.",
	"mw-thin-system-02":
		"`SUITE B21, GOLDEN PEACOCK SHOPPING COMPLEX, LILONGWE, Malawi`: `LILONGWE` reads as a subregion, so the venue and unit sit under no locality.",
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
