/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Runs the sandbox supervisor under bash against a fake `trainer` and a fake `sync`, which record their calls.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { changeMode, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { isPresent } from "@mailwoman/core/objects"
import { isProcessError, runFile } from "@mailwoman/core/process"
import { describe, expect, it } from "vitest"

import {
	SUPERVISOR_REFUSED_EXIT,
	SUPERVISOR_SCRIPT,
	type SupervisorEnvironment,
} from "#tools/training/launch/supervisor"

/**
 * A `trainer` whose `train` follows `FAKE_PLAN`, one word per attempt: `ok`,
 * `crash` (exit 1 after one complete save), `die` (exit 1 before its first save),
 * `cuda` (reports the CUDA device) or `fail` (exit 2 before training).
 */
const FAKE_TRAINER = String.raw`#!/usr/bin/env bash
[ "$1" = device ] && exit 0
count=$(cat "$FAKE_STATE/attempts" 2> /dev/null || echo 0)
echo $((count + 1)) > "$FAKE_STATE/attempts"
echo "train $4" >> "$FAKE_STATE/calls"
read -ra plan <<< "$FAKE_PLAN"
mode=${"$"}{plan[$count]:-ok}
[ "$mode" = cuda ] && { echo "device=Cuda(0) param_count=10"; sleep 5; exit 0; }
[ "$mode" = fail ] && { echo "error: no corpus"; exit 2; }
echo "device=Cpu param_count=10"
[ "$mode" = die ] && exit 1
[ "$mode" = slow ] && sleep 1
for step in 10 20 30; do
	echo "step $step/30  train_loss=1.0"
	mkdir -p "$MW_OUTPUT_DIR/step-0000$step"
	echo '{"step": '"$step"'}' > "$MW_OUTPUT_DIR/step-0000$step/training_state.json"
	echo "[save] checkpoint step-0000$step"
	[ "$mode" = crash ] && exit 1
done
exit 0
`

const FAKE_SYNC = String.raw`#!/usr/bin/env bash
echo "sync $1" >> "$FAKE_STATE/syncs"
`

async function runSupervisor(
	plan: string,
	overrides: Partial<SupervisorEnvironment> = {},
	seedCheckpoint = false,
	writeInputs = true
) {
	await using scratch = await temporaryDirectory("mailwoman-supervisor-")
	const config = "data:\n  corpus_dir: /data/corpus\n"
	const configSHA = sha256Hex(config)
	const manifest = '{"files":[]}'
	const trainer = scratch.path("trainer").toString()
	const sync = scratch.path("sync").toString()

	// The inputs the host writes into the sandbox, `ready` last.
	if (writeInputs) {
		await writeLocalTextFile(config, scratch.path("inputs", "config"))
		await writeLocalTextFile(`{"config_sha256": "${configSHA}"}`, scratch.path("inputs", "resolved.json"))
		await writeLocalTextFile("", scratch.path("inputs", "ready"))
	}

	await writeLocalTextFile(FAKE_TRAINER, trainer)
	await writeLocalTextFile(FAKE_SYNC, sync)
	await writeLocalTextFile(manifest, scratch.path("volume", "corpus", "MANIFEST.json"))
	await changeMode(trainer, 0o755)
	await changeMode(sync, 0o755)

	// An earlier run left this checkpoint.
	// Only a fresh start removes it.
	const earlier = scratch.path("volume", "output", "checkpoints", "step-000100", "model.safetensors")

	if (seedCheckpoint) {
		await writeLocalTextFile("weights", earlier)

		await writeLocalTextFile(
			'{"step": 100}',
			scratch.path("volume", "output", "checkpoints", "step-000100", "training_state.json")
		)
	}

	const environment: SupervisorEnvironment = {
		MW_LAUNCH_ID: "launch-1",
		MW_VOLUME: scratch.path("volume").toString(),
		MW_CONFIG_PATH: scratch.path("volume", "launch", "config.yaml").toString(),
		MW_RESOLVED_PATH: scratch.path("volume", "launch", "resolved.json").toString(),
		MW_INPUTS_DIR: scratch.path("inputs").toString(),
		MW_INPUTS_WAIT_SECONDS: "2",
		MW_CONFIG_SHA256: configSHA,
		MW_MANIFEST_PATH: scratch.path("volume", "corpus", "MANIFEST.json").toString(),
		MW_MANIFEST_SHA256: sha256Hex(manifest),
		MW_RUN_BASE: scratch.path("volume", "output").toString(),
		MW_EXPECT_DEVICE: "cpu",
		MW_BRANCH_FROM: "",
		MW_THREADS: "0",
		MW_RETRIES: "2",
		MW_RETRY_DELAY_SECONDS: "0",
		MW_FRESH: "0",
		MW_OUTPUT_DIR: scratch.path("volume", "output", "checkpoints").toString(),
		MW_FAIL_AT_STEP: "0",
		MW_TRAINER: trainer,
		MW_SYNC: sync,
		...overrides,
	}

	const { code, stdout } = await runFile("bash", ["-c", SUPERVISOR_SCRIPT], {
		env: { ...environment, FAKE_STATE: scratch.path().toString(), FAKE_PLAN: plan, PATH: "/usr/bin:/bin" },
	}).then(
		(output) => ({ code: 0, stdout: output.stdout }),
		(error: unknown) => {
			if (!isProcessError(error)) throw error

			return { code: Number(error.code), stdout: error.stdout }
		}
	)

	const read = async (name: string) =>
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- a fake's log of at most a few lines
		(await readLocalTextFile(scratch.path(name)).catch(() => "")).trim().split("\n").filter(isPresent)

	return {
		code,
		stdout,
		calls: await read("calls"),
		syncs: await read("syncs"),
		checkpointKept: await pathExists(earlier),
	}
}

describe("the training sandbox supervisor", () => {
	it("trains, committing the volume after the inputs and after every checkpoint", async () => {
		const run = await runSupervisor("ok")

		expect(run.code).toBe(0)
		expect(run.calls).toEqual(["train auto"])
		// One commit for the staged inputs, three for the checkpoints, one after the trainer exits.
		expect(run.syncs).toHaveLength(5)
		expect(run.stdout).toContain("[launch] training complete")
	})

	it("logs the GPU's use and the trainer's peak resident memory while the trainer runs", async () => {
		const run = await runSupervisor("slow", { MW_USAGE_INTERVAL_SECONDS: "0.2" })
		const samples = run.stdout.split("\n").filter((line) => line.startsWith("[launch] usage: "))

		expect(run.code).toBe(0)
		// The host running the test may have no GPU, so the GPU field is whatever nvidia-smi reports or `none`.
		expect(samples.some((line) => /trainer_peak_rss_kib=\d+$/u.test(line))).toBe(true)
	})

	it("retries a failed exit with --resume auto after committing its checkpoint", async () => {
		const run = await runSupervisor("crash ok", { MW_BRANCH_FROM: "/data/branch/step-000100" })

		expect(run.code).toBe(0)
		expect(run.calls).toEqual(["train /data/branch/step-000100", "train auto"])
		expect(run.stdout).toContain("trainer train exited 1; retrying")
	})

	it("keeps the branch point for a retry when the failed attempt saved no checkpoint", async () => {
		const run = await runSupervisor("die ok", { MW_BRANCH_FROM: "/data/branch/step-000100" })

		expect(run.code).toBe(0)
		expect(run.calls).toEqual(["train /data/branch/step-000100", "train /data/branch/step-000100"])
	})

	it("resumes a branched run's own checkpoint when its output directory already holds one", async () => {
		const run = await runSupervisor("crash ok", { MW_BRANCH_FROM: "/data/branch/step-000100" }, true)

		expect(run.calls).toEqual(["train auto", "train auto"])
	})

	it("kills the trainer once after the fault step, then resumes", async () => {
		const run = await runSupervisor("ok ok", { MW_FAIL_AT_STEP: "20" })

		expect(run.code).toBe(0)
		expect(run.calls).toEqual(["train auto", "train auto"])
		expect(run.stdout).toContain("controlled failure: killed the trainer after step 20")
	})

	it("stops with the trainer's code once the retries are spent", async () => {
		const run = await runSupervisor("fail fail fail")

		expect(run.code).toBe(2)
		expect(run.calls).toHaveLength(3)
		expect(run.stdout).toContain("trainer train exited 2 after 2 retries")
	})

	it("refuses without a retry when the trainer chooses another device", async () => {
		const run = await runSupervisor("cuda ok")

		expect(run.code).toBe(SUPERVISOR_REFUSED_EXIT)
		expect(run.calls).toEqual(["train auto"])
		expect(run.stdout).toContain("refused: trainer chose device cuda, this sandbox runs on cpu")
	})

	it("clears the output directory once under a fresh start, and only then", async () => {
		const fresh = await runSupervisor("ok", { MW_FRESH: "1" }, true)
		const kept = await runSupervisor("ok", {}, true)

		expect(fresh.stdout).toContain("[launch] fresh start: cleared")
		expect(fresh.checkpointKept).toBe(false)
		expect(kept.stdout).not.toContain("fresh start")
		expect(kept.checkpointKept).toBe(true)
	})

	it("refuses inputs that describe another config or corpus before training", async () => {
		const config = await runSupervisor("ok", { MW_CONFIG_SHA256: "0".repeat(64) })
		const manifest = await runSupervisor("ok", { MW_MANIFEST_SHA256: "0".repeat(64) })

		expect(config.code).toBe(SUPERVISOR_REFUSED_EXIT)
		expect(config.calls).toEqual([])
		expect(manifest.code).toBe(SUPERVISOR_REFUSED_EXIT)
		expect(manifest.stdout).toContain("stage the corpus the receipt was written over")
	})

	it("refuses when the launch inputs never arrive", async () => {
		const result = await runSupervisor("ok", {}, false, false)

		expect(result.code).toBe(SUPERVISOR_REFUSED_EXIT)
		expect(result.stdout).toContain("the launch inputs did not arrive")
		expect(result.calls).toEqual([])
	})
})
