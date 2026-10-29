/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Train a versioned SentencePiece tokenizer from a corpus's train split, and write its model card.
 *
 *   The training lines are a balanced sample: a reservoir of `perCountrySample` raws per country, drawn with CPython's
 *   generator in the order `tokenizer/train.py` drew, then shuffled. The card records what reproduces the model: the
 *   corpus files read and their order, the SHA-256 of the training input and of the symbol list, the SentencePiece
 *   release, every flag, and the model's SHA-256.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { gitHead } from "@mailwoman/core/git"
import { sha256File, sha256Hex } from "@mailwoman/core/hash"
import { isoSeconds } from "@mailwoman/core/utils"

import { runMTFTokenizer, SENTENCEPIECE } from "./binary.ts"
import { type ByteFallbackReport, measureByteFallback, readFixtureLines } from "./byte-fallback.ts"
import { readModelPieces } from "./model.ts"
import { type TrainerFlags, type TrainerFlagValue, trainSentencePiece } from "./sentencepiece.ts"
import { dedupeKeepOrder, sentencePieceSymbol } from "./symbols.ts"

export interface TokenizerTrainingConfig {
	corpusDirectory: string
	outputDirectory: string
	corpusVersion: string
	vocabSize: number
	characterCoverage: number
	modelType: string
	byteFallback: boolean
	splitDigits: boolean
	allowWhitespaceOnlyPieces: boolean
	perCountrySample: number
	countries: readonly string[]
	minePostcodeLiterals: number
	userDefinedSymbols: readonly string[]
	evalFixture: string | null
	seed: number
	/**
	 * Further trainer arguments, appended after the standard ones in this order.
	 */
	extraFlags: Readonly<Record<string, TrainerFlagValue>>
	/**
	 * The `spm_train` binary.
	 */
	spmTrain: string
}

/**
 * The defaults `mailwoman_train tokenizer` trained with.
 */
export const TOKENIZER_TRAINING_DEFAULTS = {
	vocabSize: 48_000,
	characterCoverage: 0.9999,
	modelType: "unigram",
	byteFallback: true,
	splitDigits: false,
	allowWhitespaceOnlyPieces: false,
	perCountrySample: 500_000,
	countries: ["US", "FR"],
	minePostcodeLiterals: 0,
	seed: 42,
} as const

/**
 * The symbols to keep whole, as written and as passed to SentencePiece: the configured list,
 * then any mined postcode literals, first occurrences only, truncated to a quarter of the vocabulary.
 */
export async function resolveUserDefinedSymbols(
	config: Pick<
		TokenizerTrainingConfig,
		"userDefinedSymbols" | "minePostcodeLiterals" | "corpusDirectory" | "countries" | "vocabSize"
	>
): Promise<{ symbols: string[]; passed: string[] }> {
	const listed = [...config.userDefinedSymbols]

	if (config.minePostcodeLiterals > 0) {
		listed.push(
			...(await runMTFTokenizer<string[]>([
				"mine-postcodes",
				"--corpus",
				config.corpusDirectory,
				"--top-k",
				String(config.minePostcodeLiterals),
				"--countries",
				config.countries.join(","),
			]))
		)
	}

	let symbols = dedupeKeepOrder(listed)
	const cap = Math.max(0, Math.floor(config.vocabSize / 4))

	if (symbols.length > cap) {
		console.warn(`user_defined_symbols (${symbols.length}) exceeds the vocab_size/4 cap (${cap}); truncating`)

		symbols = symbols.slice(0, cap)
	}

	return { symbols, passed: symbols.map(sentencePieceSymbol) }
}

/**
 * The trainer flags of a configuration, in the order the Python trainer passed them.
 */
export function trainerFlags(
	config: TokenizerTrainingConfig,
	input: string,
	modelPrefix: string,
	symbols: readonly string[]
): TrainerFlags {
	return {
		input,
		model_prefix: modelPrefix,
		vocab_size: config.vocabSize,
		character_coverage: config.characterCoverage,
		model_type: config.modelType,
		byte_fallback: config.byteFallback,
		split_digits: config.splitDigits,
		allow_whitespace_only_pieces: config.allowWhitespaceOnlyPieces,
		pad_id: 0,
		unk_id: 1,
		bos_id: 2,
		eos_id: 3,
		user_defined_symbols: symbols,
		...config.extraFlags,
	}
}

/**
 * A train file read, in read order, and the SHA-256 its corpus manifest records, when it records one.
 */
interface CorpusFileRecord {
	path: string
	sha256: string | null
}

/**
 * The card `trainTokenizer` writes as `model_card.json` and `META.json`.
 */
export interface TokenizerModelCard {
	tokenizer_version: string
	corpus_version: string
	vocab_size: number
	training_lines: number
	training_duration_seconds: number
	generated_at: string
	git_commit: string | null
	model_sha256: string
	model_path: string
	vocab_path: string
	sentencepiece: typeof SENTENCEPIECE & { trainer: "spm_train" }
	sentencepiece_flags: Record<string, unknown>
	training_input: {
		sha256: string
		lines: number
		corpus_files: CorpusFileRecord[]
		user_defined_symbols_sha256: string
	}
	sampling: { countries: string[]; per_country: number; seed: number; per_country_lines: Record<string, number> }
	byte_fallback_eval: ByteFallbackReport | null
}

function directoryName(path: string): string {
	return path.replace(/\/+$/, "").split("/").at(-1)!
}

/**
 * Sample, train and write `tokenizer.model`, `tokenizer.vocab`, `model_card.json`
 * and `META.json` under the output directory.
 */
export async function trainTokenizer(config: TokenizerTrainingConfig): Promise<TokenizerModelCard> {
	const started = performance.now()

	await makeDirectories(config.outputDirectory)
	const modelPrefix = `${config.outputDirectory}/tokenizer`

	await using scratch = await temporaryDirectory("mtf-train-")
	const input = scratch.path("input.txt").toString()
	const corpusFiles = await runMTFTokenizer<CorpusFileRecord[]>(["train-files", "--corpus", config.corpusDirectory])

	const sampled = await runMTFTokenizer<{ lines: number; per_country: [string, number][] }>([
		"sample-raws",
		"--corpus",
		config.corpusDirectory,
		"--countries",
		config.countries.join(","),
		"--per-country",
		String(config.perCountrySample),
		"--seed",
		String(config.seed),
		"--out",
		input,
	])

	for (const [country, lines] of sampled.per_country) {
		console.info(`sampled ${lines} lines for country=${country}`)
	}

	if (sampled.lines === 0) {
		throw new Error(`sampled zero lines from ${config.corpusDirectory} for countries ${config.countries.join(",")}`)
	}

	const { symbols, passed } = await resolveUserDefinedSymbols(config)
	const flags = trainerFlags(config, input, modelPrefix, passed)
	const inputSHA256 = await sha256File(input)

	console.info(
		`training sentencepiece: vocab=${config.vocabSize}, type=${config.modelType}, char_cov=${config.characterCoverage}, ` +
			`byte_fb=${config.byteFallback}, lines=${sampled.lines}, uds=${symbols.length}`
	)

	const trained = await trainSentencePiece(flags, { spmTrain: config.spmTrain, workDirectory: scratch.path.toString() })
	const elapsed = (performance.now() - started) / 1000

	const byteFallback = config.evalFixture
		? await measureByteFallback(trained.model, await readFixtureLines(config.evalFixture))
		: null

	const portableFlags: Record<string, unknown> = Object.fromEntries(
		Object.entries(flags).filter(([name]) => name !== "input" && name !== "user_defined_symbols")
	)

	portableFlags["user_defined_symbols_count"] = symbols.length
	portableFlags["user_defined_symbols_preview"] = symbols.slice(0, 64)

	const card: TokenizerModelCard = {
		tokenizer_version: directoryName(config.outputDirectory),
		corpus_version: config.corpusVersion,
		vocab_size: (await readModelPieces(trained.model)).length,
		training_lines: sampled.lines,
		training_duration_seconds: Math.round(elapsed * 1000) / 1000,
		generated_at: isoSeconds(),
		git_commit: await gitHead().catch(() => null),
		model_sha256: await sha256File(trained.model),
		model_path: trained.model,
		vocab_path: trained.vocab,
		sentencepiece: { ...SENTENCEPIECE, trainer: "spm_train" },
		sentencepiece_flags: portableFlags,
		training_input: {
			sha256: inputSHA256,
			lines: sampled.lines,
			corpus_files: corpusFiles,
			user_defined_symbols_sha256: sha256Hex(passed.map((symbol) => `${symbol}\n`).join("")),
		},
		sampling: {
			countries: [...config.countries],
			per_country: config.perCountrySample,
			seed: config.seed,
			per_country_lines: Object.fromEntries(sampled.per_country),
		},
		byte_fallback_eval: byteFallback,
	}

	await writeLocalJSONFile(card, `${config.outputDirectory}/model_card.json`)
	await writeLocalJSONFile(card, `${config.outputDirectory}/META.json`)

	console.info(
		`wrote ${trained.model} (vocab=${card.vocab_size}, byte_fb_overall=${byteFallback ? byteFallback.overall.rate.toFixed(4) : "n/a"})`
	)

	return card
}
