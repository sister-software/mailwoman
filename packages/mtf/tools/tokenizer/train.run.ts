/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Train a versioned SentencePiece tokenizer from a corpus's train split.
 *
 *   The tool writes `tokenizer.model`, `tokenizer.vocab`, `model_card.json` and `META.json` under `--output`. The card
 *   records the byte-fallback rate on `--eval-fixture`, so a tokenizer's coverage is a measured number. The training
 *   runs native `spm_train` from SentencePiece v0.2.2 and writes the model the Python wheel writes for the same call.
 *
 *   `--corpus` takes a corpus tree (the parent of `train/`), a directory holding exactly one `corpus-v*` tree, or a
 *   version (`v0.3.0` or `0.3.0`), which resolves to `corpus/versioned/vX/corpus-vX` under the data root.
 *
 *   Usage:
 *
 *     node packages/mtf/tools/tokenizer/train.run.ts --corpus v0.3.0 --output <dir> [--vocab 48000]
 *       [--character-coverage 0.9999] [--model-type unigram] [--no-byte-fallback] [--split-digits]
 *       [--countries US,FR] [--per-country-sample 500000] [--mine-postcode-literals 0]
 *       [--user-defined-symbols-file <txt>] [--no-default-user-defined-symbols] [--eval-fixture <jsonl>]
 *       [--seed 42] [--corpus-version <v>] [--flag name=value ...] [--spm-train <path>]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { isDirectory } from "@mailwoman/core/fs/readers/stat"
import { prettyJSON } from "@mailwoman/core/json"
import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import { resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { spmTrainBinary } from "./binary.ts"
import type { TrainerFlagValue } from "./sentencepiece.ts"
import { DEFAULT_USER_DEFINED_SYMBOLS, readUserDefinedSymbolsFile } from "./symbols.ts"
import { TOKENIZER_TRAINING_DEFAULTS, trainTokenizer } from "./train.ts"

const { values } = parseArguments({
	options: {
		corpus: { type: "string" },
		"corpus-version": { type: "string" },
		output: { type: "string" },
		vocab: { type: "string", default: String(TOKENIZER_TRAINING_DEFAULTS.vocabSize) },
		"character-coverage": { type: "string", default: String(TOKENIZER_TRAINING_DEFAULTS.characterCoverage) },
		"model-type": { type: "string", default: TOKENIZER_TRAINING_DEFAULTS.modelType },
		"no-byte-fallback": { type: "boolean", default: false },
		"split-digits": { type: "boolean", default: false },
		countries: { type: "string", default: TOKENIZER_TRAINING_DEFAULTS.countries.join(",") },
		"per-country-sample": { type: "string", default: String(TOKENIZER_TRAINING_DEFAULTS.perCountrySample) },
		"mine-postcode-literals": { type: "string", default: "0" },
		"user-defined-symbols-file": { type: "string" },
		"no-default-user-defined-symbols": { type: "boolean", default: false },
		"eval-fixture": { type: "string" },
		seed: { type: "string", default: String(TOKENIZER_TRAINING_DEFAULTS.seed) },
		flag: { type: "string", multiple: true, default: [] },
		"spm-train": { type: "string" },
	},
})

const MODEL_TYPES = new Set(["unigram", "bpe", "char", "word"])

function integer(name: string, value: string): number {
	const parsed = Number(value)

	if (!Number.isInteger(parsed)) throw new Error(`--${name} is not an integer: ${value}`)

	return parsed
}

/**
 * The corpus tree a `--corpus` value names.
 */
async function resolveCorpusDirectory(spec: string): Promise<string> {
	const path = resolvePath(spec)

	if (await isDirectory(`${path}/train`)) return path

	if (await isDirectory(path)) {
		const candidates = await Globerator.from("corpus-v*", { cwd: path, absolute: false }).toSorted()

		if (candidates.length === 1 && (await isDirectory(`${path}/${candidates[0]}/train`))) {
			return `${path}/${candidates[0]}`
		}
	}

	const version = spec.replace(/^v+/, "")
	const candidate = dataRootPath("corpus", "versioned", `v${version}`, `corpus-v${version}`).toString()

	if (await isDirectory(`${candidate}/train`)) return candidate

	throw new Error(`could not resolve --corpus=${spec}; tried ${candidate}/train and the direct path forms`)
}

/**
 * `v0.3.0` from a `.../v0.3.0/corpus-v0.3.0` path, or the directory name.
 */
function inferCorpusVersion(corpusDirectory: string): string {
	const name = corpusDirectory.split("/").at(-1)!

	return name.startsWith("corpus-") ? name.slice("corpus-".length) : name
}

/**
 * A `--flag name=value` trainer argument: `true` and `false` as booleans,
 * a number as a number, else the text.
 */
function extraFlag(spec: string): [string, TrainerFlagValue] {
	const at = spec.indexOf("=")

	if (at <= 0) throw new Error(`--flag ${spec} is not name=value`)
	const name = spec.slice(0, at)
	const text = spec.slice(at + 1)

	if (text === "true" || text === "false") return [name, text === "true"]

	return [name, text !== "" && Number.isFinite(Number(text)) ? Number(text) : text]
}

const modelType = values["model-type"]

if (!MODEL_TYPES.has(modelType)) throw new Error(`--model-type must be one of ${[...MODEL_TYPES].join(", ")}`)

const corpusDirectory = await resolveCorpusDirectory(requiredArgument("train", "corpus", values.corpus))
const symbols: string[] = values["no-default-user-defined-symbols"] ? [] : [...DEFAULT_USER_DEFINED_SYMBOLS]

if (values["user-defined-symbols-file"]) {
	symbols.push(...(await readUserDefinedSymbolsFile(values["user-defined-symbols-file"])))
}

const card = await trainTokenizer({
	corpusDirectory,
	outputDirectory: resolvePath(requiredArgument("train", "output", values.output)),
	corpusVersion: values["corpus-version"] ?? inferCorpusVersion(corpusDirectory),
	vocabSize: integer("vocab", values.vocab),
	characterCoverage: Number(values["character-coverage"]),
	modelType,
	byteFallback: !values["no-byte-fallback"],
	splitDigits: values["split-digits"],
	allowWhitespaceOnlyPieces: false,
	perCountrySample: integer("per-country-sample", values["per-country-sample"]),
	countries: values.countries
		.split(",")
		.map((code) => code.trim())
		.filter((code) => code.length > 0),
	minePostcodeLiterals: integer("mine-postcode-literals", values["mine-postcode-literals"]),
	userDefinedSymbols: symbols,
	evalFixture: values["eval-fixture"] ?? null,
	seed: integer("seed", values.seed),
	extraFlags: Object.fromEntries(values.flag.map(extraFlag)),
	spmTrain: await spmTrainBinary(values["spm-train"]),
})

console.log(prettyJSON(card, false, 2))
