/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Builds the v8 JP probe corpus from Overture-JP, then writes its `SOURCE_RIGHTS.json`.
 *
 *   Usage:
 *     node packages/corpus/lib/tools/jp-probe-corpus.run.ts [--parquet <addresses-jp.parquet>]
 *       [--kenall <KEN_ALL_ROME.CSV>] [--out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-jp-probe]
 *       [--train-rows 200000] [--val-rows 4000] [--board-rows 2000] [--postcode-fraction 0.3] [--seed 42]
 *       [--unshippable-reason <why>]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { pythonJSONDumps } from "@mailwoman/core/strings/python-json"

import { buildJPProbeCorpus, JP_PROBE_DEFAULTS, JP_PROBE_SOURCE } from "#jp/corpus/probe"
import { jpOvertureParquetPath, kenAllPath } from "#jp/corpus/sources"
import { openSourceRightsAdmission, writeSourceRightsRecord } from "#source-register/corpus-inputs"

const text = (value: number) => ({ type: "string" as const, default: String(value) })

const { values } = parseArguments({
	options: {
		parquet: { type: "string" },
		kenall: { type: "string" },
		"out-dir": { type: "string" },
		"train-rows": text(JP_PROBE_DEFAULTS.trainRows),
		"val-rows": text(JP_PROBE_DEFAULTS.valRows),
		"board-rows": text(JP_PROBE_DEFAULTS.boardRows),
		"postcode-fraction": text(JP_PROBE_DEFAULTS.postcodeFraction),
		seed: text(JP_PROBE_DEFAULTS.seed),
		"unshippable-reason": { type: "string" },
	},
})

const integer = (name: string, value: string): number => {
	const parsed = Number(value)

	if (!Number.isSafeInteger(parsed)) throw new Error(`--${name} must be an integer, got ${value}`)

	return parsed
}

const outDir = values["out-dir"] ?? dataRootPath("corpus", "versioned", "v8-jp-probe").toString()

const admission = await openSourceRightsAdmission({
	context: "JP probe corpus",
	unshippableReason: values["unshippable-reason"] ?? null,
})

admission.admitAll([JP_PROBE_SOURCE])

const report = await buildJPProbeCorpus({
	parquet: values.parquet ?? jpOvertureParquetPath().toString(),
	kenAll: values.kenall ?? kenAllPath().toString(),
	outDir,
	trainRows: integer("train-rows", values["train-rows"]),
	valRows: integer("val-rows", values["val-rows"]),
	boardRows: integer("board-rows", values["board-rows"]),
	postcodeFraction: Number(values["postcode-fraction"]),
	seed: integer("seed", values.seed),
})

await writeSourceRightsRecord(admission.record(), outDir)

console.log(pythonJSONDumps(report, { indent: 2 }))
