/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Builds the v8 JP probe corpus from Overture-JP, then writes its `SOURCE_RIGHTS.json`.
 *
 *   Usage:
 *     node packages/corpus/lib/tools/jp/probe-corpus.run.ts [--parquet <addresses-jp.parquet>]
 *       [--kenall <KEN_ALL_ROME.CSV>] [--out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-jp-probe]
 *       [--train-rows 200000] [--val-rows 4000] [--board-rows 2000] [--postcode-fraction 0.3] [--seed 42]
 *       [--unshippable-reason <why>]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { orderedJSON } from "@mailwoman/core/json"
import { integerArgument, parseArguments } from "@mailwoman/core/scripting/arguments"

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
	trainRows: integerArgument("train-rows", values["train-rows"]),
	valRows: integerArgument("val-rows", values["val-rows"]),
	boardRows: integerArgument("board-rows", values["board-rows"]),
	postcodeFraction: Number(values["postcode-fraction"]),
	seed: integerArgument("seed", values.seed),
})

await writeSourceRightsRecord(admission.record(), outDir)

console.log(orderedJSON(report, { indent: "\t" }))
