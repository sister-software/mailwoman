/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Splice locale diacritic pieces into a frozen tokenizer, or grow an exported model onto a spliced tokenizer.
 *
 *   `build-tokenizer` reads the locales' OpenAddresses street and city names, trains a locale unigram model on them,
 *   appends that model's pieces that hold a code point outside ASCII to the base tokenizer, and checks that English
 *   tokenizes as before. With `--trained-samples`, it also writes the code point overlap report beside the spliced
 *   tokenizer and fails on an overlap no `--accept-overlap` entry accepts.
 *
 *   `onnx-mean-init` grows an exported model's token embedding table, and its int8 twin's, to the spliced vocabulary.
 *
 *   Usage:
 *
 *     node packages/mtf/tools/tokenizer/splice.run.ts build-tokenizer --oa-root <dir> --base-tokenizer <model>
 *       --out-tokenizer <model> [--locales cz,pl,sk,si] [--vocab-size 24000] [--per-file-cap 400000]
 *       [--work-dir out/bsplice-work] [--trained-samples fr=<path>,de=<path>] [--accept-overlap fr]
 *       [--extra-text <txt>] [--extra-repeat 10] [--spm-train <path>]
 *     node packages/mtf/tools/tokenizer/splice.run.ts onnx-mean-init --fp32-onnx <onnx> --base-tokenizer <model>
 *       --spliced-tokenizer <model> --out-fp32 <onnx> [--int8-onnx <onnx> --out-int8 <onnx>]
 *
 *   A per-file cap that reads a whole small regional file can read only the first departments of a country published
 *   as one national file, such as France's. Raise it, or pass a sampled national extract, to keep the corpus spread
 *   across the country.
 */

import { makeDirectories } from "@mailwoman/core/fs/writers"
import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import { resolvePath } from "path-ts"

import { spmTrainBinary } from "./binary.ts"
import {
	buildSlavicCorpus,
	checkCodepointOverlap,
	meanInitONNXEmbeddings,
	spliceVocabulary,
	trainDiacriticSentencePiece,
} from "./splice.ts"

const { values, positionals } = parseArguments({
	allowPositionals: true,
	options: {
		"oa-root": { type: "string" },
		locales: { type: "string", default: "cz,pl,sk,si" },
		"base-tokenizer": { type: "string" },
		"out-tokenizer": { type: "string" },
		"vocab-size": { type: "string", default: "24000" },
		"per-file-cap": { type: "string", default: "400000" },
		"work-dir": { type: "string", default: "out/bsplice-work" },
		"trained-samples": { type: "string", default: "" },
		"extra-text": { type: "string" },
		"extra-repeat": { type: "string", default: "10" },
		"accept-overlap": { type: "string", default: "" },
		"spm-train": { type: "string" },
		"fp32-onnx": { type: "string" },
		"spliced-tokenizer": { type: "string" },
		"out-fp32": { type: "string" },
		"int8-onnx": { type: "string" },
		"out-int8": { type: "string" },
	},
})

function list(value: string): string[] {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
}

const command = positionals[0]

if (command === "build-tokenizer") {
	const workDirectory = resolvePath(values["work-dir"])
	const baseTokenizer = resolvePath(requiredArgument(command, "base-tokenizer", values["base-tokenizer"]))
	const outTokenizer = resolvePath(requiredArgument(command, "out-tokenizer", values["out-tokenizer"]))
	const corpus = `${workDirectory}/slavic-corpus.txt`

	await makeDirectories(workDirectory)

	const lines = await buildSlavicCorpus({
		oaRoot: resolvePath(requiredArgument(command, "oa-root", values["oa-root"])),
		locales: values.locales.split(","),
		outPath: corpus,
		perFileCap: Number(values["per-file-cap"]),
		extraText: values["extra-text"] ?? null,
		extraRepeat: Number(values["extra-repeat"]),
	})

	console.log(`corpus: ${lines} lines`)

	const donor = await trainDiacriticSentencePiece(corpus, `${workDirectory}/slavic-sp`, {
		spmTrain: await spmTrainBinary(values["spm-train"]),
		vocabSize: Number(values["vocab-size"]),
	})

	const pieces = await spliceVocabulary(baseTokenizer, donor, outTokenizer)

	console.log(`spliced ${pieces.length} diacritic pieces -> ${outTokenizer}`)
	console.log("English tokenization verified identical (0 differences).")

	if (values["trained-samples"]) {
		const samples = Object.fromEntries(
			list(values["trained-samples"]).map((pair) => {
				const at = pair.indexOf("=")

				return [pair.slice(0, at).trim(), pair.slice(at + 1).trim()]
			})
		)

		const reportPath = outTokenizer.replace(/\.[^./]*$/, "") + ".overlap-report.json"
		const report = await checkCodepointOverlap(pieces, samples, reportPath, new Set(list(values["accept-overlap"])))
		const overlapping = Object.entries(report).flatMap(([locale, codepoints]) => (codepoints.length ? [locale] : []))

		console.log(
			`overlap check passed; report ${reportPath}; overlapping (accepted): ${overlapping.join(", ") || "none"}`
		)
	}
} else if (command === "onnx-mean-init") {
	const outFp32 = resolvePath(requiredArgument(command, "out-fp32", values["out-fp32"]))

	const [oldVocab, newVocab] = await meanInitONNXEmbeddings({
		fp32ONNX: resolvePath(requiredArgument(command, "fp32-onnx", values["fp32-onnx"])),
		baseTokenizer: resolvePath(requiredArgument(command, "base-tokenizer", values["base-tokenizer"])),
		splicedTokenizer: resolvePath(requiredArgument(command, "spliced-tokenizer", values["spliced-tokenizer"])),
		outFp32,
		int8ONNX: values["int8-onnx"] ?? null,
		outInt8: values["out-int8"] ?? null,
	})

	console.log(`expanded ONNX token_embeddings ${oldVocab} -> ${newVocab}; wrote ${outFp32}`)

	if (values["out-int8"]) {
		console.log(`  int8 twin written ${values["out-int8"]}`)
	}
} else {
	console.error("usage: splice.run.ts build-tokenizer|onnx-mean-init [options]")

	process.exitCode = 2
}
