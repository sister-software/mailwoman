/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Child processes, typed over {@linkcode PathBuilderLike} and answering text: this is the one place `node:child_process`
 *   is reached, with synchronous twins for a slot whose caller is synchronous and not yours to change.
 */

import {
	type ChildProcess,
	type ChildProcessByStdio,
	type ChildProcessWithoutNullStreams,
	execFile,
	type ExecFileOptions,
	execFileSync,
	type ExecFileSyncOptions,
	execSync,
	type ExecSyncOptions,
	fork,
	type ForkOptions,
	spawn,
	type SpawnOptions,
	type SpawnOptionsWithoutStdio,
	type SpawnOptionsWithStdioTuple,
	spawnSync,
	type SpawnSyncOptions,
	type SpawnSyncReturns,
	type StdioNull,
	type StdioPipe,
} from "node:child_process"
import type { Readable, Writable } from "node:stream"
import { promisify } from "node:util"

import type { PathBuilderLike } from "path-ts"

import type { IRuntimeLogger } from "#logging"
import { TypedEventTarget } from "#utils/events"

export type {
	ChildProcess,
	ChildProcessByStdio,
	ChildProcessWithoutNullStreams,
	ExecFileOptions,
	ExecFileSyncOptions,
	ExecSyncOptions,
	ForkOptions,
	SpawnOptions,
	SpawnOptionsWithoutStdio,
	SpawnOptionsWithStdioTuple,
	SpawnSyncOptions,
	SpawnSyncReturns,
	StdioNull,
	StdioPipe,
} from "node:child_process"

const execFileAsync = promisify(execFile)

/**
 * What a finished command wrote, decoded as UTF-8.
 */
export interface ProcessOutput {
	stdout: string
	stderr: string
}

/**
 * The rejection {@linkcode runFile} answers for a command that started
 * but did not exit 0: the builtin's error.
 *
 * That error includes the streams and the exit code or signal that ended it.
 */
export interface ProcessError extends Error, ProcessOutput {
	code?: number | string
	signal?: NodeJS.Signals
}

/**
 * Whether an error is a {@linkcode ProcessError}: a command that ran and failed,
 * as opposed to one that never started.
 */
export function isProcessError(error: unknown): error is ProcessError {
	return error instanceof Error && "stdout" in error && "stderr" in error
}

/**
 * Options for {@linkcode runFile}, whose output is always decoded as UTF-8 and
 * where an `encoding` is accepted for the callers that spell it but has no effect.
 */
export type RunFileOptions = Omit<ExecFileOptions, "cwd"> & { cwd?: PathBuilderLike }

/**
 * Run a command to completion and answer what it wrote: rejects with a {@linkcode ProcessError} on a
 * non-zero exit but with the plain spawn error when the command could not start (enoent, eacces).
 */
export async function runFile(
	file: PathBuilderLike,
	args: readonly PathBuilderLike[] = [],
	options: RunFileOptions = {}
): Promise<ProcessOutput> {
	const { stdout, stderr } = await execFileAsync(
		file.toString(),
		args.map((arg) => arg.toString()),
		{
			...options,
			cwd: options.cwd?.toString(),
			encoding: "utf8",
		}
	)

	return { stdout, stderr }
}

/**
 * Options for {@linkcode runFileSync}, whose output is always decoded as UTF-8.
 */
export interface RunFileSyncOptions extends Omit<ExecFileSyncOptions, "cwd"> {
	cwd?: PathBuilderLike
}

/**
 * {@linkcode runFile} for a synchronous slot: answers stdout, throws the builtin's error on a non-zero exit.
 *
 * It answers the empty string when `stdio` inherits the parent's streams.
 */
export function runFileSync(
	file: PathBuilderLike,
	args: readonly PathBuilderLike[] = [],
	options: RunFileSyncOptions = {}
): string {
	const output = execFileSync(
		file.toString(),
		args.map((arg) => arg.toString()),
		{
			...options,
			cwd: options.cwd?.toString(),
			encoding: "utf8",
		}
	)

	return output ?? ""
}

/**
 * Run a shell command line synchronously and answer stdout.
 *
 * Reach for {@linkcode runFileSync} unless the command needs the shell, because an
 * argument list does not get re-parsed, quoted or expanded.
 */
export function runShellSync(command: string, options: ExecSyncOptions & { cwd?: PathBuilderLike } = {}): string {
	return execSync(command, { ...options, cwd: options.cwd?.toString(), encoding: "utf8" }) ?? ""
}

/**
 * Options for {@linkcode spawnProcess}.
 */
export type SpawnProcessOptions = Omit<SpawnOptions, "cwd"> & { cwd?: PathBuilderLike }

/**
 * Start a command and hand its {@linkcode ChildProcess} to the caller,
 * who owns the streams, the exit event and the kill.
 *
 * Without a `stdio` option every stream is a pipe, as the return type specifies.
 */
export function spawnProcess(
	file: PathBuilderLike,
	args?: readonly PathBuilderLike[],
	options?: Omit<SpawnOptionsWithoutStdio, "cwd"> & { cwd?: PathBuilderLike }
): ChildProcessWithoutNullStreams

export function spawnProcess<
	Stdin extends StdioNull | StdioPipe,
	Stdout extends StdioNull | StdioPipe,
	Stderr extends StdioNull | StdioPipe,
>(
	file: PathBuilderLike,
	args: readonly PathBuilderLike[],
	options: Omit<SpawnOptionsWithStdioTuple<Stdin, Stdout, Stderr>, "cwd"> & { cwd?: PathBuilderLike }
): ChildProcessByStdio<
	Stdin extends StdioPipe ? Writable : null,
	Stdout extends StdioPipe ? Readable : null,
	Stderr extends StdioPipe ? Readable : null
>

export function spawnProcess(
	file: PathBuilderLike,
	args: readonly PathBuilderLike[],
	options: SpawnProcessOptions
): ChildProcess

export function spawnProcess(
	file: PathBuilderLike,
	args: readonly PathBuilderLike[] = [],
	options: SpawnProcessOptions = {}
): ChildProcess {
	return spawn(
		file.toString(),
		args.map((arg) => arg.toString()),
		{ ...options, cwd: options.cwd?.toString() }
	)
}

/**
 * Options for {@linkcode spawnProcessSync}, whose streams are always decoded as UTF-8.
 */
export type SpawnProcessSyncOptions = Omit<SpawnSyncOptions, "cwd"> & { cwd?: PathBuilderLike }

/**
 * {@linkcode spawnProcess} run to completion in a synchronous slot where,
 * unlike {@linkcode runFileSync}, a non-zero exit does not throw but comes back in
 * the result with the status, signal and both streams.
 */
export function spawnProcessSync(
	file: PathBuilderLike,
	args: readonly PathBuilderLike[] = [],
	options: SpawnProcessSyncOptions = {}
): SpawnSyncReturns<string> {
	return spawnSync(
		file.toString(),
		args.map((arg) => arg.toString()),
		{ ...options, cwd: options.cwd?.toString(), encoding: "utf8" }
	)
}

/**
 * One step of a long-running command's progress, as a {@linkcode ProgressParser}
 * reads it from a line of output.
 */
export interface ProcessProgress {
	/**
	 * The phase the command reports, such as git's `Receiving objects`.
	 */
	stage: string
	/**
	 * Completion of the stage, from 0 to 100, when the command states it.
	 */
	percent?: number
	processed?: number
	total?: number
}

/**
 * Reads one line of a command's stderr and answers the progress it reports, or `null` for any other line.
 */
export type ProgressParser = (line: string) => ProcessProgress | null

/**
 * How a {@linkcode ProcessTask} ended.
 *
 * `exitCode` is `null` when a signal ended the process, and `signal` is `null` when it exited on its own.
 */
export interface ProcessResult extends ProcessOutput {
	command: string
	exitCode: number | null
	signal: NodeJS.Signals | null
}

/**
 * The stream a line of output arrived on.
 */
export const OutputStream = {
	Stdout: "stdout",
	Stderr: "stderr",
} as const

export type OutputStream = (typeof OutputStream)[keyof typeof OutputStream]

/**
 * The events a {@linkcode ProcessTask} dispatches, keyed by type, with each event's `detail`.
 */
export interface ProcessTaskEventMap {
	/**
	 * One line of piped output.
	 *
	 * A carriage return ends a line as a newline does, so each redraw of a progress meter arrives separately.
	 */
	line: { stream: OutputStream; text: string }
	progress: ProcessProgress
	exit: ProcessResult
}

/**
 * Options for {@linkcode ProcessTask}.
 */
export interface ProcessTaskOptions extends Omit<SpawnOptions, "cwd" | "stdio" | "signal"> {
	cwd?: PathBuilderLike
	/**
	 * Aborting the signal stops the process as disposal does.
	 */
	signal?: AbortSignal
	/**
	 * Receives the command line at debug level when the process starts and the result when it ends.
	 */
	logger?: IRuntimeLogger
	/**
	 * Whether a non-zero exit or a terminating signal rejects `result` with a {@linkcode ProcessError}.
	 *
	 * With `false`, `result` resolves with the {@linkcode ProcessResult}, and the caller reads `exitCode`.
	 *
	 * A command that could not start always rejects with the spawn error.
	 *
	 * @defaultValue `true`
	 */
	reject?: boolean
	/**
	 * `"pipe"` captures a stream and dispatches its lines.
	 * `"inherit"` writes it to this process's terminal.
	 *
	 * @defaultValue `"ignore"` for stdin, `"pipe"` for stdout and stderr
	 */
	stdin?: "ignore" | "inherit" | "pipe"
	stdout?: "ignore" | "inherit" | "pipe"
	stderr?: "ignore" | "inherit" | "pipe"
	/**
	 * Leave a piped stdout unread, so the caller consumes `child.stdout` as bytes,
	 * such as an archive piped into another process.
	 *
	 * The task then dispatches no stdout lines, and `result.stdout` is empty.
	 */
	rawStdout?: boolean
	/**
	 * Reads each stderr line for progress and dispatches a `progress` event for each match.
	 */
	progress?: ProgressParser
	/**
	 * How long disposal waits after SIGTERM before it sends SIGKILL.
	 *
	 * @defaultValue 5000
	 */
	killGraceMs?: number
}

const DEFAULT_KILL_GRACE_MS = 5000

/**
 * A running command that reports its output as events, settles `result` with its
 * {@linkcode ProcessResult}, and is stopped by disposal.
 *
 * It follows the shape of `APIClient`: an `EventTarget` that owns its work
 * and implements `AsyncDisposable`.
 * A caller renders the `line` and `progress` events while the command runs.
 *
 * `await using` stops the command when the caller's scope ends early.
 *
 * Reach for {@linkcode runFile} when the caller needs only the finished output.
 */
export class ProcessTask extends TypedEventTarget<ProcessTaskEventMap> implements AsyncDisposable {
	public readonly command: string
	public readonly child: ChildProcess
	/**
	 * Settles once the process has exited and both streams have closed.
	 */
	public readonly result: Promise<ProcessResult>

	readonly #exited: Promise<void>
	readonly #killGraceMs: number
	readonly #signal: AbortSignal | undefined
	readonly #onAbort = (): void => {
		void this[Symbol.asyncDispose]()
	}

	#disposePromise: Promise<void> | null = null

	constructor(file: PathBuilderLike, args: readonly PathBuilderLike[] = [], options: ProcessTaskOptions = {}) {
		super()

		const {
			cwd,
			signal,
			logger,
			reject = true,
			stdin = "ignore",
			stdout = "pipe",
			stderr = "pipe",
			progress,
			rawStdout = false,
			killGraceMs = DEFAULT_KILL_GRACE_MS,
			...spawnOptions
		} = options

		const argStrings = args.map((arg) => arg.toString())

		this.command = [file.toString(), ...argStrings].join(" ")
		this.#killGraceMs = killGraceMs
		this.#signal = signal

		signal?.throwIfAborted()

		logger?.debug(`$ ${this.command}`)

		this.child = spawn(file.toString(), argStrings, {
			...spawnOptions,
			cwd: cwd?.toString(),
			stdio: [stdin, stdout, stderr],
		})

		const captured: Record<OutputStream, string[]> = { stdout: [], stderr: [] }

		const readLines = (stream: OutputStream, readable: Readable | null): void => {
			if (!readable) return

			let pending = ""

			const emit = (text: string): void => {
				captured[stream].push(text)
				this.emit("line", { stream, text })

				if (stream === OutputStream.Stderr && progress) {
					const step = progress(text)

					if (step) {
						this.emit("progress", step)
					}
				}
			}

			readable.setEncoding("utf8")

			readable.on("data", (chunk: string) => {
				const pieces = (pending + chunk).split(/\r\n|\r|\n/u)

				pending = pieces.pop() ?? ""

				for (const piece of pieces) {
					emit(piece)
				}
			})

			readable.on("end", () => {
				if (pending) {
					emit(pending)
				}

				pending = ""
			})
		}

		readLines(OutputStream.Stdout, rawStdout ? null : this.child.stdout)
		readLines(OutputStream.Stderr, this.child.stderr)

		this.#exited = new Promise<void>((resolve) => {
			this.child.once("close", () => resolve())
			// A process that never started emits `error` and no `close`.
			this.child.once("error", () => resolve())
		})

		this.result = new Promise<ProcessResult>((resolve, rejectCompletion) => {
			this.child.once("error", rejectCompletion)

			this.child.once("close", (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
				const result: ProcessResult = {
					command: this.command,
					exitCode,
					signal: exitSignal,
					stdout: captured.stdout.join("\n"),
					stderr: captured.stderr.join("\n"),
				}

				logger?.debug(`${this.command} exited with ${exitSignal ?? exitCode}`)
				this.emit("exit", result)

				if (reject && exitCode !== 0) {
					const error = new Error(
						`Command failed with ${exitSignal ? `signal ${exitSignal}` : `exit code ${exitCode}`}: ${this.command}`
					) as ProcessError

					error.stdout = result.stdout
					error.stderr = result.stderr
					error.code = exitCode ?? undefined
					error.signal = exitSignal ?? undefined

					rejectCompletion(error)

					return
				}

				resolve(result)
			})
		}).finally(() => {
			this.#signal?.removeEventListener("abort", this.#onAbort)
		})

		// A task that is only disposed, never awaited, must not raise an unhandled rejection.
		// Awaiting callers still receive the rejection through `result`.
		this.result.catch(() => undefined)

		signal?.addEventListener("abort", this.#onAbort, { once: true })
	}

	/**
	 * Disposal sends SIGTERM to a running process, sends SIGKILL if it has not exited
	 * after `killGraceMs`, and resolves once it has exited.
	 * A process that already exited is left alone.
	 *
	 * Disposal never rejects.
	 * The `result` promise still reports how the process ended.
	 * Repeated calls return the same promise.
	 */
	public [Symbol.asyncDispose](): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise

		this.#disposePromise = this.#stop()

		return this.#disposePromise
	}

	async #stop(): Promise<void> {
		const { child } = this

		if (child.exitCode === null && child.signalCode === null && child.pid) {
			child.kill("SIGTERM")

			const escalation = setTimeout(() => child.kill("SIGKILL"), this.#killGraceMs)

			escalation.unref()
			await this.#exited
			clearTimeout(escalation)
		} else {
			await this.#exited
		}
	}

	public override toString(): string {
		return this.command
	}
}

/**
 * Run a command to completion as a {@linkcode ProcessTask} and answer its {@linkcode ProcessResult}.
 *
 * With `reject: false` a non-zero exit resolves, and the caller reads `exitCode`.
 * Reach for the task itself when the caller renders its lines or progress while it runs.
 */
export function runProcess(
	file: PathBuilderLike,
	args: readonly PathBuilderLike[] = [],
	options: ProcessTaskOptions = {}
): Promise<ProcessResult> {
	return new ProcessTask(file, args, options).result
}

/**
 * Options for {@linkcode forkProcess}.
 */
export type ForkProcessOptions = Omit<ForkOptions, "cwd"> & { cwd?: PathBuilderLike }

/**
 * Start a Node module as a child with an IPC channel — the worker-host shape.
 */
export function forkProcess(
	modulePath: PathBuilderLike,
	args: readonly PathBuilderLike[] = [],
	options: ForkProcessOptions = {}
): ChildProcess {
	return fork(
		modulePath.toString(),
		args.map((arg) => arg.toString()),
		{ ...options, cwd: options.cwd?.toString() }
	)
}
