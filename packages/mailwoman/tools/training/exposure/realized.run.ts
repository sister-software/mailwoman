/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Writes the `realized_draws` exposure report of one Rust training segment, `exposure-realized-from-<step>.json`.
 *
 *   `trainer train` writes the rows each consumed batch held to `exposure-realized-from-<step>.rows.jsonl.zst` and,
 *   when the run ends, the description `exposure-realized-from-<step>.rows.json`, which records the stream's file
 *   name, its row count, the label set and the report's inputs. This tool counts the rows with the same `StageCounter` and
 *   phenomena as `exposure.run.ts` and writes the report the Python loop wrote in-process, beside the description
 *   unless `--json` names another path. It refuses a stream whose row count differs from the description's.
 *
 *   Usage:
 *     node packages/mailwoman/tools/training/exposure/realized.run.ts \
 *       <output_dir>/exposure-realized-from-0.rows.json [--json <report.json>]
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { mtfNode } from "@mailwoman/mtf/tools/sampler/native"
import type { LabelSetName } from "@mailwoman/neural/labels"
import { labelSetContract } from "@mailwoman/neural/semantic-tags"
import { readAddressSystemRegistry } from "@mailwoman/neural/tools/address-system-registry"
import { dirname, join } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { writeAuditReport } from "../audits/receipt.ts"
import { addressSystemLookup, buildReport, codeRevision, measuredAt, StageCounter } from "./report.ts"

/**
 * The schema of the description `trainer train` writes, `REALIZED_ROWS_SCHEMA`
 * in `trainer-loop`'s `realized.rs`.
 */
const REALIZED_ROWS_SCHEMA = "mailwoman.realized-rows/v1"

/**
 * The description of one segment's stream.
 */
interface RealizedRowsDescription {
	schema: string
	rows: string
	row_count: number
	label_set: LabelSetName
	inputs: {
		output_dir: string
		corpus_dir: string
		counted_from_step: string
		counted_to_step: string
	}
}

/**
 * One consumed row as the stream stores it.
 */
interface RealizedRow {
	raw: string
	country: string | null
	span_starts: number[] | null
	span_ends: number[] | null
	span_tags: string[] | null
}

const { values, positionals } = parseArguments({
	allowPositionals: true,
	options: { json: { type: "string" } },
})

const descriptionPath = positionals[0]

if (!descriptionPath) throw new Error("usage: realized.run.ts <exposure-realized-from-<step>.rows.json> [--json <out>]")

const description = await readLocalJSONFile<RealizedRowsDescription>(descriptionPath)

if (description.schema !== REALIZED_ROWS_SCHEMA) {
	throw new Error(`${descriptionPath}: schema ${description.schema}, this tool reads ${REALIZED_ROWS_SCHEMA}`)
}

const mtf = await mtfNode()
const registry = await readAddressSystemRegistry()

if (!registry) throw new Error("the address-system registry is missing; run `mailwoman dev generate address-systems`")

const realized = new StageCounter("realized_draws", addressSystemLookup(registry, mtf.pythonText), mtf.pythonText)
const rowsPath = join(dirname(descriptionPath), description.rows)
let rows = 0

for await (const row of JSONSpliterator.fromAsync<RealizedRow>(rowsPath)) {
	realized.addSpanRow({
		raw: row.raw,
		country: row.country,
		spanStarts: row.span_starts,
		spanEnds: row.span_ends,
		spanTags: row.span_tags,
	})

	rows++
}

if (rows !== description.row_count) {
	throw new Error(`${rowsPath}: read ${rows} rows, the description records ${description.row_count}`)
}

const { inputs } = description

const report = buildReport([realized], {
	labelSet: labelSetContract(description.label_set),
	inputs: new Map([
		["output_dir", inputs.output_dir],
		["corpus_dir", inputs.corpus_dir],
		["counted_from_step", inputs.counted_from_step],
		["counted_to_step", inputs.counted_to_step],
	]),
	codeRevision: await codeRevision(),
	measuredAt: measuredAt(),
	registry,
})

const out = values.json ?? join(dirname(descriptionPath), `exposure-realized-from-${inputs.counted_from_step}.json`)

await writeAuditReport(out, report, { trailingNewline: true })

console.log(`[exposure] realized draws (${rows} rows) → ${out}`)
