/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Every board row must decode to a structurally coherent tree or appear in the allowlist with a reason.
 *   because the check reads the tree against its own interface, it needs no truth and cannot be satisfied by
 *   pinning a new expectation.
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
const NEW_YORK_AS_REGION =
	"`Brooklyn, New York`: `New York` reads as the state, so the borough is a dependent_locality with no locality anchor. The city and the state share the name; the #1914 family board row is `improvement_target`."

const KNOWN_INVALID: Record<string, string> = {
	"us-f3-brooklyn-new-york": NEW_YORK_AS_REGION,
	"us-f3-brooklyn-new-york-lower": NEW_YORK_AS_REGION,
	"us-f7-hell-s-kitchen-new-york": NEW_YORK_AS_REGION,
	"al-thin-system-07":
		"`AUTOSTRADA TR-DR KM 8, KASHAR, TIRANE, Albania`: the road reads as a locality, so the house number `8` has no street anchor.",
	"mw-thin-system-02":
		"`SUITE B21, GOLDEN PEACOCK SHOPPING COMPLEX, LILONGWE, Malawi`: the shopping complex reads as a second locality beside `LILONGWE`.",
	// The rows below decode to an invalid tree under the 10.7.0 model (v7.10.0 seed 42), accepted in #2682.
	"ae-thin-system-11":
		"`OFFICE 1809, JBC 2, JLT, DUBAI, United Arab Emirates`: the district `JLT` and `DUBAI` both read as localities.",
	"ae-thin-system-12":
		"`OFFICE 1406 FIFTY-ONE TOWER, DUBAI, United Arab Emirates`: `OFFICE` and the tower both read as localities, so the number `1406` has no street anchor.",
	"ae-thin-system-13":
		"`PLOT NO. 26/M, INDUSTRIAL AREA NO. 13, SHARJAH, United Arab Emirates`: `PLOT NO.` and `SHARJAH` both read as localities, and `AREA NO. 13` as a dependent_locality.",
	"ae-thin-system-14":
		"`OFFICE 2003 A, SWISS TOWER, CLUSTER Y JUMEIRAH LAKES TOWERS, DUBAI, United Arab Emirates`: `CLUSTER Y JUMEIRAH` and `DUBAI` both read as localities, and `LAKES TOWERS` as a street.",
	"ae-thin-system-15":
		"`SHOP S07, BUILDING V04, INTERNATIONAL CITY, DUBAI, United Arab Emirates`: `SHOP S07`, `INTERNATIONAL CITY` and `DUBAI` all read as localities.",
	"br-brasilia-shis-eql-6-8-modulo-c":
		"`SHIS EQL 6/8 Módulo C, Setor de Habitações Individuais Sul, Brasília`: the sector reads as a dependent_locality under a region, with no locality.",
	"bw-thin-system-01":
		"`PLOT 75783, SETLHOA OFFICE PARK, UNIT 5, BLOCK 10, GABORONE, Botswana`: the plot reads as a PO box, and `SETLHOA`, `BLOCK 10` and `GABORONE` all as localities.",
	"bw-thin-system-09":
		"`PLOT 70667 FAIRSCAPE PRECINCT, GABORONE, Botswana`: `PLOT` reads as a house number and the plot number `70667` as a postcode.",
	"cn-contrast-script-omitted-level":
		"`上海市人民路100号`: the whole string reads as one house number under the Latin model, which this sweep runs for every row.",
	"gb-vob-2-veneti": "`2 Veneti`: the venue name splits into a house number `2` and a street `Veneti`.",
	"mx-op3-plaza-las-americas-villahermosa":
		"`Plaza Las Américas, Cerrada de Emilio Carranza 202 Atasta 86100 Villahermosa, Tab. Mexico`: `Cerrada` reads as a dependent_locality, and `Atasta` and `Villahermosa` both as localities.",
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
