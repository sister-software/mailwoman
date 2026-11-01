/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This module measures a training run's step rate from its `train_log.csv`. The measured seconds per 100 steps is
 *   the unit `OBSERVED_SECONDS_PER_100_STEPS` in `tools/training/launch/wall-clock.ts` records.
 */

import { TextSpliterator } from "spliterator"

/**
 * The step rate of one run, with the time spent before each restart counted once.
 */
export interface TrainLogRate {
	finalStep: number
	wallSeconds: number
	secondsPer100Steps: number
	restarts: number
}

/**
 * Measures one `train_log.csv`, whose first two columns are the step and the elapsed seconds.
 *
 * An evaluation row repeats its training row's step, so only a step
 * or an elapsed clock that decreases marks a restart.
 * The first segment is measured from zero.
 *
 * A later segment is measured from its first row.
 * That rule measures both an elapsed clock that restarts with the process
 * and one that resumes from the checkpoint.
 *
 * @throws When the log has no numeric rows.
 */
export function measureTrainLog(csv: string): TrainLogRate {
	let restarts = 0
	let previousStep = -1
	let previousElapsed = -1
	let segmentStart = 0
	let wallSeconds = 0

	for (const line of TextSpliterator.from(csv)) {
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- only the first two fields of one row are read
		const [stepText, elapsedText] = line.split(",")
		const step = Number(stepText)
		const elapsed = Number(elapsedText)

		if (!stepText?.trim() || !elapsedText?.trim() || !Number.isFinite(step) || !Number.isFinite(elapsed)) continue

		if (previousStep >= 0 && (step < previousStep || elapsed < previousElapsed)) {
			restarts += 1
			wallSeconds += previousElapsed - segmentStart
			segmentStart = elapsed
		}

		previousStep = step
		previousElapsed = elapsed
	}

	if (previousStep < 0) throw new Error("train_log.csv has no rows with a numeric step and elapsed time")

	wallSeconds += previousElapsed - segmentStart

	return {
		finalStep: previousStep,
		wallSeconds,
		secondsPer100Steps: previousStep > 0 ? (wallSeconds / previousStep) * 100 : Number.NaN,
		restarts,
	}
}
