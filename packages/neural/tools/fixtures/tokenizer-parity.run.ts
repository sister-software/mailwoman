/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Writes a tokenizer parity fixture: each input with the pieces and ids `@mailwoman/mtf` encodes it to.
 *
 *   The curated mode encodes a fixed list of address fragments covering ASCII, numbers, hyphenation, Latin
 *   diacritics, punctuation and the empty string, and writes the committed fixture. The parquet mode samples
 *   `--sample` raws from one file's `raw` column with CPython's generator, the sample the Python generator drew for
 *   the same seed, for a larger local fixture.
 *
 *   Usage:
 *
 *     node packages/neural/tools/fixtures/tokenizer-parity.run.ts --model <tokenizer.model> --out <json>
 *       [--from-parquet <parquet> --sample 10000 --seed 42]
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/paths"
import { runFile } from "@mailwoman/core/process"
import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import { runMTFTokenizer } from "@mailwoman/mtf/tools/tokenizer/binary"
import { loadEncoder } from "@mailwoman/mtf/tools/tokenizer/model"
import { resolvePath } from "path-ts"

/**
 * Real or near-real address fragments, one per behavior the fixture pins.
 */
const CURATED_INPUTS = [
	"Paris",
	"75004 Paris",
	"1600 Pennsylvania Avenue NW, Washington, DC 20500",
	"Saint-Petersburg",
	"Café Régal",
	"São Paulo",
	"15 Rue de Rivoli",
	"245 1st Ave N, Saint Petersburg, FL 33701",
	"PO Box 1234, Anchorage, AK 99501",
	"40-12 Bell Blvd, Bayside, NY 11361",
	"The New York Steakhouse, 123 Main St, New York, NY 10001",
	"Buffalo Health Center Inc., 200 Elmwood Ave, Buffalo, NY 14222",
	"RR 2 Box 67, Rural Springs, MT 59101",
	"15 Rue de Rivoli, 75004 Paris, France",
	"London",
	"10 Downing Street",
	"",
]

const { values } = parseArguments({
	options: {
		model: { type: "string" },
		out: { type: "string" },
		"from-parquet": { type: "string" },
		sample: { type: "string", default: "10000" },
		seed: { type: "string", default: "42" },
	},
})

const model = resolvePath(requiredArgument("tokenizer-parity", "model", values.model))
const out = resolvePath(requiredArgument("tokenizer-parity", "out", values.out))
let inputs = CURATED_INPUTS

if (values["from-parquet"]) {
	const size = Number(values.sample)

	if (!Number.isInteger(size) || size <= 0) throw new Error("--sample must be a positive integer")
	await using scratch = await temporaryDirectory("tokenizer-parity-")
	const sampled = scratch.path("sample.json").toString()

	await runMTFTokenizer([
		"reservoir",
		"--file",
		resolvePath(values["from-parquet"]),
		"--size",
		String(size),
		"--seed",
		values.seed,
		"--out",
		sampled,
	])

	inputs = await readLocalJSONFile<string[]>(sampled)

	console.error(`sampled ${inputs.length} raws from ${values["from-parquet"]} (seed=${values.seed})`)
} else {
	console.error(`using ${inputs.length} curated inputs`)
}

using encoder = await loadEncoder(model)

const entries = inputs.map((raw) => {
	const { pieces, ids } = encoder.encode(raw)

	return { raw, pieces, ids }
})

await writeLocalJSONFile(entries, out)
await runFile("yarn", ["oxfmt", out], { cwd: repoRootPath() })

console.error(`wrote ${entries.length} fixture entries to ${out}`)
