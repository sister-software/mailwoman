/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Route an already-written overlay parquet through the holdout policy.
 *
 * A parquet row carries no `components` map, so each component is read back from `raw` over the `span_starts` /
 * `span_ends` / `span_tags` triple that `alignRow` wrote.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { basename, type PathBuilderLike, resolvePath } from "path-ts"

import type { ParquetRow } from "#parquet/schema"
import { openParquetRowStream } from "#parquet/streams"
import { writeParquetFile } from "#parquet/writers"
import type { CanonicalRow } from "#types"
import { type CountryHoldout, defaultHoldouts, type SplitName, splitForRow } from "#utils/split"

/**
 * The component tags the holdout policy reads.
 *
 * `splitForRow` consults `region`, `postcode` and `locality` and no other field,
 * so reconstructing the rest would cost a string slice per span for no decision.
 */
const HOLDOUT_TAGS = new Set<string>(["region", "postcode", "locality"])

/**
 * The fields {@linkcode holdoutComponents} reads, with the span triple optional
 * so the absent-triple refusal is reachable from a test rather than only from a corrupt file.
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
 * Raises on an absent or non-parallel span triple, because treating an unreadable row
 * as one with no held-out component would put it in the train split.
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
	 * The file written per split; a split that drew no row is absent rather than an
	 * empty parquet, which would read as a file whose rows were lost.
	 */
	outputs: Partial<Record<SplitName, string>>
}

/**
 * Split one overlay parquet into up to three, by the same policy the base build applies.
 *
 * Each output is named for the input plus its split, and the input is left in place.
 */
export async function splitOverlaySlice(options: SplitSliceOptions): Promise<SplitSliceResult> {
	const input = options.input.toString()
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

		const output = resolvePath(options.outputDir, `${stem}.${split}.parquet`)

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
