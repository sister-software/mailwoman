/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The training launch lifecycle: preflight on the host, one detached sandbox per attempt run, and the status, log,
 *   cancel and restart operations on it.
 *
 *   A launch resolves its config on the host, which is also the source-rights admission, and runs the preflight audits
 *   against the host mirror of the volume. The receipt's key binds the YAML and the corpus MANIFEST, and the sandbox
 *   refuses a volume whose MANIFEST differs from the one the host hashed. The sandbox runs the supervisor
 *   (`supervisor.ts`), which restarts the trainer in the same container after a failed exit. A sandbox that Modal
 *   preempts, or one that times out or spends its retries, is restarted by {@linkcode restartLaunch} in a fresh
 *   sandbox that resumes from the newest complete checkpoint. Every launch writes a {@linkcode LaunchRecord} on the
 *   host, so the operations after it need only the run key.
 */

import { sha256Hex } from "@mailwoman/core/hash"

import type { ModalBoundary, SandboxResources, SandboxState, TrainerImageBuild } from "#tools/training/launch/boundary"
import { checkClearable, resolveRunPaths } from "#tools/training/launch/run-paths"
import {
	SUPERVISOR_REFUSED_EXIT,
	SUPERVISOR_SCRIPT,
	type SupervisorEnvironment,
} from "#tools/training/launch/supervisor"

/**
 * The tag every training sandbox carries, keying it to one run directory.
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
	 */
	preflight(config: ResolvedLaunchConfig, device: string): Promise<PreflightResult>
	/**
	 * The trainer image build for `variant`, whose name hashes the sources.
	 */
	imageBuild(variant: "cpu" | "cu130"): Promise<TrainerImageBuild>
	readRecord(runKey: string): Promise<LaunchRecord | null>
	writeRecord(record: LaunchRecord): Promise<void>
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
	sandboxes: string[]
}

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
const GPU_RESOURCES = { cpu: 8, memoryMiB: 32_768 }

/**
 * The supervisor's environment for a launch.
 */
export function supervisorEnvironment(
	config: ResolvedLaunchConfig,
	preflight: PreflightResult,
	options: LaunchOptions,
	runKey: string
): SupervisorEnvironment {
	const paths = resolveRunPaths(config.outputDir, config.csvLogPath, options.mount)
	const staged = `${options.mount.replace(/\/+$/, "")}/launch/${config.configSHA256.slice(0, 16)}`

	return {
		MW_RUN_ID: runKey,
		MW_VOLUME: options.mount,
		MW_CONFIG_PATH: `${staged}/${config.name}`,
		MW_RESOLVED_PATH: `${staged}/resolved.json`,
		MW_CONFIG_B64: Buffer.from(config.text).toString("base64"),
		MW_RESOLVED_B64: Buffer.from(config.resolvedJSON).toString("base64"),
		MW_CONFIG_SHA256: config.configSHA256,
		MW_MANIFEST_PATH: preflight.manifestPath,
		MW_MANIFEST_SHA256: preflight.manifestSHA256,
		MW_RUN_BASE: paths.runBase,
		MW_EXPECT_DEVICE: options.device === "cpu" ? "cpu" : "cuda",
		MW_RESUME: options.branchFrom ?? "auto",
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
 * @throws {DuplicateLaunchError} When a sandbox of the same run is still running.
 * @throws When `--fail-at-step` is given for a GPU device, a fresh start would
 * clear a shared directory, or the preflight refuses.
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
	const [holder] = await deps.boundary.list({ [RUN_TAG]: runKey })

	if (holder) throw new DuplicateLaunchError(runKey, holder.id)

	const preflight = await deps.preflight(config, options.device)

	deps.log(`Preflight receipt: ${preflight.token} (${preflight.audits.join(", ")})`)

	const variant = options.device === "cpu" ? "cpu" : "cu130"

	const resources: SandboxResources = {
		...(variant === "cpu" ? CPU_RESOURCES : { ...GPU_RESOURCES, gpu: options.device }),
		timeoutMs: options.timeoutSeconds * 1000,
	}

	const environment = supervisorEnvironment(config, preflight, options, runKey)

	const record: LaunchRecord = {
		runKey,
		config: config.name,
		device: options.device,
		imageID: "",
		resources,
		environment,
		sandboxes: [],
	}

	if (options.dryRun) {
		const build = await deps.imageBuild(variant)

		deps.log(`Dry run: would start ${build.name} on ${options.device} for ${paths.outputDir} (run ${runKey})`)

		return record
	}

	record.imageID = await deps.boundary.ensureTrainerImage(await deps.imageBuild(variant))

	return startSandbox(record, deps)
}

async function startSandbox(record: LaunchRecord, deps: LaunchDependencies): Promise<LaunchRecord> {
	const sandbox = await deps.boundary.start({
		...record.resources,
		name: `train-${record.runKey}-${record.sandboxes.length}`,
		imageID: record.imageID,
		command: ["bash", "-c", SUPERVISOR_SCRIPT],
		env: { ...record.environment },
		tags: { [RUN_TAG]: record.runKey, config: record.config },
	})

	const next = { ...record, sandboxes: [...record.sandboxes, sandbox.id] }

	await deps.writeRecord(next)
	deps.log(`Started sandbox ${sandbox.id} for run ${record.runKey} on ${record.device}`)

	return next
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
	const { record, state } = await launchStatus(runKey, deps)

	if (state !== LaunchState.Stopped) throw new Error(`run ${runKey} is ${state}; only a stopped run restarts`)

	return startSandbox(
		{ ...record, environment: { ...record.environment, MW_FRESH: "0", MW_RESUME: "auto", MW_FAIL_AT_STEP: "0" } },
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

async function requireRecord(runKey: string, deps: LaunchDependencies): Promise<LaunchRecord> {
	const record = await deps.readRecord(runKey)

	if (!record?.sandboxes.length) throw new Error(`no launch record with a sandbox for run ${runKey}`)

	return record
}
