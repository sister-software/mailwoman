/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two passes every mixture census runs over one epoch: the rows the source mixture draws, and the rows the
 *   trainer's emit step makes of the same stream.
 *
 *   Both passes open the mixture at the same seed. The draw pass reads it straight. The emit pass runs each drawn
 *   row through augmentation, with the config's per-source exclusions, on the same generator, and stops once the
 *   row budget is filled. Neither pass runs the shuffle buffer, which reorders rows without changing counts, or
 *   the affix relabel, which rewrites labels without adding or removing rows. The grouping augmentation is left
 *   off, as the Python audits' emit policy left it.
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"
import type { TrainingConfig } from "@mailwoman/corpus/training/config/schema"
import { mtfNode, type MTFNode, type SampledRow } from "@mailwoman/mtf/tools/sampler/native"

import { loadTrainingConfig } from "../config.ts"
import { configAugment, emittedDraws, openRawRows, type AugmentProbabilities } from "../sampler.ts"
import { writeAuditReport, type AuditReportOptions } from "./receipt.ts"

/**
 * The augmentations the audits' emit policy applies, in `augment_row`'s draw order.
 */
export const AUDIT_AUGMENTATIONS = [
	"directional",
	"region",
	"glue",
	"case",
	"punct_drop",
	"upper_case",
	"ordinal",
	"postcode_move",
] as const

/**
 * A config's augmentation probabilities as the audits apply them: every audit
 * augmentation, grouping left out.
 */
export function auditAugment(data: TrainingConfig["data"]): Record<(typeof AUDIT_AUGMENTATIONS)[number], number> {
	const all = configAugment(data)

	return Object.fromEntries(AUDIT_AUGMENTATIONS.map((name) => [name, all[name]])) as Record<
		(typeof AUDIT_AUGMENTATIONS)[number],
		number
	>
}

/**
 * What one census reads.
 */
export interface CensusOptions {
	seed: number
	draws: number
	/**
	 * Replaces the config's augmentation probabilities for the emit pass.
	 */
	augment?: Partial<AugmentProbabilities>
}

/**
 * The first `draws` rows the mixture draws at `seed`.
 */
export function* drawnRows(mtf: MTFNode, config: TrainingConfig, options: CensusOptions): Generator<SampledRow> {
	const stream = openRawRows(mtf, config, "train", options.seed, { affixRelabelLexiconPath: null, augment: {} })
	let remaining = options.draws

	// Each read asks for no row past the budget, so a row the Python pass never read cannot fail this one.
	while (remaining > 0) {
		const rows = stream.nextRaw(Math.min(remaining, DRAW_CHUNK))

		if (!rows.length) return

		remaining -= rows.length
		yield* rows
	}
}

/**
 * The rows the draw pass reads from the addon per call.
 */
const DRAW_CHUNK = 4096

/**
 * One emitted row, with its position among the rows its drawn row became:
 * 0 for the drawn row, then its copies.
 */
export interface EmittedRow {
	row: SampledRow
	position: number
}

/**
 * The first `draws` rows the emit step makes of the mixture at `seed`.
 */
export function* emittedRows(mtf: MTFNode, config: TrainingConfig, options: CensusOptions): Generator<EmittedRow> {
	const augment = options.augment ?? auditAugment(config.data)
	const stream = openRawRows(mtf, config, "train", options.seed, { affixRelabelLexiconPath: null, augment })
	let produced = 0

	if (options.draws <= 0) return

	// The pass reads one draw per call.
	// The stream then draws no row past the one that fills the budget.
	for (const { emitted } of emittedDraws(stream, { chunk: 1 })) {
		for (const [position, row] of emitted.entries()) {
			yield { row, position }

			if (++produced >= options.draws) return
		}
	}
}

/**
 * What a census command line names: the config, the report path and the epoch length.
 */
export interface CensusArguments {
	config: string
	json?: string
	draws?: number
}

/**
 * Loads the config, counts one epoch at `train.seed + 1`, writes the report and returns it.
 *
 * `count` receives the loaded addon, the config and the census options.
 * The report is written as the Python audit wrote it, `json.dumps(report, indent=2)`.
 */
export async function runMixtureCensus<R>(
	args: CensusArguments,
	count: (mtf: MTFNode, config: TrainingConfig, options: CensusOptions) => R,
	reportOptions: AuditReportOptions = {}
): Promise<R> {
	const config = await loadTrainingConfig(args.config)
	const mtf = await mtfNode()
	const report = count(mtf, config, { seed: config.train.seed + 1, draws: epochRows(config, args.draws) })

	if (args.json) {
		await writeAuditReport(args.json, report, reportOptions)
	}

	return report
}

/**
 * Parses a census command line: `<config> [--json <path>] [--draws <n>]`.
 */
export function censusArguments(): CensusArguments {
	const { values, positionals } = parseArguments({
		allowPositionals: true,
		options: { json: { type: "string" }, draws: { type: "string" } },
	})

	const [config] = positionals

	if (!config) throw new Error("expected the training config's path")

	return { config, json: values.json, draws: values.draws ? Number(values.draws) : undefined }
}

/**
 * The epoch length a census reads: `--draws` when given, else the config's `train_rows_per_epoch`.
 *
 * @throws When neither is set.
 */
export function epochRows(config: TrainingConfig, draws: number | null | undefined): number {
	const rows = draws || config.data.train_rows_per_epoch

	if (!rows) throw new Error("config has no train_rows_per_epoch — pass --draws for the epoch length")

	return rows
}
