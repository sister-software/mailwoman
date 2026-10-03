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
import { readLocalTextFile, pathExists } from "@mailwoman/core/fs/readers"
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

const AUCKLAND_POSTCODE_AS_HOUSE_NUMBER =
	"`Auckland 1010`: the postcode `1010` reads as a house number, which has no street anchor."

const KNOWN_INVALID: Record<string, string> = {
	"us-f3-brooklyn-new-york": NEW_YORK_AS_REGION,
	"us-f3-brooklyn-new-york-lower": NEW_YORK_AS_REGION,
	"us-f7-hell-s-kitchen-new-york": NEW_YORK_AS_REGION,
	"al-thin-system-07":
		"`AUTOSTRADA TR-DR KM 8, KASHAR, TIRANE, Albania`: the road reads as a locality, so the house number `8` has no street anchor.",
	"ec-thin-system-04":
		"`OE11 N61-96, QUITO, Ecuador`: the Quito block code `OE11` reads as a house number with no street, and `QUITO` as a dependent_locality with no locality.",
	"gb-street-name-elephant-and-castle-road":
		"`Elephant and Castle Road`: the conjunction splits the name into intersection streets, and `Road` is left as a street_suffix with no street.",
	"gh-ws-digital-address-ga-183-8164-accra":
		"`GA-183-8164, Accra, Ghana`: the GhanaPost digital address splits into a house number `GA` with no street and a postcode `183-8164`.",
	"im-op2-simpsons-field":
		"`Simpson's Field, 5G8H+8F5, Douglas, Isle of Man IM2 4RE, Isle of Man`: the plus code reads as a house number with no street anchor.",
	"mw-thin-system-02":
		"`SUITE B21, GOLDEN PEACOCK SHOPPING COMPLEX, LILONGWE, Malawi`: the shopping complex reads as a second locality beside `LILONGWE`.",
	"nz-f5-auckland-1010": AUCKLAND_POSTCODE_AS_HOUSE_NUMBER,
	"nz-f5-auckland-1010-lower": AUCKLAND_POSTCODE_AS_HOUSE_NUMBER,
	"qa-thin-system-11":
		"Doha's numbered street `STREET 52` and `INDUSTRIAL AREA` each read as a locality beside `DOHA`, three localities in all.",
	"qa-thin-system-14":
		"Doha's numbered street `STREET 44` reads as a locality, so the numbered entrance after it is a unit with no street anchor.",
	"ug-thin-system-14":
		"`PLOT 14-16 KYAMBOGO ROAD NTINDA, KAMPALA, Uganda`: the road and suburb read as one locality, so the plot range `14-16` has no street anchor.",
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
