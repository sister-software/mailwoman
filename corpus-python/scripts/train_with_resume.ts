/**
 * Train Stage 1 with auto-resume on GPU hang. gfx1103 (Radeon 780M) firmware has observed HW Exception ("GPU Hang")
 * under sustained load roughly every 1-2h. This wrapper restarts the training process when it exits non-zero, resuming
 * from the latest step-* checkpoint.
 *
 * Run from the `corpus-python/` directory so the relative `$CONFIG` path resolves against cwd:
 *
 * HSA_OVERRIDE_GFX_VERSION=11.0.0 node scripts/train_with_resume.ts [extra args passed to python -m mailwoman_train
 * train]
 *
 * Stops when:
 *
 * - Python exits 0 (training reached max_steps)
 * - Signal trap caught (SIGINT/SIGTERM)
 * - Max-attempts reached (default 50, override via $MAX_ATTEMPTS)
 */

import { openSync } from "node:fs"

import { $public } from "@mailwoman/core/env"
import { cliArguments } from "@mailwoman/core/scripting/utils"
import { $, sleep } from "zx"

const MAX_ATTEMPTS = Number($public.MAX_ATTEMPTS ?? 50)
const LOG = $public.LOG ?? "/tmp/stage1-train.log"
const CONFIG = $public.CONFIG ?? "src/mailwoman_train/configs/stage1-coarse.yaml"
// DELIBERATE cliArguments: EXTRA_ARGS is a verbatim passthrough to `python -m mailwoman_train train`
// — parseArgs cannot collect undeclared flags, and reconstructing them from tokens would be lossy.
const EXTRA_ARGS = cliArguments()

// Open the log once in append mode; every attempt appends to the same file (bash did `>>"$LOG" 2>&1` per invocation).
const logFd = openSync(LOG, "a")

// zx prints the command to stderr by default; the bash wrapper kept python output in $LOG only, so stay quiet.
$.verbose = false

// Match the bash trap: on SIGINT/SIGTERM, log a line and exit 130.
function onSignal(): void {
	console.log("[wrapper] received signal, exiting")
	process.exit(130)
}

process.on("SIGINT", onSignal)
process.on("SIGTERM", onSignal)

/**
 * Spawn the python trainer, routing its stdout+stderr to $LOG (matching bash `>>"$LOG" 2>&1`) and returning the exit
 * code without throwing on non-zero.
 *
 * @param resume - Whether to pass `--resume auto` (the resume loop) or start fresh.
 */
async function runTraining(resume: boolean): Promise<number> {
	const shell = $({ stdio: ["ignore", logFd, logFd], nothrow: true })

	const output = resume
		? await shell`python -u -m mailwoman_train train --config ${CONFIG} --resume auto ${EXTRA_ARGS}`
		: await shell`python -u -m mailwoman_train train --config ${CONFIG} ${EXTRA_ARGS}`

	return output.exitCode ?? 1
}

let attempt = 0

// First attempt — fresh start unless --resume is already in the passed args.
if (!EXTRA_ARGS.includes("--resume")) {
	console.log("[wrapper] attempt 1: fresh start")
	const exit = await runTraining(false)
	attempt = 1

	if (exit === 0) {
		console.log("[wrapper] training completed successfully on attempt 1")
		process.exit(0)
	}

	console.log(`[wrapper] attempt 1 exited with ${exit} — resuming`)
}

while (attempt < MAX_ATTEMPTS) {
	attempt += 1
	console.log(`[wrapper] attempt ${attempt}: resume=auto`)
	const exit = await runTraining(true)

	if (exit === 0) {
		console.log(`[wrapper] training completed successfully on attempt ${attempt}`)
		process.exit(0)
	}

	console.log(`[wrapper] attempt ${attempt} exited with ${exit}; sleeping 15s then resuming`)
	await sleep("15s")
}

console.log(`[wrapper] MAX_ATTEMPTS=${MAX_ATTEMPTS} reached, giving up`)
process.exit(1)
