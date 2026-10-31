/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Writes the Great Britain golden board `tools/eval-harness/fixtures/gb/os-open-golden.jsonl` from the
 *   `gb-os-open` adapter's canonical rows: Code-Point Open, OS Open Names and OS Open Roads, under the
 *   Open Government Licence v3.0.
 *
 *   It replaced `gb-golden.jsonl` on 2026-10-17. That board's rows were HM Land Registry Price Paid Data
 *   address fields. Royal Mail and Ordnance Survey license those fields only for personal or non-commercial use
 *   and for displaying residential property price information (#2635).
 *
 *   One row per postcode area: the area's row with the lowest `source_id`, which is a content hash, so the
 *   pick is deterministic and unrelated to the file's order. The adapter draws each row's house number at
 *   random, so the board keeps the street, the locality and the postcode and drops the number. The rows
 *   have no `dependent_locality`, because OS OpenData records none. A board consumer that grades that
 *   tag reads zero rows for it.
 *
 *   Usage:
 *   node packages/mailwoman/tools/dev-tools/gb/os-open-golden.run.ts [--input <canonical.jsonl>] [--out <path>]
 */

import { writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { GB_OS_OPEN_ADAPTER_ID, gbOSOpenCanonicalRowsPath } from "@mailwoman/corpus/gb/adapters/os-open/adapter"
import { JSONSpliterator } from "spliterator"

const { values } = parseArguments({
	options: {
		input: { type: "string", description: "The adapter's canonical.jsonl (default: the data root's staging copy)" },
		out: { type: "string", description: "Destination (default: the committed fixture)" },
	},
})

interface CanonicalRow {
	source?: string
	source_id?: string
	license?: string
	components?: { street?: string; locality?: string; postcode?: string }
}

interface GoldenRow {
	raw: string
	components: { street: string; locality: string; postcode: string }
	country: "GB"
	source: string
	license: string
}

const input = values.input ?? gbOSOpenCanonicalRowsPath().toString()
const out = values.out ?? workspacePath("mailwoman", "tools", "eval-harness", "fixtures", "gb", "os-open-golden.jsonl")

/**
 * The initial letters identify a postcode's area.
 */
const POSTCODE_AREA = /^[A-Z]{1,2}/

const pickByArea = new Map<string, { sourceID: string; row: GoldenRow }>()
let read = 0

for await (const row of JSONSpliterator.fromAsync<CanonicalRow>(input)) {
	read++

	if (row.source !== GB_OS_OPEN_ADAPTER_ID || row.license !== "OGL-UK-3.0") {
		throw new Error(`${input} row ${read}: source ${row.source} under ${row.license}, not ${GB_OS_OPEN_ADAPTER_ID}`)
	}

	const street = row.components?.street
	const locality = row.components?.locality
	const postcode = row.components?.postcode
	const sourceID = row.source_id
	const area = postcode?.match(POSTCODE_AREA)?.[0]

	if (!street || !locality || !postcode || !sourceID || !area) continue

	const held = pickByArea.get(area)

	if (held && held.sourceID <= sourceID) continue

	pickByArea.set(area, {
		sourceID,
		row: {
			raw: `${street}, ${locality}, ${postcode}`,
			components: { street, locality, postcode },
			country: "GB",
			source: GB_OS_OPEN_ADAPTER_ID,
			license: "OGL-UK-3.0",
		},
	})
}

if (!pickByArea.size) throw new Error(`${input}: no row carried a street, a locality and a postcode`)

const rows = [...pickByArea.entries()].toSorted(([a], [b]) => a.localeCompare(b)).map(([, { row }]) => row)

await writeLocalJSONLFile(rows, out)

console.log(`${read.toLocaleString()} rows read from ${input}`)
console.log(`${rows.length} postcode areas written to ${out}`)
