/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The battery's last step: fold both promotion locks into one exit code, then narrate the ledger append.
 *
 *   Separate from `verdict.ts` because the two answer different questions. The assembler there reads the battery's
 *   artifacts and decides whether every floor was met. this file decides what the process returns, which also depends
 *   on the mask-regression check the runner ran outside the assembler's view.
 */

import { isoDate } from "@mailwoman/core/utils"
import type { PathBuilderLike } from "path-ts"

import { assemblePromotionVerdict } from "#eval-harness/promotion/eval/verdict"

/**
 * Options for {@linkcode finalizePromotionVerdict}.
 */
export interface FinalizeVerdictOptions {
	/**
	 * The model card the battery graded against, echoed into the printed ledger command.
	 */
	card: PathBuilderLike
	/**
	 * Path to the eval spec JSON (already resolved to a real file).
	 */
	check: string
	/**
	 * True when `--weights-cache` named the graded artifact. It the verdict records. Therefore, a reader can tell a
	 * staged candidate's numbers from the installed package's.
	 */
	gradedFromWeightsCache: boolean
	/**
	 * The run label, lowered into the printed `--run-id`.
	 */
	label: string
	/**
	 * The mask-regression check's status as the runner already computed it — 0 when it passed or was skipped.
	 */
	maskCheckStatus: number
	/**
	 * The promotion-eval out-dir carrying the battery outputs.
	 */
	outDir: PathBuilderLike
	/**
	 * Also collect the int8 battery and enforce the fp32↔int8 delta cap.
	 */
	withInt8: boolean
}

/**
 * Return the battery's exit code: 0 only when every floor was met and the mask-regression lock held. Either miss fails
 * the evaluation.
 *
 * On a pass, print the ledger-append command with everything pre-filled. It is printed rather than executed: the
 * battery runs on candidates that may never publish, and the ledger records published versions keyed by npm semver, so
 * the release-prep flow runs this line with the real version. Appending used to rely on a person remembering it, and
 * the ledger froze for several versions.
 */
export async function finalizePromotionVerdict(options: FinalizeVerdictOptions): Promise<number> {
	let verdictStatus: number

	try {
		const { failed } = await assemblePromotionVerdict({
			check: options.check,
			outDir: options.outDir,
			withInt8: options.withInt8,
			...(options.gradedFromWeightsCache ? { gradedArtifact: "weights-cache" as const } : {}),
		})

		verdictStatus = failed ? 1 : 0
	} catch (error) {
		console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))

		verdictStatus = 1
	}

	if (verdictStatus !== 0 || options.maskCheckStatus !== 0) {
		if (options.maskCheckStatus !== 0) {
			console.error(`✗ check FAILED the mask-regression lock (#718) — see ${options.outDir}/mask-regression.md`)
		}

		return 1
	}

	const shipDate = isoDate()

	console.log(
		`\nledger (#885): on promote, append this run —\n` +
			`  node packages/mailwoman/out/cli/index.js eval ledger-append \\\n` +
			`    --out-dir ${options.outDir} --model-version <npm-semver> \\\n` +
			`    --run-id ${options.label.replaceAll(/[^a-z0-9-]/g, "-")}-${shipDate.replaceAll("-", "")} \\\n` +
			`    --model-path "@mailwoman/neural-weights-en-us@<npm-semver>" --card ${options.card}`
	)

	return 0
}
