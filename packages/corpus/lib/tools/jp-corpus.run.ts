/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Assembles the Japan corpus from Overture-JP and KEN_ALL, then writes its `SOURCE_RIGHTS.json`.
 *
 *   Usage:
 *     node packages/corpus/lib/tools/jp-corpus.run.ts --out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-jp-<date>
 *       [--parquet <addresses-jp.parquet>] [--kenall <KEN_ALL_ROME.CSV>] [--admin-db <admin.db, or "" to decline>]
 *       [--train-rows 2000000] [--val-rows 20000] [--board-rows 20000] [--rows-per-part 250000]
 *       [--stats-sample-per-part 50000] [--postcode-fraction 0.3] [--country-fraction 0.1] [--spaced-fraction 0.12]
 *       [--variant-hyphen-fraction 0.05] [--max-field-chars 64] [--max-row-groups <n>] [--upweight-pattern REGEX:K]
 *       [--seed 42] [--force] [--unshippable-reason <why>]
 */

import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"

import { buildJPCorpus, JP_CORPUS_DEFAULTS } from "#jp/corpus/assemble"
import { JP_CORPUS_SOURCE } from "#jp/corpus/rows"
import { jpAdminDBPath, jpOvertureParquetPath, kenAllPath } from "#jp/corpus/sources"
import { openSourceRightsAdmission, writeSourceRightsRecord } from "#source-register/corpus-inputs"

const text = (value: number) => ({ type: "string" as const, default: String(value) })

const { values } = parseArguments({
	options: {
		parquet: { type: "string" },
		kenall: { type: "string" },
		"admin-db": { type: "string" },
		"out-dir": { type: "string" },
		"train-rows": text(JP_CORPUS_DEFAULTS.trainRows),
		"val-rows": text(JP_CORPUS_DEFAULTS.valRows),
		"board-rows": text(JP_CORPUS_DEFAULTS.boardRows),
		"rows-per-part": text(JP_CORPUS_DEFAULTS.rowsPerPart),
		"stats-sample-per-part": text(JP_CORPUS_DEFAULTS.statsSamplePerPart),
		"postcode-fraction": text(JP_CORPUS_DEFAULTS.postcodeFraction),
		"country-fraction": text(JP_CORPUS_DEFAULTS.countryFraction),
		"spaced-fraction": text(JP_CORPUS_DEFAULTS.spacedFraction),
		"variant-hyphen-fraction": text(JP_CORPUS_DEFAULTS.variantHyphenFraction),
		"max-field-chars": text(JP_CORPUS_DEFAULTS.maxFieldChars),
		"max-row-groups": { type: "string" },
		"upweight-pattern": { type: "string" },
		seed: text(JP_CORPUS_DEFAULTS.seed),
		force: { type: "boolean", default: false },
		"unshippable-reason": { type: "string" },
	},
})

const integer = (name: string, value: string): number => {
	const parsed = Number(value)

	if (!Number.isSafeInteger(parsed)) throw new Error(`--${name} must be an integer, got ${value}`)

	return parsed
}

const outDir = requiredArgument("jp-corpus", "--out-dir", values["out-dir"])

const admission = await openSourceRightsAdmission({
	context: "JP corpus assembly",
	unshippableReason: values["unshippable-reason"] ?? null,
})

admission.admitAll([JP_CORPUS_SOURCE])

await buildJPCorpus({
	parquet: values.parquet ?? jpOvertureParquetPath(),
	kenall: values.kenall ?? kenAllPath(),
	// An explicit empty string declines the kana register, so only an absent flag means the default.
	adminDB: values["admin-db"] === undefined ? jpAdminDBPath() : values["admin-db"] || null,
	outDir,
	trainRows: integer("train-rows", values["train-rows"]),
	valRows: integer("val-rows", values["val-rows"]),
	boardRows: integer("board-rows", values["board-rows"]),
	rowsPerPart: integer("rows-per-part", values["rows-per-part"]),
	statsSamplePerPart: integer("stats-sample-per-part", values["stats-sample-per-part"]),
	postcodeFraction: Number(values["postcode-fraction"]),
	countryFraction: Number(values["country-fraction"]),
	spacedFraction: Number(values["spaced-fraction"]),
	variantHyphenFraction: Number(values["variant-hyphen-fraction"]),
	maxFieldChars: integer("max-field-chars", values["max-field-chars"]),
	maxRowGroups: values["max-row-groups"] ? integer("max-row-groups", values["max-row-groups"]) : undefined,
	upweightPattern: values["upweight-pattern"] ?? null,
	seed: integer("seed", values.seed),
	force: values.force,
})

await writeSourceRightsRecord(admission.record(), outDir)
