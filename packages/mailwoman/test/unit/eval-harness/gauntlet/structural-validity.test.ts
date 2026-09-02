/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Every board row must decode to a STRUCTURALLY COHERENT tree, or be on the list below with a reason.
 *
 *   `validateTree` (v0.7 task #37) was written because a parse can match a component and still be incoherent — a
 *   `street_suffix` floating with no `street`, an `intersection_a`/`_b` pair claiming a junction that has no road. For
 *   years nothing consumed it: `validateTree` was called only by its own test, so the check existed and the answer was
 *   never asked for. #1747 repaired one instance after finding the diagnosis had sat unread.
 *
 *   THE PROPERTY THAT MAKES THIS WORTH RESTRICTING is that the verdict needs no truth. Every other board assertion compares
 *   against an expected component or coordinate; this one reads the tree against its own contract, so it can fail a row
 *   nobody has labelled and it cannot be satisfied by pinning a new expectation. Measured over 854 rows it flags four,
 *   and all four are rows the board independently tracks as failing — no false positives.
 *
 *   It earned the check by first being WRONG in a way worth recording. The initial sweep flagged eight, and five were
 *   the sub-venue shape (`Terminal 5` of `Heathrow Airport`) on a row that PASSES the check: `PARENT_OF[unit]` had no
 *   `venue` edge, so the contract was narrower than the capability the board already tested. Fixed in 8c54b4b48. A
 *   structural check is only as good as the structure it is given, which is the argument for the allowlist below being
 *   short and reasoned rather than long and tolerated.
 */

import { validateTree } from "@mailwoman/core/decoder"
import { readDirectory, readLocalTextFile, pathExists } from "@mailwoman/core/fs/readers"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { repoRootPath } from "@mailwoman/core/paths"
import { resolveWeights } from "@mailwoman/neural/weights"
import { parseForGeocode } from "mailwoman/geocode"
import { join } from "path-ts"
import { describe, expect, it } from "vitest"

async function weightsPresent(): Promise<boolean> {
	try {
		return await pathExists((await resolveWeights({ locale: "en-us" })).modelPath)
	} catch {
		return false
	}
}

/**
 * Rows whose tree is structurally invalid TODAY, each with the issue that owns it.
 *
 * An entry is a debt with a name. Removing one because it started passing is the good outcome; adding one needs the
 * defect written down first, because a row added here silently is a defect converted into a permanent exemption.
 */
const KNOWN_INVALID: Record<string, string> = {
	"ie-op2-pairc-adhamhnain": "`Letterkenny` read as dependent_locality with no locality anchor. Undiagnosed.",
}

interface Row {
	id: string
	input: string
}

async function boardRows(): Promise<Row[]> {
	const root = String(repoRootPath("packages", "mailwoman", "lib", "eval-harness", "gauntlet", "cases"))
	const rows: Row[] = []

	for (const entry of await readDirectory(root)) {
		let files: string[]

		try {
			// A country directory carries more than `regression.jsonl` — street-name-boundaries, gloss-keys, others.
			// Reading only the first name silently measured 326 of 854 rows.
			files = (await readDirectory(join(root, entry))).filter((f) => f.endsWith(".jsonl"))
		} catch {
			continue
		}

		for (const name of files) {
			// oxlint-disable-next-line mailwoman/prefer-spliterator -- committed board files, read whole and bounded
			for (const line of (await readLocalTextFile(join(root, entry, name))).split("\n")) {
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
			// The tree AS THE RESOLVER SEES IT — after the postcode and stranded-affix repairs.
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
				"regressed, or the containment contract is narrower than a capability we ship (which is what the " +
				"sub-venue edge in 8c54b4b48 turned out to be — check that before adding an allowlist entry)."
		).toEqual([])

		expect(
			fixed,
			`KNOWN_INVALID row(s) that now decode cleanly: ${fixed.join(", ")}. Drop the entry — a stale exemption ` +
				"hides the next regression on that row."
		).toEqual([])
	})
})
