/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Train the first-generation tokenizer recipe on a text file of raw addresses, one per line.
 *
 *   The recipe is fixed: a 16,000-piece unigram vocabulary, 0.9995 character coverage, byte fallback, the four special
 *   ids, and no user-defined symbols. It writes `tokenizer.model`, `tokenizer.vocab` and `META.json` under `--output`.
 *   `--version` must match the corpus version the tokenizer ships with.
 *
 *   Usage: `node packages/mtf/tools/tokenizer/train-text.run.ts --input <txt> --output <dir> --version <v>
 *   [--spm-train <path>]`
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { gitHead } from "@mailwoman/core/git"
import { sha256File } from "@mailwoman/core/hash"
import { prettyJSON } from "@mailwoman/core/json"
import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import { resolvePath } from "path-ts"

import { spmTrainBinary } from "./binary.ts"
import { trainSentencePiece } from "./sentencepiece.ts"

const RECIPE = {
	vocab_size: 16_000,
	character_coverage: 0.9995,
	model_type: "unigram",
	byte_fallback: true,
} as const

const { values } = parseArguments({
	options: {
		input: { type: "string" },
		output: { type: "string" },
		version: { type: "string" },
		"spm-train": { type: "string" },
	},
})

const input = resolvePath(requiredArgument("train-text", "input", values.input))
const output = resolvePath(requiredArgument("train-text", "output", values.output))
const version = requiredArgument("train-text", "version", values.version)

await makeDirectories(output)
await using scratch = await temporaryDirectory("mtf-train-text-")

const trained = await trainSentencePiece(
	{
		input,
		model_prefix: `${output}/tokenizer`,
		...RECIPE,
		pad_id: 0,
		unk_id: 1,
		bos_id: 2,
		eos_id: 3,
		user_defined_symbols: [],
	},
	{ spmTrain: await spmTrainBinary(values["spm-train"]), workDirectory: scratch.path.toString() }
)

const text = await readLocalTextFile(input)

const meta = {
	tokenizer_version: version,
	...RECIPE,
	// Every line break ends a line, and a final line without one still counts.
	training_lines: (text.match(/\n/g)?.length ?? 0) + (text && !text.endsWith("\n") ? 1 : 0),
	git_commit: await gitHead().catch(() => null),
	model_sha256: await sha256File(trained.model),
	model_path: trained.model,
	vocab_path: trained.vocab,
}

await writeLocalJSONFile(meta, `${output}/META.json`)

console.log(prettyJSON(meta, false, 2))
