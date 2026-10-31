/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Find the rows whose postcode sits on the side of the locality-and-region block that the row's country does not
 *   use, as `postcodePlacement` from `@mailwoman/postcode/country-formats` states it (#2750).
 *
 *   With `--write-native <out.parquet>` the tool writes the input's rows minus the reversed ones, judged row by row,
 *   with a `RECORD.json` beside it, and prints per-country rows in and out. A native row that shares its `source_id`
 *   with a reversed row stays. With `--out <sidecar.parquet>` it writes the reversed rows' `source_id`s for a
 *   `deletions[]` entry instead, and prints per-country row, native and reversed counts.
 *
 *   Usage:
 *   node packages/mailwoman/tools/dev-tools/corpus/order/deletions.run.ts --in <file.parquet> --write-native <out.parquet>
 *   node packages/mailwoman/tools/dev-tools/corpus/order/deletions.run.ts --in <file.parquet> --out <sidecar.parquet>
 *   [--country ES --country BE --country PL] [--dry-run]
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { findReversedRows, writeNativeRows, writeSourceIDSidecar } from "./deletions.ts"

const { values } = parseArguments({
	options: {
		in: { type: "string", description: "The corpus parquet file to scan" },
		out: { type: "string", description: "The sidecar parquet to write" },
		"write-native": {
			type: "string",
			description: "Write the input's rows minus the reversed ones to this parquet, in place of a sidecar",
		},
		country: {
			type: "string",
			multiple: true,
			description: "Restrict the sidecar scan to these ISO 3166-1 alpha-2 codes. Defaults to every country",
		},
		"dry-run": { type: "boolean", default: false, description: "Report the sidecar counts and write nothing" },
	},
})

if (!values.in) throw new Error("--in <file.parquet> is required")

if (values["write-native"]) {
	if (values.out || values.country) throw new Error("--write-native takes neither --out nor --country")

	const { countries, record } = await writeNativeRows(values.in, values["write-native"])

	for (const [country, count] of [...countries].toSorted(([a], [b]) => a.localeCompare(b))) {
		console.log(
			`${country}\trows_in=${count.rowsIn}\trows_out=${count.rowsOut}\tremoved=${count.rowsIn - count.rowsOut}`
		)
	}

	console.log(stringifyJSON({ in: values.in, out: values["write-native"], rows: record.rows, sha256: record.sha256 }))
} else {
	if (!values.out && !values["dry-run"]) throw new Error("--out <sidecar.parquet> is required unless --dry-run")

	const { ids, countries } = await findReversedRows(values.in, values.country)

	for (const [country, count] of [...countries].toSorted(([a], [b]) => a.localeCompare(b))) {
		if (!count.reversed && values.country == null) continue

		console.log(
			`${country}\trows=${count.rows}\tnative=${count.native}\treversed=${count.reversed}\tnative_sharing_id=${count.nativeSharingID}`
		)
	}

	console.log(stringifyJSON({ in: values.in, reversed: ids.length, out: values["dry-run"] ? null : values.out }))

	if (!values["dry-run"]) {
		await writeSourceIDSidecar(ids, values.out!)
	}
}
