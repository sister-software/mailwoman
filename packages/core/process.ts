/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Child processes, typed over {@linkcode PathBuilderLike} and answering text. This is the one place `node:child_process`
 *   is reached: {@linkcode runFile} for a command whose output is the result, {@linkcode spawnProcess} for one whose
 *   streams or lifetime the caller owns, and their synchronous twins for a slot whose caller is synchronous and not
 *   yours to change — a `.filter()` predicate, a constructor, a config file read at load.
 *
 *   `chunk-process.ts` sits above this for the fan-out case: one script per chunk, a JSON result line back.
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
 * The rejection {@linkcode runFile} answers for a command that started but did not exit 0: the builtin's error, which
 * carries the streams and the exit code (or the signal that ended it).
 */
export interface ProcessError extends Error, ProcessOutput {
	code?: number | string
	signal?: NodeJS.Signals
}

/**
 * Whether an error is a {@linkcode ProcessError} — a command that ran and failed, as opposed to one that never started.
 */
export function isProcessError(error: unknown): error is ProcessError {
	return error instanceof Error && "stdout" in error && "stderr" in error
}

/**
 * Options for {@linkcode runFile}: the builtin's. Output is always decoded as UTF-8; an `encoding` here is accepted for
 * the callers that spell it and changes nothing.
 */
export type RunFileOptions = ExecFileOptions & { cwd?: PathBuilderLike }

/**
 * Run a command to completion and answer what it wrote.
 *
 * Rejects with a {@linkcode ProcessError} on a non-zero exit — the shape every caller of `promisify(execFile)` already
 * handled — and with the plain spawn error when the command could not start (ENOENT, EACCES).
 */
export async function runFile(
	file: PathBuilderLike,
	args: readonly PathBuilderLike[] = [],
	options: RunFileOptions = {}
): Promise<ProcessOutput> {
	const { stdout, stderr } = await execFileAsync(file.toString(), args.map(String), {
		...options,
		cwd: options.cwd?.toString(),
		encoding: "utf8",
	})

	return { stdout, stderr }
}

/**
 * Options for {@linkcode runFileSync}: the builtin's. Output is always decoded as UTF-8.
 */
export type RunFileSyncOptions = ExecFileSyncOptions & { cwd?: PathBuilderLike }

/**
 * {@linkcode runFile} for a synchronous slot. Answers stdout; throws on a non-zero exit, with the builtin's error.
 *
 * When `stdio` inherits the parent's streams there is nothing to capture and the answer is the empty string.
 */
export function runFileSync(
	file: PathBuilderLike,
	args: readonly PathBuilderLike[] = [],
	options: RunFileSyncOptions = {}
): string {
	const output = execFileSync(file.toString(), args.map(String), {
		...options,
		cwd: options.cwd?.toString(),
		encoding: "utf8",
	})

	return output ?? ""
}

/**
 * Run a SHELL command line synchronously and answer stdout. Reach for {@linkcode runFileSync} unless the command needs
 * the shell — an argument list does not get re-parsed, quoted or expanded.
 */
export function runShellSync(command: string, options: ExecSyncOptions & { cwd?: PathBuilderLike } = {}): string {
	return execSync(command, { ...options, cwd: options.cwd?.toString(), encoding: "utf8" }) ?? ""
}

/**
 * Options for {@linkcode spawnProcess}.
 */
export type SpawnProcessOptions = SpawnOptions & { cwd?: PathBuilderLike }

/**
 * Start a command and hand its {@linkcode ChildProcess} to the caller, who owns the streams, the exit event and the
 * kill. For a command whose output is the whole result, {@linkcode runFile} is the shorter path.
 *
 * Without a `stdio` option every stream is a pipe, and the answer says so in its type — the same narrowing the builtin
 * makes.
 */
export function spawnProcess(
	file: PathBuilderLike,
	args?: readonly PathBuilderLike[],
	options?: SpawnOptionsWithoutStdio & { cwd?: PathBuilderLike }
): ChildProcessWithoutNullStreams

export function spawnProcess<
	Stdin extends StdioNull | StdioPipe,
	Stdout extends StdioNull | StdioPipe,
	Stderr extends StdioNull | StdioPipe,
>(
	file: PathBuilderLike,
	args: readonly PathBuilderLike[],
	options: SpawnOptionsWithStdioTuple<Stdin, Stdout, Stderr> & { cwd?: PathBuilderLike }
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
	return spawn(file.toString(), args.map(String), { ...options, cwd: options.cwd?.toString() })
}

/**
 * Options for {@linkcode spawnProcessSync}: the builtin's. Streams are always decoded as UTF-8.
 */
export type SpawnProcessSyncOptions = SpawnSyncOptions & { cwd?: PathBuilderLike }

/**
 * {@linkcode spawnProcess} run to completion in a synchronous slot. Unlike {@linkcode runFileSync} a non-zero exit does
 * NOT throw — the status, the signal and both streams come back in the result, for a caller that reads them.
 */
export function spawnProcessSync(
	file: PathBuilderLike,
	args: readonly PathBuilderLike[] = [],
	options: SpawnProcessSyncOptions = {}
): SpawnSyncReturns<string> {
	return spawnSync(file.toString(), args.map(String), { ...options, cwd: options.cwd?.toString(), encoding: "utf8" })
}

/**
 * Options for {@linkcode forkProcess}.
 */
export type ForkProcessOptions = ForkOptions & { cwd?: PathBuilderLike }

/**
 * Start a Node module as a child with an IPC channel — the worker-host shape.
 */
export function forkProcess(
	modulePath: PathBuilderLike,
	args: readonly PathBuilderLike[] = [],
	options: ForkProcessOptions = {}
): ChildProcess {
	return fork(modulePath.toString(), args.map(String), { ...options, cwd: options.cwd?.toString() })
}
