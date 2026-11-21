// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Starts one server, waits for its listening line, sends GET requests to it on loopback,
 * and stops it by the process id it started.
 *
 * The server runs without a shell.
 * Its whole output goes to a log under the cache root's `checks` directory.
 *
 * The stop runs on every path out of {@link runProbe}: after the requests, after an early exit,
 * after the startup wait expired, after an interrupt, and after an error.
 * It sends SIGTERM, then SIGKILL when the process hasn't exited within the grace period, and
 * then checks by process id that neither the server nor any descendant it started remains.
 */

import { type ClockLike, systemClock } from "@mailwoman/core/api/clock"
import { cacheRootPath } from "@mailwoman/core/data-root"
import { processExists } from "@mailwoman/core/fs/lock"
import { finished, openWriteStream } from "@mailwoman/core/fs/streams"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { ProcessTask, type ProcessResult } from "@mailwoman/core/process"
import { isoSeconds } from "@mailwoman/core/utils"
import { resolvePath } from "path-ts"

import { httpGet, type HTTPGetResult, type JSONProjection } from "#check-kit/http-get"
import { readDescendants, readProcessTreeMemory, type ProcessTreeMemory } from "#check-kit/probe/memory"

/**
 * The exit statuses of `mwops probe`.
 */
export const ProbeExit = {
	/**
	 * The server listened, every request received an HTTP response, and the server stopped.
	 */
	Passed: 0,
	/**
	 * At least one request received no HTTP response.
	 */
	RequestFailed: 1,
	/**
	 * The server exited, or never started, before it printed a listening line.
	 */
	ExitedBeforeListening: 3,
	/**
	 * The startup wait expired before a listening line.
	 */
	StartupExpired: 4,
	/**
	 * A server process remained after the stop.
	 */
	StopFailed: 6,
	/**
	 * An interrupt ended the probe, after the probe stopped the server.
	 */
	Interrupted: 130,
} as const

/**
 * How the server's startup ended.
 */
const ProbeOutcome = {
	Listened: "listened",
	ExitedBeforeListening: "exited-before-listening",
	DidNotStart: "did-not-start",
	StartupExpired: "startup-expired",
	Interrupted: "interrupted",
} as const

type ProbeOutcome = (typeof ProbeOutcome)[keyof typeof ProbeOutcome]

/**
 * The address every request goes to.
 */
export const PROBE_HOST = "127.0.0.1"

/**
 * The line a server prints once bound, with the bound port.
 */
const LISTENING_LINE = /listening on http:\/\/[^\s/:]+:(\d+)/u

/**
 * The most output lines the result repeats, from the start and from the end.
 */
const OUTPUT_LINES = 40

/**
 * How long the stop waits after SIGTERM before it sends SIGKILL.
 *
 * The `mailwoman serve` primary waits up to 10 seconds for its workers to drain, so the grace is longer.
 */
const DEFAULT_STOP_GRACE_MS = 15_000

/**
 * The command that starts the server.
 */
export interface ProbeCommand {
	executable: string
	args: readonly string[]
	cwd: string
}

/**
 * Options for {@link runProbe}.
 */
interface RunProbeOptions {
	/**
	 * The workspace name the log file name and the result record.
	 */
	workspace: string
	command: ProbeCommand
	/**
	 * Request paths, each starting with `/`, sent in order.
	 */
	gets: readonly string[]
	jsonPath?: string
	maxBytes?: number
	/**
	 * Values added to the inherited environment.
	 */
	env?: Readonly<Record<string, string>>
	startupTimeoutMs: number
	stopGraceMs?: number
	logDirectory?: string
	/**
	 * The clock the startup wait reads, injected by a test.
	 */
	clock?: ClockLike
	/**
	 * Aborts on an interrupt, so the probe stops the server and returns.
	 */
	interrupt?: AbortSignal
}

/**
 * One request's result.
 *
 * `body` is the text up to the cap, and is left out when a JSON projection was asked for and found.
 */
interface ProbeRequest {
	path: string
	url: string
	status: number | null
	contentType: string | null
	durationMs: number
	body: string | null
	binary: boolean
	bytesRead: number
	truncated: boolean
	fullLength: number | null
	json: JSONProjection | null
	/**
	 * Why no HTTP response came back, with the socket's cause code.
	 */
	error: { message: string; causeCode: string | null } | null
}

/**
 * How the server stopped.
 */
interface ProbeStop {
	pid: number | null
	/**
	 * The signal the stop sent, or `null` when the server had already exited.
	 */
	signalSent: "SIGTERM" | null
	/**
	 * Whether SIGKILL was needed after the grace period.
	 */
	forced: boolean
	exitCode: number | null
	signal: string | null
	waitedMs: number
	/**
	 * Descendants of the server that outlived it and received SIGKILL.
	 */
	descendantsKilled: number[]
	/**
	 * Process ids, of the server or its descendants, that still exist after the stop.
	 */
	remaining: number[]
}

/**
 * One probe's result.
 */
export interface ProbeResult {
	workspace: string
	command: string[]
	commandLine: string
	cwd: string
	/**
	 * The names of the environment values added, without their values.
	 */
	envNames: string[]
	logPath: string
	outcome: ProbeOutcome
	startupTimeoutMs: number
	/**
	 * The listening line and the time from process start to it, or `null` when the server never listened.
	 */
	listening: { url: string; port: number; line: string; startupMs: number } | null
	/**
	 * The exit of a server that ended before it listened, or why it didn't start.
	 */
	earlyExit: { exitCode: number | null; signal: string | null; error: string | null } | null
	/**
	 * The output up to and including the listening line, at most {@link OUTPUT_LINES} lines.
	 */
	startupOutput: string[]
	/**
	 * The last {@link OUTPUT_LINES} lines of output.
	 */
	outputTail: string[]
	requests: ProbeRequest[]
	/**
	 * The server tree's memory, read after the requests and before the stop,
	 * or `null` when it never listened.
	 */
	memory: ProcessTreeMemory | null
	stop: ProbeStop
	exitCode: number
	summary: string
}

/**
 * The directory a probe's log goes to when no `--log-dir` is given.
 */
function defaultProbeLogDirectory(): string {
	return cacheRootPath("checks")
}

function toProbeRequest(path: string, result: HTTPGetResult, durationMs: number, jsonPath: boolean): ProbeRequest {
	const projected = jsonPath && result.json?.present === true

	return {
		path,
		url: result.url,
		status: result.status,
		contentType: result.contentType,
		durationMs,
		body: projected ? null : result.body,
		binary: result.binary,
		bytesRead: result.bytesRead,
		truncated: result.truncated,
		fullLength: result.fullLength,
		json: result.json,
		error: result.error,
	}
}

type StartupEnd =
	| { kind: "listened"; port: number; line: string }
	| { kind: "exited"; result: ProcessResult }
	| { kind: "failed"; error: string }
	| { kind: "expired" }
	| { kind: "interrupted" }

/**
 * Wait until `promise` settles or `ms` passes on the system clock.
 *
 * @returns Whether the promise settled first.
 */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined

	const expired = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), ms)
	})

	try {
		return await Promise.race([
			promise.then(
				() => true,
				() => true
			),
			expired,
		])
	} finally {
		clearTimeout(timer)
	}
}

/**
 * Stop the server by its process id, then check that it and its descendants are gone.
 */
async function stopServer(
	task: ProcessTask,
	exited: Promise<ProcessResult | null>,
	graceMs: number
): Promise<ProbeStop> {
	const { child } = task
	const pid = child.pid ?? null
	const started = Date.now()
	const running = pid != null && child.exitCode === null && child.signalCode === null
	// The descendants are read while the server still runs, so each can be checked after it exits.
	const descendants = running ? await readDescendants(pid) : []
	let forced = false

	if (running) {
		child.kill("SIGTERM")

		if (!(await settlesWithin(exited, graceMs))) {
			forced = true
			child.kill("SIGKILL")
		}
	}

	const result = await exited
	const descendantsKilled: number[] = []

	for (const descendant of descendants) {
		if (processExists(descendant)) {
			process.kill(descendant, "SIGKILL")
			descendantsKilled.push(descendant)
		}
	}

	if (descendantsKilled.length) {
		await new Promise((resolve) => {
			setTimeout(resolve, 500)
		})
	}

	const remaining = [...(pid != null ? [pid] : []), ...descendants].filter((entry) => processExists(entry))

	return {
		pid,
		signalSent: running ? "SIGTERM" : null,
		forced,
		exitCode: result?.exitCode ?? null,
		signal: result?.signal ?? null,
		waitedMs: Date.now() - started,
		descendantsKilled,
		remaining,
	}
}

function describeExit(exit: { exitCode: number | null; signal: string | null }): string {
	return exit.signal ? `signal ${exit.signal}` : `status ${exit.exitCode}`
}

/**
 * Start the server, wait for it to listen, send the requests, and stop it.
 */
export async function runProbe(options: RunProbeOptions): Promise<ProbeResult> {
	const clock = options.clock ?? systemClock
	const logDirectory = options.logDirectory ?? defaultProbeLogDirectory()
	const stem = `${isoSeconds(new Date()).replaceAll(":", "")}-probe-${options.workspace}-${process.pid}`
	const logPath = resolvePath(logDirectory, `${stem}.log`)
	const { command } = options
	const commandList = [command.executable, ...command.args]
	const commandLine = commandList.join(" ")
	const envNames = Object.keys(options.env ?? {})

	await makeDirectories(logDirectory)

	const log = openWriteStream(logPath)

	log.write(
		`# mwops probe ${options.workspace}: ${commandLine}\n# in ${command.cwd}${envNames.length ? ` with ${envNames.join(", ")} set` : ""}\n`
	)

	const startedAt = clock.now()

	const task = new ProcessTask(command.executable, command.args, {
		cwd: command.cwd,
		// `spawn`'s `env` replaces the inherited environment, so the added values extend a copy of it.
		// oxlint-disable-next-line sister-software/no-process-globals -- the server inherits this process's whole environment. No typed helper exposes it.
		env: { ...process.env, ...options.env },
		reject: false,
	})

	const lines: string[] = []
	let startupOutput: string[] | null = null
	let startupMs = 0
	let onListening: (end: StartupEnd) => void = () => {}

	const listened = new Promise<StartupEnd>((resolve) => {
		onListening = resolve
	})

	task.on("line", ({ text }) => {
		lines.push(text)
		log.write(`${text}\n`)

		if (startupOutput) return

		const match = LISTENING_LINE.exec(text)

		if (match) {
			startupMs = clock.now() - startedAt
			startupOutput = lines.slice(0, OUTPUT_LINES)
			onListening({ kind: "listened", port: Number(match[1]), line: text })
		}
	})

	// `exited` never rejects: a command that couldn't start settles with `null`, and `spawnError` holds the spawn error.
	let spawnError: string | null = null

	const exited: Promise<ProcessResult | null> = task.result.catch((error: unknown) => {
		spawnError = error instanceof Error ? error.message : String(error)

		return null
	})

	const waitAbort = new AbortController()
	let startup: StartupEnd = { kind: "expired" }
	const requests: ProbeRequest[] = []
	let memory: ProcessTreeMemory | null = null
	let stop: ProbeStop

	try {
		const interrupted = new Promise<StartupEnd>((resolve) => {
			if (options.interrupt?.aborted) {
				resolve({ kind: "interrupted" })
			}

			options.interrupt?.addEventListener("abort", () => resolve({ kind: "interrupted" }), {
				once: true,
				signal: waitAbort.signal,
			})
		})

		startup = await Promise.race([
			listened,
			exited.then((result): StartupEnd =>
				result ? { kind: "exited", result } : { kind: "failed", error: spawnError ?? "" }
			),
			clock.sleep(options.startupTimeoutMs, waitAbort.signal).then(
				(): StartupEnd => ({ kind: "expired" }),
				// The sleep rejects only when the wait was aborted below, and then another branch already won.
				(): StartupEnd => ({ kind: "expired" })
			),
			interrupted,
		])

		waitAbort.abort()

		if (startup.kind === "listened") {
			for (const path of options.gets) {
				if (options.interrupt?.aborted) break

				const requestStarted = Date.now()
				const url = `http://${PROBE_HOST}:${startup.port}${path}`

				try {
					const result = await httpGet(
						{ url, jsonPath: options.jsonPath, maxBytes: options.maxBytes },
						{ loopbackOnly: true }
					)

					requests.push(toProbeRequest(path, result, Date.now() - requestStarted, options.jsonPath != null))
				} catch (error) {
					// A refusal, such as a redirect off loopback, is a request without a response.
					requests.push({
						path,
						url,
						status: null,
						contentType: null,
						durationMs: Date.now() - requestStarted,
						body: null,
						binary: false,
						bytesRead: 0,
						truncated: false,
						fullLength: null,
						json: null,
						error: { message: error instanceof Error ? error.message : String(error), causeCode: null },
					})
				}
			}

			if (task.child.pid != null) {
				memory = await readProcessTreeMemory(task.child.pid)
			}
		}
	} finally {
		waitAbort.abort()
		stop = await stopServer(task, exited, options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS)

		log.end(
			`# stopped pid ${stop.pid}: ${describeExit(stop)}${stop.forced ? " after SIGKILL" : ""}; remaining ${stop.remaining.join(", ") || "none"}\n`
		)

		await finished(log)
	}

	const interruptedDuringRequests = options.interrupt?.aborted === true && startup.kind === "listened"

	const outcome: ProbeOutcome = interruptedDuringRequests
		? ProbeOutcome.Interrupted
		: startup.kind === "listened"
			? ProbeOutcome.Listened
			: startup.kind === "exited"
				? ProbeOutcome.ExitedBeforeListening
				: startup.kind === "failed"
					? ProbeOutcome.DidNotStart
					: startup.kind === "interrupted"
						? ProbeOutcome.Interrupted
						: ProbeOutcome.StartupExpired

	const unanswered = requests.filter((request) => request.status == null).length

	const { exitCode, summary } = conclude(
		options.workspace,
		outcome,
		startup,
		stop,
		requests.length,
		unanswered,
		options
	)

	return {
		workspace: options.workspace,
		command: commandList,
		commandLine,
		cwd: command.cwd,
		envNames,
		logPath,
		outcome,
		startupTimeoutMs: options.startupTimeoutMs,
		listening:
			startup.kind === "listened"
				? { url: `http://${PROBE_HOST}:${startup.port}`, port: startup.port, line: startup.line, startupMs }
				: null,
		earlyExit:
			startup.kind === "exited"
				? { exitCode: startup.result.exitCode, signal: startup.result.signal, error: null }
				: startup.kind === "failed"
					? { exitCode: null, signal: null, error: startup.error }
					: null,
		startupOutput: startupOutput ?? lines.slice(0, OUTPUT_LINES),
		outputTail: lines.slice(-OUTPUT_LINES),
		requests,
		memory,
		stop,
		exitCode,
		summary,
	}
}

/**
 * The exit status and the one-line summary of a finished probe.
 *
 * A server process that remained after the stop decides the status first, because it still holds memory.
 */
function conclude(
	workspace: string,
	outcome: ProbeOutcome,
	startup: StartupEnd,
	stop: ProbeStop,
	sent: number,
	unanswered: number,
	options: Pick<RunProbeOptions, "startupTimeoutMs" | "gets">
): { exitCode: number; summary: string } {
	const stopped = stop.remaining.length
		? `; process ${stop.remaining.join(", ")} remained after the stop`
		: `; stopped pid ${stop.pid} (${describeExit(stop)}${stop.forced ? ", after SIGKILL" : ""})`

	const statusOf = (exitCode: number): number => (stop.remaining.length ? ProbeExit.StopFailed : exitCode)

	switch (startup.kind) {
		case "exited":
			return {
				exitCode: statusOf(ProbeExit.ExitedBeforeListening),
				summary: `${workspace}: exited with ${describeExit(startup.result)} before listening; no request sent${stopped}`,
			}
		case "failed":
			return {
				exitCode: statusOf(ProbeExit.ExitedBeforeListening),
				summary: `${workspace}: did not start: ${startup.error}`,
			}
		case "expired":
			return {
				exitCode: statusOf(ProbeExit.StartupExpired),
				summary: `${workspace}: no listening line within ${options.startupTimeoutMs / 1000} s; no request sent${stopped}`,
			}
		case "interrupted":
			return {
				exitCode: statusOf(ProbeExit.Interrupted),
				summary: `${workspace}: interrupted before listening${stopped}`,
			}
		case "listened": {
			if (outcome === ProbeOutcome.Interrupted) {
				return {
					exitCode: statusOf(ProbeExit.Interrupted),
					summary: `${workspace}: interrupted after ${sent} of ${options.gets.length} request(s)${stopped}`,
				}
			}

			const answered = `${sent - unanswered} of ${sent} request(s) answered`

			return {
				exitCode: statusOf(unanswered ? ProbeExit.RequestFailed : ProbeExit.Passed),
				summary: `${workspace}: listened on port ${startup.port}; ${answered}${stopped}`,
			}
		}
	}
}
