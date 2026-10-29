/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Writes the `fragment-assay` recipe output and its dev holdout, after writing its `SOURCE_RIGHTS.json`
 *   beside the parquet file.
 *
 *   Usage:
 *     node packages/corpus/lib/tools/fragment-assay.run.ts \
 *       --oa-root $MAILWOMAN_DATA_ROOT/openaddresses/extracted \
 *       --corpus-parquet-glob "$MAILWOMAN_DATA_ROOT/corpus/versioned/v0.5.0/**\/train/part-000*.parquet" \
 *       --out-parquet out/part-fragment.parquet --out-dev out/fragment-dev.jsonl \
 *       [--famous-localities-file <names.txt>] [--locality-parquet-glob <glob>] [--ryhti-file <open_address.csv>]
 *       [--per-locale-cap 4000] [--unshippable-reason <why>]
 *
 *   `--locality-parquet-glob` defaults to `LOCALITY_PARQUET_GLOB` under the data root, and an empty value reads the
 *   main glob. `--ryhti-file` defaults to `RYHTI_FILE` under the data root, and an empty value writes no Finnish rows.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import { dirname } from "path-ts"

import { buildFragmentAssay } from "#recipes/fragment-assay/build"
import { FRAGMENT_SOURCE, LOCALITY_PARQUET_GLOB, PER_LOCALE_CAP, RYHTI_FILE } from "#recipes/fragment-assay/sources"
import { openSourceRightsAdmission, writeSourceRightsRecord } from "#source-register/corpus-inputs"

const { values } = parseArguments({
	options: {
		"oa-root": { type: "string" },
		"corpus-parquet-glob": { type: "string" },
		"famous-localities-file": { type: "string", default: "" },
		"locality-parquet-glob": { type: "string" },
		"ryhti-file": { type: "string" },
		"out-parquet": { type: "string" },
		"out-dev": { type: "string" },
		"per-locale-cap": { type: "string", default: String(PER_LOCALE_CAP) },
		"unshippable-reason": { type: "string" },
	},
})

const command = "fragment-assay"
const outParquet = requiredArgument(command, "--out-parquet", values["out-parquet"])
const cap = Number(values["per-locale-cap"])

if (!Number.isSafeInteger(cap)) throw new Error(`--per-locale-cap must be an integer, got ${values["per-locale-cap"]}`)

const admission = await openSourceRightsAdmission({
	context: "fragment-assay build",
	unshippableReason: values["unshippable-reason"] ?? null,
})

admission.admitAll([FRAGMENT_SOURCE])
await writeSourceRightsRecord(admission.record(), dirname(outParquet))

await buildFragmentAssay({
	oaRoot: requiredArgument(command, "--oa-root", values["oa-root"]),
	corpusParquetGlob: requiredArgument(command, "--corpus-parquet-glob", values["corpus-parquet-glob"]),
	famousLocalitiesFile: values["famous-localities-file"],
	localityParquetGlob: values["locality-parquet-glob"] ?? dataRootPath(LOCALITY_PARQUET_GLOB).toString(),
	ryhtiFile: values["ryhti-file"] ?? dataRootPath(RYHTI_FILE).toString(),
	outParquet,
	outDev: requiredArgument(command, "--out-dev", values["out-dev"]),
	perLocaleCap: cap,
})
