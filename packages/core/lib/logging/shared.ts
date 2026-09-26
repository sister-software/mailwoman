/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { BaseLogger as PinoBaseLogger, Level as PinoLevel, LogFn as PinoLogFn, Logger as PinoLogger } from "pino"

export type Logger = PinoLogger

export type Level = PinoLevel

export type LogFn = PinoLogFn

export type BaseLogger = Pick<PinoBaseLogger, Exclude<Level, "fatal">>

// #region Constants

/**
 * Labels log levels in the browser console, keyed by level.
 */
export const LogLevelLabel = {
	info: "[INFO]",
	warn: "[WARN]",
	error: "[ERROR]",
	debug: "[DEBUG]",
	trace: "[TRACE]",
	fatal: "[FATAL]",
} as const satisfies Record<Level, string>

/**
 * The log levels, derived from `LogLevelLabel`.
 */
export const LogLevels = Object.keys(LogLevelLabel) as Level[]

type LoggerFactory = (prefix?: string | null, ...args: string[]) => Logger

const LogLevelColors = {
	info: `light-dark(#0043CE, #4589FF)`,
	warn: `light-dark(#F1C21B, #F1C21B)`,
	error: `light-dark(#DA1E28, #FA4D56)`,
	debug: `light-dark(#8A3FFC, #A56EFF)`,
	trace: `light-dark(#8A3FFC, #A56EFF)`,
	fatal: `light-dark(#DA1E28, #FA4D56)`,
} as const

// #region Functions

/**
 * Where diagnostics are written: under Node, a `Console` whose streams are both stderr,
 * because `console.debug`, `console.info` and `console.log` write to stdout there and would
 * land in the middle of any command whose stdout is data, and in a browser the one console.
 */
function diagnosticsSink(): Console {
	// oxlint-disable-next-line sister-software/no-process-globals -- the stream object itself rather than configuration. a browser has no `process` and falls through
	const stderr = globalThis.process?.stderr

	const ConsoleConstructor = (
		globalThis.console as {
			Console?: new (options: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }) => Console
		}
	).Console

	return stderr && ConsoleConstructor ? new ConsoleConstructor({ stdout: stderr, stderr }) : console
}

const sink = diagnosticsSink()

export const createConsoleLogger: LoggerFactory = (prefix, ...args) => {
	const msgPrefix = prefix ? `(${prefix}):` : ":"

	const logger: Partial<Logger> = {
		msgPrefix,
	}

	for (const level of LogLevels) {
		const label = LogLevelLabel[level]

		// @ts-expect-error Alias the log method to the appropriate console method,
		// defaulting to console.log if the level is not supported.
		const method = level in sink ? sink[level] : sink.log

		logger[level] = method.bind(sink, `${label} ${msgPrefix}`, ...args)
	}

	return logger as Logger
}

export type BaseConsoleLogger = Record<Level, LogFn>

export type IRuntimeLogger = BaseConsoleLogger

/**
 * A logger that writes no output at every level, for a client whose caller owns stdout, such as a
 * command emitting JSON, where a "[debug] GET …" line on the same stream corrupts the document.
 */
export function silentLogger(): BaseConsoleLogger {
	const logger: Partial<BaseConsoleLogger> = {}

	for (const level of LogLevels) {
		logger[level] = () => {}
	}

	return logger as BaseConsoleLogger
}

// #endregion

// #region Functions

export function createLogger(prefix?: string, ...args: string[][]): Logger {
	const msgPrefix = prefix ? `(${prefix}):` : ":"

	const logger: Partial<Logger> = {
		msgPrefix,
	}

	for (const level of LogLevels) {
		const label = LogLevelLabel[level]
		const color = LogLevelColors[level]

		// @ts-expect-error Alias the log method to the appropriate console method,
		// defaulting to console.log if the level is not supported.
		const method = level in sink ? sink[level] : sink.log

		logger[level] = method.bind(
			sink,
			`%c${label}%c ${msgPrefix}%c`,
			`font-weight: 700; color: ${color};`,
			`font-weight: 600; color: CanvasText;`,
			"",
			...args
		)
	}

	return logger as Logger
}

// oxlint-disable-next-line unicorn/no-static-only-class -- a static façade whose members are bound to console's own methods
export class ConsoleLogger {
	static info: typeof console.info
	static warn: typeof console.warn
	static error: typeof console.error
	static debug: typeof console.debug
	static trace: typeof console.trace

	static prefix(...logPrefixes: string[]) {
		return createLogger(logPrefixes.join(":"))
	}
}

Object.assign(ConsoleLogger, createLogger())

// #endregion
