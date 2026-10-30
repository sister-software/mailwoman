/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Builds the Korean label corpus and the Korean registry corpus, then writes each one's `SOURCE_RIGHTS.json`.
 *
 *   Usage:
 *     node packages/corpus/lib/tools/kr-corpus.run.ts --out-dir <corpus dir> --registry-out-dir <registry dir>
 *       [--juso-zip <202608ALLMTCHG00.zip>] [--permit-dir <localdata-kr>] [--train-rows 2000000] [--val-rows 20000]
 *       [--board-rows 20000] [--registry-rows 600000] [--registry-val-fraction 0.02] [--registry-board-rows 20000]
 *       [--board-bucket-min 90] [--rows-per-part 250000] [--stats-sample-per-part 50000] [--country-fraction 0.05]
 *       [--max-field-chars 64] [--max-rows-per-region <n>] [--permit-glob <glob>] [--seed 42] [--force]
 *       [--unshippable-reason <why>]
 */

import { integerArgument, parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"

import { buildKRCorpus, jusoZipPath, KR_CORPUS_DEFAULTS, permitDirectoryPath } from "#kr/corpus/assemble"
import { KR_CORPUS_SOURCE, KR_REGISTRY_SOURCE } from "#kr/corpus/rows"
import { openSourceRightsAdmission, writeSourceRightsRecord } from "#source-register/corpus-inputs"

const text = (value: number) => ({ type: "string" as const, default: String(value) })

const { values } = parseArguments({
	options: {
		"juso-zip": { type: "string" },
		"permit-dir": { type: "string" },
		"out-dir": { type: "string" },
		"registry-out-dir": { type: "string" },
		"train-rows": text(KR_CORPUS_DEFAULTS.trainRows),
		"val-rows": text(KR_CORPUS_DEFAULTS.valRows),
		"board-rows": text(KR_CORPUS_DEFAULTS.boardRows),
		"registry-rows": text(KR_CORPUS_DEFAULTS.registryRows),
		"registry-val-fraction": text(KR_CORPUS_DEFAULTS.registryValFraction),
		"registry-board-rows": text(KR_CORPUS_DEFAULTS.registryBoardRows),
		"board-bucket-min": text(KR_CORPUS_DEFAULTS.boardBucketMin),
		"rows-per-part": text(KR_CORPUS_DEFAULTS.rowsPerPart),
		"stats-sample-per-part": text(KR_CORPUS_DEFAULTS.statsSamplePerPart),
		"country-fraction": text(KR_CORPUS_DEFAULTS.countryFraction),
		"max-field-chars": text(KR_CORPUS_DEFAULTS.maxFieldChars),
		"max-rows-per-region": { type: "string" },
		"permit-glob": { type: "string", default: "*.csv" },
		seed: text(KR_CORPUS_DEFAULTS.seed),
		force: { type: "boolean", default: false },
		"unshippable-reason": { type: "string" },
	},
})

const outDir = requiredArgument("kr-corpus", "--out-dir", values["out-dir"])
const registryOutDir = requiredArgument("kr-corpus", "--registry-out-dir", values["registry-out-dir"])
const unshippableReason = values["unshippable-reason"] ?? null
const corpus = await openSourceRightsAdmission({ context: "KR corpus assembly", unshippableReason })
const registry = await openSourceRightsAdmission({ context: "KR registry assembly", unshippableReason })

corpus.admitAll([KR_CORPUS_SOURCE])
registry.admitAll([KR_REGISTRY_SOURCE])

await buildKRCorpus({
	jusoZip: values["juso-zip"] ?? jusoZipPath(),
	permitDir: values["permit-dir"] ?? permitDirectoryPath(),
	outDir,
	registryOutDir,
	trainRows: integerArgument("train-rows", values["train-rows"]),
	valRows: integerArgument("val-rows", values["val-rows"]),
	boardRows: integerArgument("board-rows", values["board-rows"]),
	registryRows: integerArgument("registry-rows", values["registry-rows"]),
	registryValFraction: Number(values["registry-val-fraction"]),
	registryBoardRows: integerArgument("registry-board-rows", values["registry-board-rows"]),
	boardBucketMin: integerArgument("board-bucket-min", values["board-bucket-min"]),
	rowsPerPart: integerArgument("rows-per-part", values["rows-per-part"]),
	statsSamplePerPart: integerArgument("stats-sample-per-part", values["stats-sample-per-part"]),
	countryFraction: Number(values["country-fraction"]),
	maxFieldChars: integerArgument("max-field-chars", values["max-field-chars"]),
	maxRowsPerRegion: values["max-rows-per-region"]
		? integerArgument("max-rows-per-region", values["max-rows-per-region"])
		: undefined,
	permitGlob: values["permit-glob"],
	seed: integerArgument("seed", values.seed),
	force: values.force,
})

await writeSourceRightsRecord(corpus.record(), outDir)
await writeSourceRightsRecord(registry.record(), registryOutDir)
