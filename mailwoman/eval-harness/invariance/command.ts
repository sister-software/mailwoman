/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CLI-facing orchestration for `mailwoman eval invariance` — wires suite + transforms + runner
 *   together from argv-shaped options. Thin on purpose: the module the `invariance.tsx` command wraps
 *   narrates everything and owns only the exit code, matching `eval gate` / `eval error-analysis`.
 */

import { type ModelSelectOptions, loadSuite, buildParseFn, runInvarianceSuite } from "./runner.ts"

export interface InvarianceCommandOptions extends ModelSelectOptions {
	/** Alternate suite fixture path. Default the shipped `suite.jsonl`. */
	suite?: string
	/** Fail the gate if the NEW-violation DEGRADED count exceeds this. Default 0. */
	maxDegraded?: number
	/**
	 * `--baseline` regression mode (probe-grading shape, e.g. v385): a baseline candidate ONNX graded on the SAME suite.
	 * Requires `baselineTokenizer` + `baselineModelCard`, or pass `baselineWeightsCache` instead for a package-shaped
	 * dir.
	 */
	baseline?: string
	baselineTokenizer?: string
	baselineModelCard?: string
	/** Package-shaped baseline weights dir — alternative to `baseline` + the two flags above. */
	baselineWeightsCache?: string
}

/** Run the invariance mini-suite from CLI-shaped options. Returns the process exit code (0 = PASS). */
export async function runInvarianceCommand(options: InvarianceCommandOptions): Promise<number> {
	const rows = loadSuite(options.suite)
	console.error(`[invariance] loaded ${rows.length} rows from ${options.suite ?? "the shipped suite.jsonl"}`)

	console.error(`[invariance] loading candidate model…`)
	const parse = await buildParseFn(options)

	let baselineParse: Awaited<ReturnType<typeof buildParseFn>> | undefined

	if (options.baselineWeightsCache || options.baseline) {
		console.error(`[invariance] loading baseline model (regression mode)…`)
		baselineParse = await buildParseFn({
			weightsCache: options.baselineWeightsCache,
			model: options.baselineWeightsCache ? undefined : options.baseline,
			tokenizer: options.baselineTokenizer,
			modelCard: options.baselineModelCard,
			locale: options.locale,
		})
	}

	const result = await runInvarianceSuite({
		rows,
		parse,
		...(baselineParse ? { baselineParse } : {}),
		maxDegraded: options.maxDegraded,
	})

	return result.exitCode
}
