// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Runs one registered check in a checkout and reports what it did.
 *
 * The command runs without a shell.
 * Its whole output goes to a log file outside the checkout.
 *
 * The result records the log path, the exit status, the parsed fields and the tree the check ran on.
 *
 * A Vitest check also writes Vitest's JSON report beside the log, and the result is read from that report.
 */

import { cacheRootPath } from "@mailwoman/core/data-root"
import { tryReadLocalJSONFile } from "@mailwoman/core/fs/readers"
import { openWriteStream, finished } from "@mailwoman/core/fs/streams"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { gitHead } from "@mailwoman/core/git"
import { ProcessTask } from "@mailwoman/core/process"
import { isoSeconds } from "@mailwoman/core/utils"
import { resolvePath } from "path-ts"

import type { ParsedCheckOutput } from "#check-kit/parsed"
import { parseVitestReport, parseVitestText } from "#check-kit/parsers/vitest"
import { type CheckCommand, CheckReader } from "#check-kit/registry"
import { computeTreeFingerprint } from "#dev-mcp/tree-fingerprint"

/**
 * The directory a check's log goes to when no `--log-dir` is given.
 *
 * The cache root sits outside every checkout, so a log never appears as an untracked file.
 */
function defaultCheckLogDirectory(): string {
	return cacheRootPath("checks")
}

/**
 * What the tree looked like when the check started.
 */
type CheckTree =
	| { digest: string; dirtyFiles: string[]; filesWalked: number; error?: never }
	| { digest?: never; dirtyFiles?: never; filesWalked?: never; error: string }

/**
 * One check's run.
 */
export interface CheckRun {
	check: string
	command: string[]
	commandLine: string
	checkout: string
	gitHead: string | null
	tree: CheckTree
	startedAt: string
	endedAt: string
	durationMs: number
	/**
	 * The command's exit status, or `null` when a signal ended it.
	 */
	exitCode: number | null
	signal: string | null
	logPath: string
	/**
	 * Vitest's JSON report, for a Vitest check.
	 */
	reportPath: string | null
	parsed: ParsedCheckOutput
}

/**
 * Options for {@link runCheck}.
 */
export interface RunCheckOptions {
	checkout: string
	paths?: readonly string[]
	logDirectory?: string
	/**
	 * The executable that runs a check's `yarn` arguments, replaced by a test.
	 */
	executable?: string
	/**
	 * The arguments that replace the check's own, for a test.
	 */
	argsOverride?: readonly string[]
	now?: () => Date
}

async function readTree(checkout: string): Promise<CheckTree> {
	try {
		const fingerprint = await computeTreeFingerprint(checkout)

		return {
			digest: fingerprint.digest,
			dirtyFiles: fingerprint.dirtyFiles,
			filesWalked: fingerprint.filesWalked,
		}
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) }
	}
}

/**
 * Run one check to completion and parse its output.
 */
export async function runCheck(check: CheckCommand, options: RunCheckOptions): Promise<CheckRun> {
	const now = options.now ?? (() => new Date())
	const started = now()
	const logDirectory = options.logDirectory ?? defaultCheckLogDirectory()
	const stem = `${isoSeconds(started).replaceAll(":", "")}-${check.name}-${process.pid}`
	const logPath = resolvePath(logDirectory, `${stem}.log`)
	const reportPath = check.reader === CheckReader.Vitest ? resolvePath(logDirectory, `${stem}.vitest.json`) : null

	const args = [
		...(options.argsOverride ?? check.args),
		...(reportPath ? ["--reporter=default", "--reporter=json", `--outputFile.json=${reportPath}`] : []),
		...(check.takesPaths ? (options.paths ?? []) : []),
	]

	const executable = options.executable ?? "yarn"
	const command = [executable, ...args]
	const commandLine = command.join(" ")

	const [head, tree] = await Promise.all([gitHead(options.checkout).catch(() => null), readTree(options.checkout)])

	await makeDirectories(logDirectory)

	const log = openWriteStream(logPath)

	log.write(`# mwops check ${check.name}: ${commandLine}\n# in ${options.checkout} at ${head ?? "an unread HEAD"}\n`)

	const task = new ProcessTask(executable, args, { cwd: options.checkout, reject: false })

	// The parsers read both streams in the order the lines arrived, as the log holds them.
	const lines: string[] = []

	task.on("line", ({ text }) => {
		lines.push(text)
		log.write(`${text}\n`)
	})

	let exitCode: number | null
	let signal: string | null = null
	let output: string

	try {
		const result = await task.result

		exitCode = result.exitCode
		signal = result.signal
		output = lines.join("\n")
	} catch (error) {
		// The command never started, such as when the executable is absent.
		const message = error instanceof Error ? error.message : String(error)

		log.write(`# the command did not start: ${message}\n`)
		output = message
		exitCode = 127
	}

	const ended = now()

	log.end(`# exit ${exitCode ?? `signal ${signal}`}\n`)
	await finished(log)

	return {
		check: check.name,
		command,
		commandLine,
		checkout: options.checkout,
		gitHead: head,
		tree,
		startedAt: started.toISOString(),
		endedAt: ended.toISOString(),
		durationMs: ended.getTime() - started.getTime(),
		exitCode,
		signal,
		logPath,
		reportPath,
		parsed: await parseCheckOutput(check, output, exitCode, reportPath, options.checkout),
	}
}

async function parseCheckOutput(
	check: CheckCommand,
	output: string,
	exitCode: number | null,
	reportPath: string | null,
	checkout: string
): Promise<ParsedCheckOutput> {
	if (check.reader === CheckReader.Script) {
		if (!check.parse) throw new TypeError(`The script check ${check.name} declares no parser.`)

		return check.parse(output, exitCode)
	}

	const report = reportPath ? await tryReadLocalJSONFile<unknown>(reportPath).catch(() => null) : null

	if (report) return parseVitestReport(report, checkout)

	// Vitest writes the report at the end of a run, so a run that crashed or was killed has none.
	const text = parseVitestText(output)

	return text.parsed
		? text
		: { ...text, reason: `Vitest wrote no JSON report at ${reportPath}, and ${text.reason ?? "its text was unread"}` }
}
