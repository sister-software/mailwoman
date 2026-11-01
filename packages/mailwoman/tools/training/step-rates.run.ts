/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Prints one row per `train_log.csv`: final step, wall hours with restarts excluded, seconds per 100 steps and
 *   restart count. Copy a run's logs to the host with `launch.run.ts fetch` first. The seconds-per-100-steps column
 *   is the value `OBSERVED_SECONDS_PER_100_STEPS` records for the run's device and batch size.
 *
 *   Usage: node packages/mailwoman/tools/training/step-rates.run.ts <train_log.csv>...
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { measureTrainLog } from "./step-rates.ts"

const { positionals } = parseArguments({ options: {}, allowPositionals: true })

if (!positionals.length) throw new Error("pass one or more train_log.csv paths")

console.log("log\tfinal_step\twall_h\ts_per_100\trestarts")

for (const path of positionals) {
	const rate = measureTrainLog(await readLocalTextFile(path))

	console.log(
		[
			path,
			rate.finalStep,
			(rate.wallSeconds / 3600).toFixed(2),
			rate.secondsPer100Steps.toFixed(1),
			rate.restarts,
		].join("\t")
	)
}
