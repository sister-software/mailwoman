/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Write a deletion sidecar of the rows whose postcode sits on the side of the locality-and-region block that
 *   the row's country does not use, as `postcodePlacement` from `@mailwoman/postcode/country-formats` states it.
 *   The sidecar is a one-column `source_id` parquet for a `deletions[]` entry's `sourceIDsFile` (#2750), and the
 *   tool prints per-country row, native and reversed counts.
 *
 *   Usage:
 *   node packages/mailwoman/tools/dev-tools/corpus/order-deletions.run.ts --in <file.parquet> --out <sidecar.parquet>
 *   [--country ES --country BE --country PL] [--dry-run]
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { findReversedRows, writeSourceIDSidecar } from "./order-deletions.ts"

const { values } = parseArguments({
	options: {
		in: { type: "string", description: "The corpus parquet file to scan" },
		out: { type: "string", description: "The sidecar parquet to write" },
		country: {
			type: "string",
			multiple: true,
			description: "Restrict the scan to these ISO 3166-1 alpha-2 codes. Defaults to every country",
		},
		"dry-run": { type: "boolean", default: false, description: "Report the counts and write nothing" },
	},
})

if (!values.in) throw new Error("--in <file.parquet> is required")

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
