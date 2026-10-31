/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The training launch lifecycle: preflight on the host, one detached sandbox per attempt run, and the status, log,
 *   cancel and restart operations on it.
 *
 *   A launch resolves its config on the host and admits its source rights. It then runs the preflight audits
 *   against the host mirror of the volume. The receipt's key binds the YAML and the corpus MANIFEST, and the sandbox
 *   refuses a volume whose MANIFEST differs from the one the host hashed. The sandbox runs the supervisor
 *   (`supervisor.ts`), which restarts the trainer in the same container after a failed exit. A sandbox that Modal
 *   preempts, or one that times out or spends its retries, is restarted by {@linkcode restartLaunch} in a fresh
 *   sandbox that resumes from the newest complete checkpoint. Every launch writes a {@linkcode LaunchRecord} on the
 *   host, so the operations after it need only the run key.
 */

import { sha256Hex } from "@mailwoman/core/hash"

import {
	type ModalBoundary,
	SandboxNameTakenError,
	type SandboxResources,
	type SandboxState,
	type TrainerImageBuild,
} from "#tools/training/launch/boundary"
import { checkClearable, resolveRunPaths } from "#tools/training/launch/run-paths"
import {
	SUPERVISOR_REFUSED_EXIT,
	SUPERVISOR_SCRIPT,
	type SupervisorEnvironment,
} from "#tools/training/launch/supervisor"

/**
 * The tag attached to every training sandbox.
 * It identifies one run directory.
 */
export const RUN_TAG = "mailwoman-run"

/**
 * A run's state as {@linkcode launchStatus} reads it from its newest sandbox.
 */
export const LaunchState = {
	Running: "running",
	Completed: "completed",
	/**
	 * The supervisor refused inputs or a device.
	 * A restart would repeat the refusal.
	 */
	Refused: "refused",
	/**
	 * The sandbox stopped with another exit code: a spent retry count, a timeout or a preemption.
	 * A restart resumes it.
	 */
	Stopped: "stopped",
} as const

export type LaunchState = (typeof LaunchState)[keyof typeof LaunchState]

/**
 * A second launch onto a run whose sandbox is still running.
 */
export class DuplicateLaunchError extends Error {
	constructor(runKey: string, sandboxID: string) {
		super(`the run ${runKey} is held by sandbox ${sandboxID}, which is still running`)
		this.name = "DuplicateLaunchError"
	}
}

/**
 * A start whose sandbox name Modal still reserves for a sandbox of the run that already exited.
 *
 * Modal releases a terminated sandbox's name some time after its exit code is readable,
 * so a restart right after a cancel or a preemption can find the name held by no running sandbox.
 */
export class SandboxNameHeldError extends Error {
	constructor(runKey: string, sandboxName: string, attempts: number) {
		super(
			`Modal still reserves ${sandboxName} after ${attempts} starts, and no sandbox of run ${runKey} is running; ` +
				"the previous sandbox is still releasing it, so start the run again in a minute"
		)

		this.name = "SandboxNameHeldError"
	}
}

/**
 * How many times a start retries a sandbox name that no running sandbox of the
 * run holds, and how long it waits between them.
 */
export const NAME_RELEASE_RETRY = { attempts: 6, delayMs: 10_000 } as const

/**
 * What the host preflight hands the launch: the receipt key and the MANIFEST it was written over.
 */
export interface PreflightResult {
	token: string
	audits: string[]
	manifestPath: string
	manifestSHA256: string
}

/**
 * The config a launch trains, as the host resolved it.
 */
export interface ResolvedLaunchConfig {
	name: string
	text: Uint8Array
	resolvedJSON: string
	configSHA256: string
	outputDir: string
	csvLogPath: string
	maxSteps: number
	evalEverySteps: number
	batchSize: number
}

/**
 * What a launch needs besides Modal.
 */
export interface LaunchDependencies {
	boundary: ModalBoundary
	/**
	 * Runs the preflight audits for `config` on `device` and writes the receipt.
	 *
	 * The wall-clock estimate is checked against `timeoutSeconds`, the sandbox's own timeout.
	 */
	preflight(config: ResolvedLaunchConfig, device: string, timeoutSeconds: number): Promise<PreflightResult>
	/**
	 * The trainer image build for `variant`, whose name hashes the sources.
	 */
	imageBuild(variant: "cpu" | "cu130"): Promise<TrainerImageBuild>
	readRecord(runKey: string): Promise<LaunchRecord | null>
	writeRecord(record: LaunchRecord): Promise<void>
	/**
	 * Takes the host's lock on a run for one `start`, from before its preflight to after its sandbox starts.
	 *
	 * @throws When another `start` on this host holds it.
	 */
	lockRun(runKey: string): Promise<AsyncDisposable>
	sleep(milliseconds: number): Promise<void>
	log(line: string): void
}

/**
 * The host's record of a run: everything a restart needs, and every sandbox the run has used.
 */
export interface LaunchRecord {
	runKey: string
	config: string
	device: string
	imageID: string
	resources: SandboxResources
	environment: SupervisorEnvironment
	/**
	 * The YAML's bytes in base64 and the resolved config.
	 *
	 * Each sandbox of the run receives in {@linkcode LAUNCH_INPUTS_DIR}.
	 */
	inputs: { configBase64: string; resolved: string }
	sandboxes: string[]
}

/**
 * The container directory a training sandbox receives its launch inputs in.
 */
export const LAUNCH_INPUTS_DIR = "/tmp/mailwoman-launch-inputs"

export interface LaunchOptions {
	/**
	 * A Modal GPU type, or `cpu` for the CPU image.
	 */
	device: string
	mount: string
	fresh: boolean
	branchFrom?: string
	threads: number
	retries: number
	timeoutSeconds: number
	failAtStep: number
	/**
	 * Run the preflight and print the sandbox, without starting it.
	 */
	dryRun: boolean
}

/**
 * The run key: the first 16 hex digits of the sha256 of the run's checkpoint directory on the volume.
 */
export function runKeyOf(outputDir: string): string {
	return sha256Hex(outputDir).slice(0, 16)
}

const CPU_RESOURCES = { cpu: 4, memoryMiB: 16_384 }

/**
 * A GPU training sandbox's CPU and memory request.
 *
 * The trainer held 7.1 GiB resident at step 22,000 of the 90,000-step run on the A100-40GB, read from the container
 * on 2026-10-31, so 16 GiB leaves it twice that. Its host work is the sampler's fill thread and the encoder.
 * The batch prefetch runs that work during the GPU step, and 4 CPUs cover it.
 */
const GPU_RESOURCES = { cpu: 4, memoryMiB: 16_384 }

/**
 * The supervisor's environment for a launch.
 */
export function supervisorEnvironment(
	config: ResolvedLaunchConfig,
	preflight: PreflightResult,
	options: LaunchOptions
): SupervisorEnvironment {
	const paths = resolveRunPaths(config.outputDir, config.csvLogPath, options.mount)
	const staged = `${options.mount.replace(/\/+$/, "")}/launch/${config.configSHA256.slice(0, 16)}`

	return {
		MW_LAUNCH_ID: crypto.randomUUID(),
		MW_VOLUME: options.mount,
		MW_CONFIG_PATH: `${staged}/${config.name}`,
		MW_RESOLVED_PATH: `${staged}/resolved.json`,
		MW_INPUTS_DIR: LAUNCH_INPUTS_DIR,
		MW_INPUTS_WAIT_SECONDS: "300",
		MW_CONFIG_SHA256: config.configSHA256,
		MW_MANIFEST_PATH: preflight.manifestPath,
		MW_MANIFEST_SHA256: preflight.manifestSHA256,
		MW_RUN_BASE: paths.runBase,
		MW_EXPECT_DEVICE: options.device === "cpu" ? "cpu" : "cuda",
		MW_BRANCH_FROM: options.branchFrom ?? "",
		MW_THREADS: String(options.threads),
		MW_RETRIES: String(options.retries),
		MW_RETRY_DELAY_SECONDS: "10",
		MW_FRESH: options.fresh ? "1" : "0",
		MW_OUTPUT_DIR: paths.outputDir,
		MW_FAIL_AT_STEP: String(options.failAtStep),
		MW_TRAINER: "trainer",
		MW_SYNC: "sync",
	}
}

/**
 * Preflights a config and starts its sandbox.
 *
 * The host's run lock is taken before the preflight, so a second `start` of the run on
 * this host is refused before it audits the corpus, writes a receipt or builds an image.
 * A start from another host is refused by Modal's sandbox name when it starts its sandbox.
 *
 * @throws {DuplicateLaunchError} When a sandbox of the same run is still running.
 * @throws {SandboxNameHeldError} When Modal keeps the name reserved after the run's last sandbox exited.
 * @throws When `--fail-at-step` is given for a GPU device, a fresh start would clear a
 * shared directory, another start of the run holds the host lock, or the preflight refuses.
 */
export async function startLaunch(
	config: ResolvedLaunchConfig,
	options: LaunchOptions,
	deps: LaunchDependencies
): Promise<LaunchRecord> {
	if (options.failAtStep > 0 && options.device !== "cpu") {
		throw new Error("--fail-at-step is a lifecycle check control and runs on the CPU device only")
	}

	const paths = resolveRunPaths(config.outputDir, config.csvLogPath, options.mount)

	if (config.outputDir !== paths.outputDir) {
		throw new Error(`the resolved output_dir ${config.outputDir} is not under ${options.mount}`)
	}

	if (options.fresh) {
		checkClearable(paths.outputDir, options.mount)
	}

	const runKey = runKeyOf(paths.outputDir)

	await using _lock = await deps.lockRun(runKey)

	const [holder] = await deps.boundary.list({ [RUN_TAG]: runKey })

	if (holder) throw new DuplicateLaunchError(runKey, holder.id)

	const preflight = await deps.preflight(config, options.device, options.timeoutSeconds)

	deps.log(`Preflight receipt: ${preflight.token} (${preflight.audits.join(", ")})`)

	const variant = options.device === "cpu" ? "cpu" : "cu130"

	const resources: SandboxResources = {
		...(variant === "cpu" ? CPU_RESOURCES : { ...GPU_RESOURCES, gpu: options.device }),
		timeoutMs: options.timeoutSeconds * 1000,
	}

	const environment = supervisorEnvironment(config, preflight, options)

	const record: LaunchRecord = {
		runKey,
		config: config.name,
		device: options.device,
		imageID: "",
		resources,
		environment,
		inputs: { configBase64: Buffer.from(config.text).toString("base64"), resolved: config.resolvedJSON },
		sandboxes: [],
	}

	if (options.dryRun) {
		const build = await deps.imageBuild(variant)

		deps.log(`Dry run: would start ${build.name} on ${options.device} for ${paths.outputDir} (run ${runKey})`)

		return record
	}

	record.imageID = await deps.boundary.ensureTrainerImage(await deps.imageBuild(variant))

	// Awaited inside the lock's scope, so the lock is held until the sandbox has started.
	return await startSandbox(record, deps)
}

async function startSandbox(record: LaunchRecord, deps: LaunchDependencies): Promise<LaunchRecord> {
	if (typeof record.inputs?.configBase64 !== "string" || typeof record.inputs.resolved !== "string") {
		throw new TypeError(`the record of run ${record.runKey} holds no launch inputs; start the run again with start`)
	}

	const sandbox = await startNamedSandbox(record, deps)
	const next = { ...record, sandboxes: [...record.sandboxes, sandbox.id] }

	await deps.writeRecord(next)
	deps.log(`Started sandbox ${sandbox.id} for run ${record.runKey} on ${record.device}`)

	return next
}

/**
 * Starts the run's sandbox under the run's one name.
 *
 * Modal refuses a second sandbox while one holds the name, which covers the gap
 * between the host's check for a running sandbox and this start.
 * A refused name held by a running sandbox of the run is a duplicate launch.
 *
 * A refused name with no running sandbox is one Modal has not yet released,
 * so the start waits and tries again.
 */
async function startNamedSandbox(record: LaunchRecord, deps: LaunchDependencies) {
	const name = `train-${record.runKey}`

	for (let attempt = 1; ; attempt++) {
		try {
			return await deps.boundary.start({
				...record.resources,
				name,
				imageID: record.imageID,
				command: ["bash", "-c", SUPERVISOR_SCRIPT],
				env: { ...record.environment },
				// `ready` comes last: the supervisor reads the other two once it exists.
				files: [
					{ path: `${LAUNCH_INPUTS_DIR}/config`, contents: Buffer.from(record.inputs.configBase64, "base64") },
					{ path: `${LAUNCH_INPUTS_DIR}/resolved.json`, contents: Buffer.from(record.inputs.resolved) },
					{ path: `${LAUNCH_INPUTS_DIR}/ready`, contents: new Uint8Array() },
				],
				tags: { [RUN_TAG]: record.runKey, config: record.config },
			})
		} catch (error) {
			if (!(error instanceof SandboxNameTakenError)) throw error

			const [holder] = await deps.boundary.list({ [RUN_TAG]: record.runKey })

			if (holder) throw new DuplicateLaunchError(record.runKey, holder.id)

			if (attempt >= NAME_RELEASE_RETRY.attempts) {
				throw new SandboxNameHeldError(record.runKey, name, attempt)
			}

			deps.log(`Modal still reserves ${name}, and no sandbox of the run is running; starting again shortly`)
			await deps.sleep(NAME_RELEASE_RETRY.delayMs)
		}
	}
}

/**
 * Reads a run's state from its newest sandbox.
 *
 * @throws When the host holds no record of the run.
 */
export async function launchStatus(
	runKey: string,
	deps: LaunchDependencies
): Promise<{ record: LaunchRecord; sandbox: SandboxState; state: LaunchState }> {
	const record = await requireRecord(runKey, deps)
	const sandbox = await deps.boundary.get(record.sandboxes.at(-1)!)

	return { record, sandbox, state: launchStateOf(sandbox) }
}

/**
 * The state a sandbox's exit code means.
 */
export function launchStateOf(sandbox: SandboxState): LaunchState {
	if (sandbox.exitCode === null) return LaunchState.Running

	if (sandbox.exitCode === 0) return LaunchState.Completed

	if (sandbox.exitCode === SUPERVISOR_REFUSED_EXIT) return LaunchState.Refused

	return LaunchState.Stopped
}

/**
 * Starts a fresh sandbox for a stopped run, resuming from its newest complete checkpoint.
 * It never clears the run.
 *
 * @throws When the run is still running, completed, or was refused.
 */
export async function restartLaunch(runKey: string, deps: LaunchDependencies): Promise<LaunchRecord> {
	await using _lock = await deps.lockRun(runKey)

	const { record, state } = await launchStatus(runKey, deps)

	if (state !== LaunchState.Stopped) throw new Error(`run ${runKey} is ${state}; only a stopped run restarts`)

	return await startSandbox(
		{
			...record,
			environment: {
				...record.environment,
				MW_LAUNCH_ID: crypto.randomUUID(),
				MW_FRESH: "0",
				MW_FAIL_AT_STEP: "0",
			},
		},
		deps
	)
}

/**
 * Terminates a run's running sandbox.
 * The supervisor committed every finished checkpoint.
 */
export async function cancelLaunch(runKey: string, deps: LaunchDependencies): Promise<void> {
	const { record, state } = await launchStatus(runKey, deps)

	if (state !== LaunchState.Running) throw new Error(`run ${runKey} is ${state}; only a running run cancels`)

	await deps.boundary.terminate(record.sandboxes.at(-1)!)
	deps.log(`Terminated sandbox ${record.sandboxes.at(-1)} of run ${runKey}`)
}

/**
 * Copies a run's output directory from the volume to the host, or one checkpoint directory of it
 * when `checkpoint` names one, and returns the copied files' paths relative to `localDir`.
 *
 * @throws When the host holds no record of the run, or the volume holds no
 * file under the requested directory.
 */
export async function fetchRun(
	runKey: string,
	checkpoint: string | null,
	localDir: string,
	deps: LaunchDependencies
): Promise<string[]> {
	const record = await requireRecord(runKey, deps)
	const remote = checkpoint ? `${record.environment.MW_OUTPUT_DIR}/${checkpoint}` : record.environment.MW_OUTPUT_DIR

	return deps.boundary.fetchDirectory(remote, localDir)
}

async function requireRecord(runKey: string, deps: LaunchDependencies): Promise<LaunchRecord> {
	const record = await deps.readRecord(runKey)

	if (!record?.sandboxes.length) throw new Error(`no launch record with a sandbox for run ${runKey}`)

	return record
}
