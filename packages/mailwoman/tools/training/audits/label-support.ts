/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Counts the validation rows that hold each head label, and refuses a launch below a declared floor.
 *
 *   `macro_f1` averages every label with nonzero support as one equal term, so a label three validation rows hold
 *   moves it as much as one two thousand rows hold, and swings with each of its three rows: `po_box` entered
 *   v7.2.0's macro score from 3 rows of 4,096 (#2438). The count reads the draw the trainer scores: the same split,
 *   row limit and seed, encoded as the trainer encodes it. A row holds a label when one of its pieces carries the
 *   label's `B-` tag.
 */

import type { TrainingConfig } from "@mailwoman/corpus/training/config/schema"
import type { MTFNode, SampledRow } from "@mailwoman/mtf/tools/sampler/native"
import { bioLabelsOf, IGNORE_INDEX, LABEL_SETS, type LabelSetName } from "@mailwoman/neural/labels"

import { createConfigRowEncoder, LABEL_SCHEMA_PATH, openSampler, sampledBatches } from "../sampler.ts"
import { AuditFloorError } from "./receipt.ts"

/**
 * The component tags a row holds, read from the `B-` labels among its piece labels,
 * in first-appearance order.
 */
export function headLabels(labelIDs: Iterable<number>, bioLabels: readonly string[]): string[] {
	const present: string[] = []

	for (const id of labelIDs) {
		if (id === IGNORE_INDEX) continue

		const name = bioLabels[id]

		if (name?.startsWith("B-") && !present.includes(name.slice(2))) {
			present.push(name.slice(2))
		}
	}

	return present
}

/**
 * The encoder a config's draw is labeled with: the row encoder, or the char encoder on the char path.
 * Either returns each row's label ids.
 */
function labelEncoder(mtf: MTFNode, data: TrainingConfig["data"]): (rows: SampledRow[]) => number[][] {
	if (data.char_mode === "off") {
		const encoder = createConfigRowEncoder(mtf, data)

		return (rows) => {
			const batch = encoder.encodeBatch(rows)

			return rows.map((_, r) =>
				Array.from(batch.labels.subarray(r * batch.maxLength, (r + 1) * batch.maxLength), Number)
			)
		}
	}

	if (!data.char_vocab_path)
		throw new Error("data.char_mode requires data.char_vocab_path (build_char_vocab's sealed JSON)")

	const encoder = mtf.createCharEncoder({
		mode: data.char_mode as "word" | "char",
		vocabPath: data.char_vocab_path,
		maxUnits: data.max_units ?? data.max_length,
		maxUnitWidth: data.max_unit_width,
		charCtx: data.char_ctx,
		labelSet: data.label_set,
		labelSchemaPath: LABEL_SCHEMA_PATH,
	})

	return (rows) => {
		const batch = encoder.encodeBatch(rows)

		return rows.map((_, r) => Array.from(batch.labels.subarray(r * batch.maxUnits, (r + 1) * batch.maxUnits), Number))
	}
}

/**
 * Rows in the trainer's draw of `split`, and the rows that hold each label.
 */
export function countLabelRows(
	mtf: MTFNode,
	config: TrainingConfig,
	options: { split: string; rowLimit: number | null; seed: number }
): { total: number; rowsWith: Map<string, number> } {
	const name = config.data.label_set as LabelSetName
	const tags = LABEL_SETS[name]

	if (!tags) throw new Error(`unknown label set '${name}'`)

	const bio = bioLabelsOf(tags)
	const encode = labelEncoder(mtf, config.data)
	const sampler = openSampler(mtf, config, options.split, options.seed, { rowLimit: options.rowLimit })
	const rowsWith = new Map<string, number>()
	let total = 0

	for (const rows of sampledBatches(sampler, 256)) {
		for (const labels of encode(rows)) {
			total++

			for (const label of headLabels(labels, bio)) {
				rowsWith.set(label, (rowsWith.get(label) ?? 0) + 1)
			}
		}
	}

	return { total, rowsWith }
}

type LabelFloor = TrainingConfig["data"]["required_validation_label_support"][number]

/**
 * The declared floors the counted splits miss.
 *
 * A label a split holds no row for counts zero rows, and a split that was not
 * counted is reported as unmeasured.
 */
export function failingLabelFloors(counts: Record<string, Record<string, number>>, required: readonly LabelFloor[]) {
	const failures: Array<Record<string, unknown>> = []

	for (const entry of required) {
		const measured = counts[entry.split]

		if (!measured) {
			failures.push({
				label: entry.label,
				split: entry.split,
				rows: null,
				min_rows: entry.min_rows,
				because: `split '${entry.split}' was not counted`,
			})

			continue
		}

		const rows = measured[entry.label] ?? 0

		if (rows < entry.min_rows) {
			failures.push({
				label: entry.label,
				split: entry.split,
				rows,
				min_rows: entry.min_rows,
				because: `${rows.toLocaleString("en-US")} rows hold ${entry.label} against a floor of ${entry.min_rows.toLocaleString("en-US")}`,
			})
		}
	}

	return failures
}

/**
 * Counts each declared split's label support and judges the floors.
 * The report is complete before a refusal.
 */
export function labelSupportReport(mtf: MTFNode, config: TrainingConfig, configName: string) {
	const required = config.data.required_validation_label_support
	const splits = [...new Set(required.map((entry) => entry.split))].toSorted()

	if (!splits.length) {
		splits.push("val")
	}

	const counts: Record<string, Record<string, number>> = {}
	const totals: Record<string, number> = {}

	for (const split of splits) {
		const seed = split === "val" ? config.train.seed + 1 : config.train.seed + 2
		const { total, rowsWith } = countLabelRows(mtf, config, { split, rowLimit: config.data.val_rows, seed })

		totals[split] = total
		counts[split] = Object.fromEntries(rowsWith)
	}

	const failures = failingLabelFloors(counts, required)

	const report = {
		config: configName,
		corpus_dir: config.data.corpus_dir,
		splits: Object.fromEntries(splits.map((split) => [split, { rows: totals[split], rows_with_label: counts[split] }])),
		required_validation_label_support: {
			declared: required.map((entry) => ({ label: entry.label, split: entry.split, min_rows: entry.min_rows })),
			failures,
		},
	}

	const error = failures.length
		? new AuditFloorError(
				`${failures.length} of ${required.length} declared label-support floors are not met:\n` +
					failures.map((f) => `  ${f.label} / ${f.split}: ${f.because}`).join("\n"),
				report
			)
		: null

	return { report, error }
}
