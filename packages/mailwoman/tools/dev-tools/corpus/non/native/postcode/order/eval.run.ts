/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Writes the held-out non-native postcode-order evaluation set from a built corpus's `test` split.
 *
 * Usage:
 *
 * ```sh
 * node packages/mailwoman/tools/dev-tools/corpus/non/native/postcode/order/eval.run.ts \
 *   --corpus <corpus dir with MANIFEST.json> --countries FR,IT,MX,BR,CA,NZ,VE --sources ban,openaddresses \
 *   --cap 500 --seed 7 --out <golden.jsonl>
 * ```
 *
 * The output holds golden `{raw, components, country}` rows, the shape `fr-order --golden` writes.
 * The tool reads the `test` split only, and it has no `--split` flag.
 */

import { writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import {
	NON_NATIVE_ORDER_SPLIT,
	nonNativeOrderGoldenRows,
	readNonNativeOrderTuples,
	sampleNonNativeOrderTuples,
} from "@mailwoman/corpus/tools/postcode/non-native-order"

import { readMixtureFiles } from "#tools/dev-tools/corpus/mixture"

const { values } = parseArguments({
	options: {
		corpus: { type: "string" },
		countries: { type: "string" },
		sources: { type: "string" },
		/**
		 * Tuples one (country, source) pair may contribute.
		 */
		cap: { type: "string", default: "500" },
		/**
		 * Tuples one locality may hold while the corpus streams.
		 */
		"locality-quota": { type: "string", default: "8" },
		seed: { type: "string", default: "7" },
		out: { type: "string" },
		files: { type: "string" },
	},
})

if (!values.corpus || !values.countries || !values.sources || !values.out) {
	throw new Error("--corpus, --countries, --sources and --out are required")
}

const list = (text: string) =>
	text
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0)

const mixture = await readMixtureFiles(
	values.corpus,
	NON_NATIVE_ORDER_SPLIT,
	values.files ? Number(values.files) : null
)

const tuples = await sampleNonNativeOrderTuples(
	readNonNativeOrderTuples(NON_NATIVE_ORDER_SPLIT, mixture.files, list(values.countries), list(values.sources)),
	{ cap: Number(values.cap), localityQuota: Number(values["locality-quota"]) }
)

const { rows, skipped } = nonNativeOrderGoldenRows(tuples, Number(values.seed))

await writeLocalJSONLFile(rows, values.out)

console.log(
	`${rows.length.toLocaleString()} golden rows from ${tuples.length.toLocaleString()} ${NON_NATIVE_ORDER_SPLIT}-split tuples ` +
		`(${skipped} skipped: layout states no postcode order) → ${values.out}`
)
