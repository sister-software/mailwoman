/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Extracts the `postcode-order` recipe's tuples from a built corpus, one tuples file per base source.
 *
 * Usage:
 *
 * ```sh
 * node packages/mailwoman/tools/dev-tools/corpus/postcode-order-tuples.run.ts \
 *   --corpus <corpus dir with MANIFEST.json> --countries FR,IT,MX,BR,CA,NZ,VE --sources ban,openaddresses \
 *   --cap 20000 --out-dir <dir>
 * ```
 *
 * Each file then feeds one `mailwoman corpus slice postcode-order --input <file> --register <id>` run.
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"
import {
	readPostcodeOrderTuples,
	samplePostcodeOrderTuples,
	writePostcodeOrderTuples,
} from "@mailwoman/corpus/tools/postcode-order-tuples"

import { readMixtureFiles } from "#tools/dev-tools/corpus/mixture"

const { values } = parseArguments({
	options: {
		corpus: { type: "string" },
		split: { type: "string", default: "train" },
		countries: { type: "string" },
		sources: { type: "string" },
		/**
		 * Tuples one (country, source) pair may contribute.
		 */
		cap: { type: "string", default: "20000" },
		/**
		 * Tuples one locality may hold while the corpus streams.
		 */
		"locality-quota": { type: "string", default: "8" },
		"out-dir": { type: "string" },
		files: { type: "string" },
	},
})

if (!values.corpus || !values.countries || !values.sources || !values["out-dir"]) {
	throw new Error("--corpus, --countries, --sources and --out-dir are required")
}

const split = (list: string) =>
	list
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean)

const mixture = await readMixtureFiles(values.corpus, values.split!, values.files ? Number(values.files) : null)

const kept = await samplePostcodeOrderTuples(
	readPostcodeOrderTuples(mixture.files, split(values.countries), split(values.sources)),
	{ cap: Number(values.cap), localityQuota: Number(values["locality-quota"]) }
)

for (const { source, path, tuples } of await writePostcodeOrderTuples(kept, values["out-dir"])) {
	console.log(`${source}: ${tuples.toLocaleString()} tuples → ${path}`)
}
