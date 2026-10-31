/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The wall clock a training run needs on a given device, from step rates observed on Modal.
 *
 *   The preflight refuses a config whose estimate exceeds the sandbox timeout, so a run that cannot finish inside one
 *   sandbox fails before a GPU is billed. A device or batch size with no observed rate is refused as well, because the
 *   estimate would be a guess.
 *
 *   The estimate has three parts: the training steps at the device's observed seconds per 100 optimizer steps at the
 *   config's batch size, times {@linkcode STEP_HEADROOM}; the validation passes, `max_steps / eval_every_steps + 1` of
 *   them at {@linkcode EVALUATION_SECONDS} each, and {@linkcode STARTUP_SHUTDOWN_SECONDS} outside the step loop.
 */

/**
 * A training sandbox's wall-clock budget, 32,400 s (9 h).
 */
export const TRAIN_TIMEOUT_SECONDS = 32_400

/**
 * Seconds per 100 optimizer steps between validation passes, by device and then by batch size.
 *
 * `A100-40GB` is the median of the two 90,000-step `v8.3.0-base-c6-90k-fp32master`
 * runs (7.2 and 7.0 s over 932 and 837 windows).
 * The Rust trainer's 2,000-step probe on that card measured 6.5 s at batch 128 in bf16,
 * startup included (#2879 T37, `/mnt/mw/audits/trainer-parity/stage8/T37-FINDINGS.md`),
 * so 7.2 stays the slower bound.
 *
 * `A100-80GB` reuses it as an upper bound that no run has measured.
 *
 * `L4` and `A10` are the Rust trainer's 2,000-step probe on each card, at batch 128 in bf16 with startup
 * included (6.96 and 9.95 steps/s, `/mnt/mw/audits/trainer-parity/gpu-choice/probe-results.log`).
 *
 * `cpu` is the lab CPU at 4 threads on the 200-step trainer-parity config at batch 8,
 * the only job that device runs.
 */
export const OBSERVED_SECONDS_PER_100_STEPS: Readonly<Record<string, Readonly<Record<number, number>>>> = {
	"A100-40GB": { 128: 7.2 },
	"A100-80GB": { 128: 7.2 },
	L4: { 128: 14.4 },
	A10: { 128: 10.1 },
	cpu: { 8: 43.3 },
}

/**
 * Modal's spelling of the 40 GB card.
 */
const DEVICE_ALIASES: Readonly<Record<string, string>> = { A100: "A100-40GB" }

/**
 * Headroom over the step time for slow batches and checkpoint writes.
 */
export const STEP_HEADROOM = 1.15

/**
 * Seconds per validation pass, the mean over every pass of the two fp32-master runs (13.4 and 14.1 s).
 */
export const EVALUATION_SECONDS = 15

/**
 * The allowance for the image start, the receipt check and the final save.
 */
export const STARTUP_SHUTDOWN_SECONDS = 1800

/**
 * A run's estimated wall clock on one device, by part.
 */
export interface WallClockEstimate {
	device: string
	batchSize: number
	secondsPer100Steps: number
	trainSeconds: number
	evaluations: number
	evaluationSeconds: number
	totalSeconds: number
}

export interface WallClockRun {
	maxSteps: number
	evalEverySteps: number
	batchSize: number
}

/**
 * The wall clock `run` needs on `device`.
 *
 * @throws For a device, or a batch size on it, with no observed rate, naming the ones that have one.
 */
export function estimateWallClock(device: string, run: WallClockRun): WallClockEstimate {
	const card = DEVICE_ALIASES[device] ?? device
	const rates = OBSERVED_SECONDS_PER_100_STEPS[card]

	if (!rates) {
		throw new Error(
			`no step rate has been observed on ${device} (observed: ${Object.keys(OBSERVED_SECONDS_PER_100_STEPS).join(", ")}); ` +
				"measure one with a 2,000-step probe and add it to OBSERVED_SECONDS_PER_100_STEPS"
		)
	}

	const rate = rates[run.batchSize]

	if (typeof rate !== "number") {
		throw new TypeError(
			`no step rate has been observed on ${card} at batch_size=${run.batchSize} (observed batches: ` +
				`${Object.keys(rates).join(", ")}); measure one with a 2,000-step probe at that batch`
		)
	}

	if (run.maxSteps <= 0 || run.evalEverySteps <= 0) {
		throw new Error(`max_steps=${run.maxSteps} and eval_every_steps=${run.evalEverySteps} must be positive`)
	}

	const trainSeconds = Math.trunc(((run.maxSteps * rate) / 100) * STEP_HEADROOM)
	const evaluations = Math.trunc(run.maxSteps / run.evalEverySteps) + 1
	const evaluationSeconds = evaluations * EVALUATION_SECONDS

	return {
		device: card,
		batchSize: run.batchSize,
		secondsPer100Steps: rate,
		trainSeconds,
		evaluations,
		evaluationSeconds,
		totalSeconds: trainSeconds + evaluationSeconds + STARTUP_SHUTDOWN_SECONDS,
	}
}

/**
 * The estimate for `run` on `device`.
 *
 * @throws When the estimate exceeds `timeoutSeconds`, stating each part.
 */
export function checkWallClock(device: string, run: WallClockRun, timeoutSeconds: number): WallClockEstimate {
	const estimate = estimateWallClock(device, run)

	if (estimate.totalSeconds > timeoutSeconds) {
		throw new Error(
			`max_steps=${run.maxSteps} on ${estimate.device} needs ~${estimate.totalSeconds}s wall clock: ` +
				`${estimate.trainSeconds}s of steps (${estimate.secondsPer100Steps} s per 100 steps observed, ` +
				`x${STEP_HEADROOM} headroom), ${estimate.evaluations} validation passes at ${EVALUATION_SECONDS}s, ` +
				`+${STARTUP_SHUTDOWN_SECONDS}s startup and shutdown. The sandbox timeout is ${timeoutSeconds}s.`
		)
	}

	return estimate
}
