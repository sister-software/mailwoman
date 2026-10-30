/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Builds the secondary-address recipe output: one parquet file, its `SOURCE_RIGHTS.json`, and a
 *   200-row development sample.
 *
 *   Usage:
 *     node packages/corpus/lib/tools/secondary.run.ts \
 *       --out-parquet "$MAILWOMAN_DATA_ROOT/corpus/staging/secondary/part-secondary.parquet" \
 *       --out-dev out/secondary-dev.jsonl [--cap 400] [--unshippable-reason <why>]
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { orderedJSON } from "@mailwoman/core/json"
import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import { dirname, resolvePath } from "path-ts"

import { ParquetColumnKind, type ParquetColumns, writeColumnParquetFile } from "#parquet/writers"
import {
	checkSecondaryRows,
	generateSecondaryRows,
	SECONDARY_DEFAULT_CAP,
	SECONDARY_SOURCE,
	secondaryTagCoverage,
} from "#recipes/secondary"
import { openSourceRightsAdmission, writeSourceRightsRecord } from "#source-register/corpus-inputs"
import { stampRowLicenses } from "#source-register/row-license"

/**
 * The columns `pyarrow.Table.from_pylist` inferred for these rows, in their order.
 */
const SECONDARY_COLUMNS: ParquetColumns = [
	["raw", ParquetColumnKind.String],
	["tokens", ParquetColumnKind.StringList],
	["labels", ParquetColumnKind.StringList],
	["span_starts", ParquetColumnKind.Int64List],
	["span_ends", ParquetColumnKind.Int64List],
	["span_tags", ParquetColumnKind.StringList],
	["source", ParquetColumnKind.String],
	["license", ParquetColumnKind.String],
]

const DEV_ROWS = 200
const CONTEXT = "synthetic-secondary build"

const { values } = parseArguments({
	options: {
		"out-parquet": { type: "string" },
		"out-dev": { type: "string" },
		cap: { type: "string", default: String(SECONDARY_DEFAULT_CAP) },
		"unshippable-reason": { type: "string" },
	},
})

const outParquet = resolvePath(requiredArgument("secondary", "--out-parquet", values["out-parquet"]))
const outDev = resolvePath(requiredArgument("secondary", "--out-dev", values["out-dev"]))
const cap = Number(values.cap)

if (!Number.isSafeInteger(cap) || cap < 0) throw new Error(`--cap must be a non-negative integer, got ${values.cap}`)

const admission = await openSourceRightsAdmission({
	context: CONTEXT,
	unshippableReason: values["unshippable-reason"] ?? null,
})

admission.admitAll([SECONDARY_SOURCE])
await writeSourceRightsRecord(admission.record(), dirname(outParquet))

const rows = generateSecondaryRows(cap)

checkSecondaryRows(rows)

await writeColumnParquetFile(await stampRowLicenses(rows, CONTEXT), SECONDARY_COLUMNS, outParquet)

await writeLocalTextFile(
	rows
		.slice(0, DEV_ROWS)
		.map((row) => orderedJSON(row) + "\n")
		.join(""),
	outDev
)

console.log(`secondary recipe output: ${rows.length} rows -> ${outParquet}`)

const coverage = [...secondaryTagCoverage(rows)].map(([tag, spans]) => `'${tag}': ${spans}`)

console.log(`STAGE4 tag coverage: {${coverage.join(", ")}}`)
