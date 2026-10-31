/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The launch lifecycle against a stub Modal boundary: preflight, detached start, duplicate refusal, status, restart
 *   after a stop, cancellation and the timeout.
 */

import { sleep } from "@mailwoman/core/utils/sleep"
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
	NAME_RELEASE_RETRY,
	type ResolvedLaunchConfig,
	restartLaunch,
	RUN_TAG,
	runKeyOf,
	SandboxNameHeldError,
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
	const preflightTimeouts: number[] = []
	const sleeps: number[] = []
	const locked = new Set<string>()
	// How many more starts Modal refuses for a name an exited sandbox has not yet released.
	const releasing = { refusals: 0 }

	const boundary: ModalBoundary = {
		ensureTrainerImage: async (build) => `im-${build.name}`,
		start: async (spec) => {
			// Modal refuses a name a running sandbox of the app holds.
			if ([...sandboxes.values()].some((sandbox) => sandbox.exitCode === null && sandbox.spec.name === spec.name)) {
				throw new SandboxNameTakenError(spec.name)
			}

			if (releasing.refusals > 0) {
				releasing.refusals--

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
		preflight: async (_config, _device, timeoutSeconds) => {
			preflights++
			preflightTimeouts.push(timeoutSeconds)

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
		lockRun: async (key) => {
			if (locked.has(key)) throw new Error(`another start or restart of run ${key} holds its lock`)

			locked.add(key)

			return { [Symbol.asyncDispose]: async () => void locked.delete(key) }
		},
		sleep: async (milliseconds) => void sleeps.push(milliseconds),
		log: (line) => logs.push(line),
	}

	return {
		deps,
		sandboxes,
		records,
		terminated,
		logs,
		fetches,
		preflights: () => preflights,
		preflightTimeouts,
		sleeps,
		releasing,
	}
}

describe("the training launch lifecycle", () => {
	const runKey = runKeyOf(CONFIG.outputDir)

	it("preflights, then starts one detached sandbox and records it", async () => {
		const { deps, sandboxes, records, preflightTimeouts } = harness()
		const record = await startLaunch(CONFIG, OPTIONS, deps)
		const sandbox = sandboxes.get(record.sandboxes[0]!)!

		expect(record.imageID).toBe("im-mailwoman-trainer-cpu")
		expect(sandbox.spec).toMatchObject({ cpu: 4, timeoutMs: 3_600_000, tags: { [RUN_TAG]: runKey } })
		// The wall clock is checked against the timeout the sandbox runs under.
		expect(preflightTimeouts).toEqual([3600])
		expect(sandbox.spec.gpu).toBeUndefined()
		expect(sandbox.spec.env).toMatchObject({ MW_FRESH: "1", MW_EXPECT_DEVICE: "cpu", MW_MANIFEST_SHA256: "m" })
		// The inputs travel as files, with `ready` written last.
		// The sandbox receives the config as a file.
		expect(sandbox.spec.files.map((file) => file.path.split("/").at(-1))).toEqual(["config", "resolved.json", "ready"])
		expect(Object.values(sandbox.spec.env).every((value) => value.length < 4096)).toBe(true)
		expect(records.get(runKey)?.sandboxes).toEqual([record.sandboxes[0]])
		await expect(launchStatus(runKey, deps)).resolves.toMatchObject({ state: LaunchState.Running })
	})

	it("starts a GPU sandbox on the CUDA image with the requested card", async () => {
		const { deps, sandboxes } = harness()
		const record = await startLaunch(CONFIG, { ...OPTIONS, device: "A100-80GB" }, deps)

		expect(record.imageID).toBe("im-mailwoman-trainer-cu130")

		expect(sandboxes.get(record.sandboxes[0]!)!.spec).toMatchObject({
			gpu: "A100-80GB",
			cpu: 4,
			cpuLimit: 6,
			memoryMiB: 16_384,
			memoryLimitMiB: 32_768,
			env: { MW_THREADS: "4" },
		})

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
		// The race: the second launch's host check ran before the first sandbox was listed.
		let checks = 0

		const list: ModalBoundary["list"] = async (tags, includeFinished) =>
			checks++ === 0 ? [] : deps.boundary.list(tags, includeFinished)

		const racing = { ...deps, boundary: { ...deps.boundary, list } }

		await expect(startLaunch(CONFIG, OPTIONS, racing)).rejects.toThrow(
			new DuplicateLaunchError(record.runKey, record.sandboxes[0]!)
		)
	})

	it("refuses a second start of the run while the first holds the host lock, before its preflight", async () => {
		const { deps, preflights } = harness()

		await using _held = await deps.lockRun(runKeyOf(CONFIG.outputDir))

		await expect(startLaunch(CONFIG, OPTIONS, deps)).rejects.toThrow(/holds its lock/)
		expect(preflights()).toBe(0)
	})

	it("holds the host lock until the sandbox has started", async () => {
		const { deps } = harness()
		let lockedAtStart = false

		const start: ModalBoundary["start"] = async (spec) => {
			// A Modal call yields to the event loop before the sandbox exists.
			await sleep(0)

			// A second lock attempt fails while the first start still holds it.
			lockedAtStart = await deps.lockRun(runKey).then(
				async (lock) => {
					await lock[Symbol.asyncDispose]()

					return false
				},
				() => true
			)

			return deps.boundary.start(spec)
		}

		await startLaunch(CONFIG, OPTIONS, { ...deps, boundary: { ...deps.boundary, start } })
		expect(lockedAtStart).toBe(true)
	})

	it("starts again when Modal still reserves the name of the run's exited sandbox", async () => {
		const { deps, sleeps, releasing, logs } = harness()

		releasing.refusals = 2

		const record = await startLaunch(CONFIG, OPTIONS, deps)

		expect(record.sandboxes).toHaveLength(1)
		expect(sleeps).toEqual([NAME_RELEASE_RETRY.delayMs, NAME_RELEASE_RETRY.delayMs])
		expect(logs.filter((line) => line.includes("still reserves"))).toHaveLength(2)
	})

	it("reports a held name, not a duplicate launch, when Modal keeps it after every retry", async () => {
		const { deps, sleeps, releasing } = harness()

		releasing.refusals = Number.POSITIVE_INFINITY

		await expect(startLaunch(CONFIG, OPTIONS, deps)).rejects.toBeInstanceOf(SandboxNameHeldError)
		expect(sleeps).toHaveLength(NAME_RELEASE_RETRY.attempts - 1)
	})

	it("restarts a stopped run in a fresh sandbox without clearing it, and refuses to restart a refusal", async () => {
		const { deps, sandboxes } = harness()
		const first = await startLaunch(CONFIG, { ...OPTIONS, failAtStep: 150 }, deps)

		sandboxes.get(first.sandboxes[0]!)!.exitCode = 1
		await expect(launchStatus(runKey, deps)).resolves.toMatchObject({ state: LaunchState.Stopped })

		const second = await restartLaunch(runKey, deps)
		const spec = sandboxes.get(second.sandboxes[1]!)!.spec

		expect(spec.env).toMatchObject({ MW_FRESH: "0", MW_FAIL_AT_STEP: "0" })
		// A restart is a new launch, so an earlier launch's fault-injection marker does not apply to it.
		expect(spec.env?.["MW_LAUNCH_ID"]).not.toBe(first.environment.MW_LAUNCH_ID)
		await expect(restartLaunch(runKey, deps)).rejects.toThrow(/is running/)

		sandboxes.get(second.sandboxes[1]!)!.exitCode = SUPERVISOR_REFUSED_EXIT
		await expect(restartLaunch(runKey, deps)).rejects.toThrow(/is refused/)
	})

	it("cancels a running run by terminating its sandbox", async () => {
		const { deps, terminated } = harness()
		const record = await startLaunch(CONFIG, OPTIONS, deps)

		await cancelLaunch(runKey, deps)
		expect(terminated).toEqual([record.sandboxes[0]])
		await expect(launchStatus(runKey, deps)).resolves.toMatchObject({ state: LaunchState.Stopped })
	})

	it("fetches a run's output directory, or one checkpoint of it, from the volume", async () => {
		const { deps, fetches } = harness()
		const record = await startLaunch(CONFIG, OPTIONS, deps)

		await expect(fetchRun(runKey, "step-000200", "/tmp/out", deps)).resolves.toEqual(["model.safetensors"])
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
