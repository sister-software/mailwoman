/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The launch lifecycle against a stub Modal boundary: preflight, detached start, duplicate refusal, status, restart
 *   after a stop, cancellation and the timeout.
 */

import { describe, expect, it } from "vitest"

import {
	type ModalBoundary,
	SandboxNameTakenError,
	type SandboxState,
	type TrainingSandboxSpec,
} from "#tools/training/launch/boundary"
import {
	cancelLaunch,
	DuplicateLaunchError,
	fetchRun,
	launchStatus,
	LaunchState,
	type LaunchDependencies,
	type LaunchOptions,
	type LaunchRecord,
	type ResolvedLaunchConfig,
	restartLaunch,
	RUN_TAG,
	runKeyOf,
	startLaunch,
} from "#tools/training/launch/launch"
import { SUPERVISOR_REFUSED_EXIT } from "#tools/training/launch/supervisor"

const CONFIG: ResolvedLaunchConfig = {
	name: "probe.yaml",
	text: new TextEncoder().encode("train: {}\n"),
	resolvedJSON: '{"config_sha256": "abc"}',
	configSHA256: "a".repeat(64),
	outputDir: "/data/output-probe/checkpoints",
	csvLogPath: "{output_dir}/../train_log.csv",
	maxSteps: 200,
	evalEverySteps: 100,
	batchSize: 8,
}

const OPTIONS: LaunchOptions = {
	device: "cpu",
	mount: "/data",
	fresh: true,
	threads: 4,
	retries: 2,
	timeoutSeconds: 3600,
	failAtStep: 0,
	dryRun: false,
}

function harness() {
	const sandboxes = new Map<string, SandboxState & { spec: TrainingSandboxSpec }>()
	const records = new Map<string, LaunchRecord>()
	const terminated: string[] = []
	const logs: string[] = []
	const fetches: Array<{ remoteDir: string; localDir: string }> = []
	let preflights = 0

	const boundary: ModalBoundary = {
		ensureTrainerImage: async (build) => `im-${build.name}`,
		start: async (spec) => {
			// Modal refuses a name a running sandbox of the app holds.
			if ([...sandboxes.values()].some((sandbox) => sandbox.exitCode === null && sandbox.spec.name === spec.name)) {
				throw new SandboxNameTakenError(spec.name)
			}

			const id = `sb-${sandboxes.size}`

			sandboxes.set(id, { id, tags: spec.tags, exitCode: null, spec })

			return { id, tags: spec.tags, exitCode: null }
		},
		list: async (tags, includeFinished = false) =>
			[...sandboxes.values()].filter(
				(sandbox) =>
					(includeFinished || sandbox.exitCode === null) &&
					Object.entries(tags).every(([key, value]) => sandbox.tags[key] === value)
			),
		get: async (id) => sandboxes.get(id)!,
		logs: async () => "",
		terminate: async (id) => {
			terminated.push(id)
			sandboxes.get(id)!.exitCode = 137
		},
		runToCompletion: async () => ({ exitCode: 0, output: "" }),
		fetchDirectory: async (remoteDir, localDir) => {
			fetches.push({ remoteDir, localDir })

			return ["model.safetensors"]
		},
	}

	const deps: LaunchDependencies = {
		boundary,
		preflight: async () => {
			preflights++

			return {
				token: "key-1",
				audits: ["corpus_files", "wall_clock"],
				manifestPath: "/data/c/MANIFEST.json",
				manifestSHA256: "m",
			}
		},
		imageBuild: async (variant) => ({
			name: `mailwoman-trainer-${variant}`,
			baseImage: "debian",
			baseCommands: [],
			buildScript: "",
			bundle: new Uint8Array(),
		}),
		readRecord: async (key) => records.get(key) ?? null,
		writeRecord: async (record) => {
			records.set(record.runKey, record)
		},
		log: (line) => logs.push(line),
	}

	return { deps, sandboxes, records, terminated, logs, fetches, preflights: () => preflights }
}

describe("the training launch lifecycle", () => {
	const runKey = runKeyOf(CONFIG.outputDir)

	it("preflights, then starts one detached sandbox and records it", async () => {
		const { deps, sandboxes, records } = harness()
		const record = await startLaunch(CONFIG, OPTIONS, deps)
		const sandbox = sandboxes.get(record.sandboxes[0]!)!

		expect(record.imageID).toBe("im-mailwoman-trainer-cpu")
		expect(sandbox.spec).toMatchObject({ cpu: 4, timeoutMs: 3_600_000, tags: { [RUN_TAG]: runKey } })
		expect(sandbox.spec.gpu).toBeUndefined()
		expect(sandbox.spec.env).toMatchObject({ MW_FRESH: "1", MW_EXPECT_DEVICE: "cpu", MW_MANIFEST_SHA256: "m" })
		// The inputs travel as files, `ready` last, so no environment value carries a config.
		expect(sandbox.spec.files.map((file) => file.path.split("/").at(-1))).toEqual(["config", "resolved.json", "ready"])
		expect(Object.values(sandbox.spec.env).every((value) => value.length < 4096)).toBe(true)
		expect(records.get(runKey)?.sandboxes).toEqual([record.sandboxes[0]])
		expect(await launchStatus(runKey, deps)).toMatchObject({ state: LaunchState.Running })
	})

	it("starts a GPU sandbox on the CUDA image with the requested card", async () => {
		const { deps, sandboxes } = harness()
		const record = await startLaunch(CONFIG, { ...OPTIONS, device: "A100-80GB" }, deps)

		expect(record.imageID).toBe("im-mailwoman-trainer-cu130")
		expect(sandboxes.get(record.sandboxes[0]!)!.spec).toMatchObject({ gpu: "A100-80GB", cpu: 8 })
		expect(record.environment.MW_EXPECT_DEVICE).toBe("cuda")
	})

	it("refuses a second launch onto a running run before its preflight", async () => {
		const { deps, preflights } = harness()

		await startLaunch(CONFIG, OPTIONS, deps)
		await expect(startLaunch(CONFIG, OPTIONS, deps)).rejects.toBeInstanceOf(DuplicateLaunchError)
		expect(preflights()).toBe(1)
	})

	it("refuses a second launch that passes the host check while the first sandbox runs, by the sandbox name", async () => {
		const { deps } = harness()
		const record = await startLaunch(CONFIG, OPTIONS, deps)
		// The race: the second launch's check ran before the first sandbox was listed.
		const racing = { ...deps, boundary: { ...deps.boundary, list: async () => [] } }

		await expect(startLaunch(CONFIG, OPTIONS, racing)).rejects.toThrow(
			new DuplicateLaunchError(record.runKey, `named train-${record.runKey}`)
		)
	})

	it("restarts a stopped run in a fresh sandbox without clearing it, and refuses to restart a refusal", async () => {
		const { deps, sandboxes } = harness()
		const first = await startLaunch(CONFIG, { ...OPTIONS, failAtStep: 150 }, deps)

		sandboxes.get(first.sandboxes[0]!)!.exitCode = 1
		expect(await launchStatus(runKey, deps)).toMatchObject({ state: LaunchState.Stopped })

		const second = await restartLaunch(runKey, deps)
		const spec = sandboxes.get(second.sandboxes[1]!)!.spec

		expect(spec.env).toMatchObject({ MW_FRESH: "0", MW_RESUME: "auto", MW_FAIL_AT_STEP: "0" })
		await expect(restartLaunch(runKey, deps)).rejects.toThrow(/is running/)

		sandboxes.get(second.sandboxes[1]!)!.exitCode = SUPERVISOR_REFUSED_EXIT
		await expect(restartLaunch(runKey, deps)).rejects.toThrow(/is refused/)
	})

	it("cancels a running run by terminating its sandbox", async () => {
		const { deps, terminated } = harness()
		const record = await startLaunch(CONFIG, OPTIONS, deps)

		await cancelLaunch(runKey, deps)
		expect(terminated).toEqual([record.sandboxes[0]])
		expect(await launchStatus(runKey, deps)).toMatchObject({ state: LaunchState.Stopped })
	})

	it("fetches a run's output directory, or one checkpoint of it, from the volume", async () => {
		const { deps, fetches } = harness()
		const record = await startLaunch(CONFIG, OPTIONS, deps)

		expect(await fetchRun(runKey, "step-000200", "/tmp/out", deps)).toEqual(["model.safetensors"])
		await fetchRun(runKey, null, "/tmp/out", deps)

		expect(fetches.map((fetch) => fetch.remoteDir)).toEqual([
			`${record.environment.MW_OUTPUT_DIR}/step-000200`,
			record.environment.MW_OUTPUT_DIR,
		])

		await expect(fetchRun("0".repeat(16), null, "/tmp/out", deps)).rejects.toThrow(/no launch record/)
	})

	it("runs the preflight on a dry run and starts nothing", async () => {
		const { deps, sandboxes, logs, preflights } = harness()

		await startLaunch(CONFIG, { ...OPTIONS, dryRun: true }, deps)
		expect(preflights()).toBe(1)
		expect(sandboxes.size).toBe(0)
		expect(logs.at(-1)).toMatch(/^Dry run: would start mailwoman-trainer-cpu on cpu/)
	})

	it("refuses a fault step on a GPU and a fresh start over a shared directory", async () => {
		const { deps } = harness()

		await expect(startLaunch(CONFIG, { ...OPTIONS, device: "A100", failAtStep: 5 }, deps)).rejects.toThrow(
			/CPU device only/
		)

		await expect(startLaunch({ ...CONFIG, outputDir: "/data/corpus/versioned/x" }, OPTIONS, deps)).rejects.toThrow(
			/shared assets/
		)
	})
})
