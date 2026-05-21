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

//#region Constants

/**
 * Labels log levels in the browser console.
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
 * Predefined log levels.
 */
export const LogLevels = Object.keys(LogLevelLabel) as Level[]

type LoggerFactory = (prefix?: string | null, ...args: string[]) => Logger

/**
 * Colors for log levels in the browser console.
 */
const LogLevelColors = {
	info: `light-dark(#0043CE, #4589FF)`,
	warn: `light-dark(#F1C21B, #F1C21B)`,
	error: `light-dark(#DA1E28, #FA4D56)`,
	debug: `light-dark(#8A3FFC, #A56EFF)`,
	trace: `light-dark(#8A3FFC, #A56EFF)`,
	fatal: `light-dark(#DA1E28, #FA4D56)`,
} as const

//#region Functions

/**
 * Creates a logger with the given prefix.
 */
export const createConsoleLogger: LoggerFactory = (prefix, ...args) => {
	const msgPrefix = prefix ? `(${prefix}):` : ":"

	const logger: Partial<Logger> = {
		msgPrefix,
	}

	for (const level of LogLevels) {
		const label = LogLevelLabel[level]

		// @ts-expect-error Alias the log method to the appropriate console method,
		// defaulting to console.log if the level is not supported.
		const method = level in console ? console[level] : console.log

		logger[level] = method.bind(console, `${label} ${msgPrefix}`, ...args)
	}

	return logger as Logger
}

export type BaseConsoleLogger = Record<Level, LogFn>

export type IRuntimeLogger = BaseConsoleLogger

//#endregion

//#region Functions

/**
 * Creates a logger with the given prefix.
 */
export function createLogger(prefix?: string, ...args: string[][]): Logger {
	const msgPrefix = prefix ? `(${prefix}):` : ":"

	/**
	 * @type {Partial<Logger>}
	 */
	const logger: Partial<Logger> = {
		msgPrefix,
	}

	for (const level of LogLevels) {
		const label = LogLevelLabel[level]
		const color = LogLevelColors[level]

		// @ts-expect-error Alias the log method to the appropriate console method,
		// defaulting to console.log if the level is not supported.
		const method = level in console ? console[level] : console.log

		logger[level] = method.bind(
			console,
			`%c${label}%c ${msgPrefix}%c`,
			`font-weight: 700; color: ${color};`,
			`font-weight: 600; color: CanvasText;`,
			"",
			...args
		)
	}

	return logger as Logger
}

/**
 * A singleton logger instance for the browser.
 *
 * ```js
 * import { ConsoleLogger } from "#logger/browser";
 *
 * ConsoleLogger.info("Hello, world!");
 * ```
 *
 * @implements {IRuntimeLogger}
 */
export class ConsoleLogger {
	static info: typeof console.info
	static warn: typeof console.warn
	static error: typeof console.error
	static debug: typeof console.debug
	static trace: typeof console.trace

	/**
	 * Creates a logger with the given prefix.
	 */
	static prefix(logPrefix: string) {
		return createLogger(logPrefix)
	}
}

Object.assign(ConsoleLogger, createLogger())

//#endregion
