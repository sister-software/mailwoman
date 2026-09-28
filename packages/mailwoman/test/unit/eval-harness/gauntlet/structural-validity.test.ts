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
import { CASES_DIR } from "mailwoman/eval-harness/gauntlet/cases/load"
import { parseForGeocode } from "mailwoman/geocode"
import { Globerator } from "spliterator/node/fs"
import { describe, expect, it } from "vitest"

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
const SG_GENERIC_FIRST_STREET =
	"The Malay generic-first street (`Jalan Sukachita`, `Lengkong Empat`) reads as locality, so the house number has no street anchor. The shipped Latin model has no Singapore register; the `sg-register` corpus recipe (#1931) targets it, and the board row is `improvement_target`."

const NEW_YORK_AS_REGION =
	"`Brooklyn, New York`: `New York` reads as the state, so the borough is a dependent_locality with no locality anchor. The city and the state share the name; the #1914 family board row is `improvement_target`."

const MILITARY_UNIT_LINE_SPLIT =
	"`Unit 2050 Box 4190, DPO AP 96278`: the military unit line splits into a stranded `unit` and a `po_box` of `Box 4190` alone, where the gold convention tags the whole line `po_box` — the #517 defect the row was written for."

const KNOWN_INVALID: Record<string, string> = {
	"ie-op2-pairc-adhamhnain": "`Letterkenny` read as dependent_locality with no locality anchor. Undiagnosed.",
	"sg-register-building-led-128799-14": SG_GENERIC_FIRST_STREET,
	"sg-register-official-358886-10": SG_GENERIC_FIRST_STREET,
	"sg-register-official-399429-9a": SG_GENERIC_FIRST_STREET,
	"sg-register-official-417611-3": SG_GENERIC_FIRST_STREET,
	"sg-register-official-468658-8": SG_GENERIC_FIRST_STREET,
	"sg-register-official-578038-7": SG_GENERIC_FIRST_STREET,
	"sg-register-official-762522-522b":
		"`522B Yishun St 53`: the block `522B` reads as a postcode and `53`, the street's own number, as the house number, which then has no street anchor. Same register gap as the Jalan rows; the `sg-register` corpus recipe (#1931) targets it.",
	"sg-register-official-769796-74": SG_GENERIC_FIRST_STREET,
	"us-f3-brooklyn-new-york": NEW_YORK_AS_REGION,
	"us-f3-brooklyn-new-york-lower": NEW_YORK_AS_REGION,
	"us-f7-hell-s-kitchen-new-york": NEW_YORK_AS_REGION,
	"us-f9-unit-2050-box-4190-dpo-ap-96278": MILITARY_UNIT_LINE_SPLIT,
	"us-f9-unit-8400-box-0001-dpo-ae-09498": MILITARY_UNIT_LINE_SPLIT,
	"ve-f5-valencia-2001-carabobo-venezuela":
		"`Valencia 2001, Carabobo, Venezuela`: the postcode reads as a house number and `Valencia` as a unit, so the number has no street anchor — the #1821 defect the row was written for. The board row is `improvement_target`.",
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
