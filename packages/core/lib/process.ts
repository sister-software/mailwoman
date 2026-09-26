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
 * The rejection {@linkcode runFile} answers for a command that started but did not exit 0:
 * the builtin's error, which carries the streams and the exit code (or the signal that ended it).
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
 * {@linkcode runFile} for a synchronous slot: answers stdout, throws the builtin's error on
 * a non-zero exit, and answers the empty string when `stdio` inherits the parent's streams.
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
 * Run a shell command line synchronously and answer stdout; reach for {@linkcode runFileSync} unless
 * the command needs the shell, because an argument list does not get re-parsed, quoted or expanded.
 */
export function runShellSync(command: string, options: ExecSyncOptions & { cwd?: PathBuilderLike } = {}): string {
	return execSync(command, { ...options, cwd: options.cwd?.toString(), encoding: "utf8" }) ?? ""
}

/**
 * Options for {@linkcode spawnProcess}.
 */
export type SpawnProcessOptions = Omit<SpawnOptions, "cwd"> & { cwd?: PathBuilderLike }

/**
 * Start a command and hand its {@linkcode ChildProcess} to the caller, who owns the streams, the exit
 * event and the kill; without a `stdio` option every stream is a pipe and the return type says so.
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
