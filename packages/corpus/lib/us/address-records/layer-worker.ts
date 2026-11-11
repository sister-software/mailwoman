/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The worker process a parallel US address-layer build forks for one state. It reads the task file the parent
 *   wrote, builds that state with no manifest, and writes the run counts to the result file. The state's own
 *   `build.json` records its record and refusal counts.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { cliArguments } from "@mailwoman/core/scripting/arguments"

import {
	buildUSAddressLayer,
	type BuildUSAddressLayerOptions,
	type USStateWorkerResult,
} from "#us/address-records/layer"

async function runStateWorker(): Promise<void> {
	const [taskPath, resultPath] = cliArguments()

	if (!taskPath || !resultPath) {
		throw new Error("US address-layer worker: expected a task file path and a result file path")
	}

	// The parent's exit closes the channel, and a worker left running would keep writing a state no manifest lists.
	process.on("disconnect", () => process.exit(1))

	const task = await readLocalJSONFile<BuildUSAddressLayerOptions>(taskPath)
	const result = await buildUSAddressLayer({ ...task, jobs: 1, resume: false, writeManifest: false })

	await writeLocalJSONFile(
		{ refusedRuns: result.refusedRuns, missingRuns: result.missingRuns } satisfies USStateWorkerResult,
		resultPath
	)
}

if (import.meta.main) {
	runStateWorker().then(
		() => {
			process.removeAllListeners("disconnect")
			process.disconnect?.()
			process.exit(0)
		},
		(error: unknown) => {
			console.error(error instanceof Error ? (error.stack ?? error.message) : error)

			process.exit(1)
		}
	)
}
