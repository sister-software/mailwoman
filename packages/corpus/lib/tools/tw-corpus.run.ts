/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Assembles the Taiwan corpus from Overture-TW, then writes its `SOURCE_RIGHTS.json`.
 *
 *   Usage:
 *     node packages/corpus/lib/tools/tw-corpus.run.ts --out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-tw-<date>
 *       [--parquet <addresses-tw.parquet>] [--train-rows 2000000] [--val-rows 20000] [--board-rows 20000]
 *       [--board-bucket-min 90] [--rows-per-part 250000] [--stats-sample-per-part 50000] [--country-fraction 0.05]
 *       [--max-field-chars 64] [--max-row-groups <n>] [--seed 42] [--force] [--unshippable-reason <why>]
 */

import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"

import { openSourceRightsAdmission, writeSourceRightsRecord } from "#source-register/corpus-inputs"
import { buildTWCorpus, TW_CORPUS_DEFAULTS } from "#tw/corpus/assemble"
import { TW_CORPUS_SOURCE, twOvertureParquetPath } from "#tw/corpus/rows"

const text = (value: number) => ({ type: "string" as const, default: String(value) })

const { values } = parseArguments({
	options: {
		parquet: { type: "string" },
		"out-dir": { type: "string" },
		"train-rows": text(TW_CORPUS_DEFAULTS.trainRows),
		"val-rows": text(TW_CORPUS_DEFAULTS.valRows),
		"board-rows": text(TW_CORPUS_DEFAULTS.boardRows),
		"board-bucket-min": text(TW_CORPUS_DEFAULTS.boardBucketMin),
		"rows-per-part": text(TW_CORPUS_DEFAULTS.rowsPerPart),
		"stats-sample-per-part": text(TW_CORPUS_DEFAULTS.statsSamplePerPart),
		"country-fraction": text(TW_CORPUS_DEFAULTS.countryFraction),
		"max-field-chars": text(TW_CORPUS_DEFAULTS.maxFieldChars),
		"max-row-groups": { type: "string" },
		seed: text(TW_CORPUS_DEFAULTS.seed),
		force: { type: "boolean", default: false },
		"unshippable-reason": { type: "string" },
	},
})

const integer = (name: string, value: string): number => {
	const parsed = Number(value)

	if (!Number.isSafeInteger(parsed)) throw new Error(`--${name} must be an integer, got ${value}`)

	return parsed
}

const outDir = requiredArgument("tw-corpus", "--out-dir", values["out-dir"])

const admission = await openSourceRightsAdmission({
	context: "TW corpus assembly",
	unshippableReason: values["unshippable-reason"] ?? null,
})

admission.admitAll([TW_CORPUS_SOURCE])

await buildTWCorpus({
	parquet: values.parquet ?? twOvertureParquetPath(),
	outDir,
	trainRows: integer("train-rows", values["train-rows"]),
	valRows: integer("val-rows", values["val-rows"]),
	boardRows: integer("board-rows", values["board-rows"]),
	boardBucketMin: integer("board-bucket-min", values["board-bucket-min"]),
	rowsPerPart: integer("rows-per-part", values["rows-per-part"]),
	statsSamplePerPart: integer("stats-sample-per-part", values["stats-sample-per-part"]),
	countryFraction: Number(values["country-fraction"]),
	maxFieldChars: integer("max-field-chars", values["max-field-chars"]),
	maxRowGroups: values["max-row-groups"] ? integer("max-row-groups", values["max-row-groups"]) : undefined,
	seed: integer("seed", values.seed),
	force: values.force,
})

await writeSourceRightsRecord(admission.record(), outDir)
