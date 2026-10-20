/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Writes one `postcode-order` recipe output as a parquet file with its `<stem>.RECORD.json`.
 *
 * Usage:
 *
 * ```sh
 * node packages/mailwoman/tools/dev-tools/corpus/postcode-order-parquet.run.ts \
 *   --rows <recipe output jsonl> --tuples <tuples jsonl the recipe read> --seed <seed> --out <data.parquet>
 * ```
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { writePostcodeOrderParquet } from "@mailwoman/corpus/tools/postcode/order-tuples"

const { values } = parseArguments({
	options: {
		rows: { type: "string" },
		tuples: { type: "string" },
		seed: { type: "string" },
		out: { type: "string" },
	},
})

if (!values.rows || !values.tuples || !values.seed || !values.out) {
	throw new Error("--rows, --tuples, --seed and --out are required")
}

const record = await writePostcodeOrderParquet({
	rows: values.rows,
	tuples: values.tuples,
	output: values.out,
	seed: Number(values.seed),
})

console.log(
	`${record.source}: ${record.rows.toLocaleString()} rows, derivation ${record.derivationHash} → ${values.out}`
)
