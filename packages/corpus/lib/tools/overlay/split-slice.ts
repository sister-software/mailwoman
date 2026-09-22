/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Route an already-written overlay parquet through the holdout policy.
 *
 *   `mailwoman corpus build` decides a split for every row it aligns, so a base corpus honors
 *   `defaultHoldouts()` by construction. An overlay parquet never passes through that loop: it is
 *   written by a recipe and appended to a manifest as a train file. A country whose only rows of a
 *   given kind live in an overlay therefore has no held-out row of that kind, however the policy
 *   reads.
 *
 *   GB is that country. Every GB street row comes from `synth-gb`, which is an overlay, so the
 *   postcode areas the GB holdout names appear in the train split and nowhere else.
 *
 *   This reads a written parquet rather than a recipe's JSONL, because the carried overlays are
 *   parquet and their recipe outputs are not all still on disk. A parquet row carries no
 *   `components` map, so each component is read back from `raw` over the `span_starts` /
 *   `span_ends` / `span_tags` triple, which is the encoding `alignRow` wrote.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { basename } from "path-ts"
import type { PathBuilderLike } from "path-ts"

import type { ParquetRow } from "#parquet/schema"
import { openParquetRowStream } from "#parquet/streams"
import { writeParquetFile } from "#parquet/writers"
import type { CanonicalRow } from "#types"
import { type CountryHoldout, defaultHoldouts, type SplitName, splitForRow } from "#utils/split"

/**
 * The component tags the holdout policy reads.
 *
 * `splitForRow` consults `region`, `postcode` and `locality` and nothing else, so reconstructing
 * the rest of a row's components would cost a string slice per span for no decision.
 */
const HOLDOUT_TAGS = new Set<string>(["region", "postcode", "locality"])

/**
 * The fields {@linkcode holdoutComponents} reads, with the span triple optional.
 *
 * A {@linkcode ParquetRow} declares all three as present and satisfies this.
 * Declaring them optional here is what lets the absent-triple case be constructed without a cast,
 * so the refusal below is reachable from a test rather than only from a corrupt file.
 */
export interface SpannedRow {
	raw: string
	source_id: string
	span_starts?: readonly number[]
	span_ends?: readonly number[]
	span_tags?: readonly string[]
}

/**
 * Read the components a holdout decision needs back out of one labeled row.
 *
 * Raises on a row whose span triple is absent or not parallel.
 * A row that cannot be read is not a row with no held-out component: treating it as one
 * would put it in the train split, which is the outcome this whole file exists to prevent.
 */
export function holdoutComponents(row: SpannedRow, index: number, input: string): CanonicalRow["components"] {
	const { raw, span_starts: starts, span_ends: ends, span_tags: tags } = row

	if (!starts || !ends || !tags) {
		throw new Error(
			`${input} row ${index} (${row.source_id}) carries no span triple, so its components cannot be read. ` +
				`Re-emit the file through \`alignRow\` before splitting it.`
		)
	}

	if (starts.length !== ends.length || starts.length !== tags.length) {
		throw new Error(
			`${input} row ${index} (${row.source_id}) has a span triple of ${starts.length}/${ends.length}/${tags.length}; ` +
				`the three are parallel arrays and must agree in length.`
		)
	}

	const components: Record<string, string> = {}

	for (const [span, tag] of tags.entries()) {
		if (!HOLDOUT_TAGS.has(tag) || components[tag] !== undefined) continue

		components[tag] = raw.slice(starts[span]!, ends[span]!)
	}

	return components as Partial<Record<ComponentTag, string>>
}

export interface SplitSliceOptions {
	/**
	 * The parquet to route.
	 * Its rows are read once and held per split in memory.
	 */
	input: PathBuilderLike
	/**
	 * Where the per-split parquets are written.
	 * Each is named for the input plus its split.
	 */
	outputDir: PathBuilderLike
	/**
	 * Defaults to `defaultHoldouts()`, which is the policy the base build applies.
	 */
	holdouts?: Record<string, CountryHoldout>
}

export interface SplitSliceResult {
	input: string
	rows: number
	counts: Record<SplitName, number>
	/**
	 * The file written per split.
	 *
	 * A split that drew no row is absent rather than an empty parquet, because a manifest
	 * entry for an empty file reads as a file whose rows were lost.
	 */
	outputs: Partial<Record<SplitName, string>>
}

/**
 * Split one overlay parquet into up to three, by the same policy the base build applies.
 *
 * The output names extend the input's, so `part-gb.parquet` becomes `part-gb.train.parquet`,
 * `part-gb.val.parquet` and `part-gb.test.parquet`.
 * The input is left in place.
 */
export async function splitOverlaySlice(options: SplitSliceOptions): Promise<SplitSliceResult> {
	const input = String(options.input)
	const holdouts = options.holdouts ?? defaultHoldouts()
	const stem = basename(input).replace(/\.parquet$/u, "")

	const buckets: Record<SplitName, ParquetRow[]> = { train: [], val: [], test: [] }
	let index = 0

	for await (const row of openParquetRowStream<ParquetRow>(input)) {
		const components = holdoutComponents(row, index, input)
		const split = splitForRow({ source_id: row.source_id, country: row.country, components }, holdouts)

		buckets[split].push(row)

		index++
	}

	const outputs: Partial<Record<SplitName, string>> = {}

	for (const split of ["train", "val", "test"] as const) {
		if (!buckets[split].length) continue

		const output = `${String(options.outputDir)}/${stem}.${split}.parquet`

		await writeParquetFile(buckets[split], output)
		outputs[split] = output
	}

	return {
		input,
		rows: index,
		counts: { train: buckets.train.length, val: buckets.val.length, test: buckets.test.length },
		outputs,
	}
}
