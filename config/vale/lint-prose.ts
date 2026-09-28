#!/usr/bin/env node

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Vale prose linting entry point.
 */

/// <reference types="node" />

import { workingTreeFiles } from "@mailwoman/core/git"
import { repoRootPathBuilder } from "@mailwoman/core/paths"
import { isProcessError, type ProcessOutput, runFile } from "@mailwoman/core/process"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { runCLICommand } from "@mailwoman/core/scripting/command"
import { availableParallelism } from "@mailwoman/core/utils/system"
import { type ValeCommand, valeCommand } from "@mailwoman/core/vale"
import { chunks } from "spliterator"

import {
	narrowTo,
	loadValeIgnore,
	assertSurfaceArg,
	configFor,
	type Surface,
	describeUnmatched,
} from "#config/vale/shared"

async function pathspecsFor(value: Surface): Promise<string[]> {
	const ignoreFileName = value === "code" ? "code" : "docs"
	const ignorePatterns = await loadValeIgnore(repoRootPathBuilder("config", "vale", `${ignoreFileName}.valeignore`))

	const filePatterns = value === "code" ? ["*.ts", "*.tsx", "*.py", "*.yaml", "*.yml"] : ["*.md", "*.mdx"]

	return [...filePatterns, ...ignorePatterns]
}

/**
 * The file list split into one slice per core for concurrent Vale processes.
 *
 * Vale reads an explicit file list on a single core.
 * Handing each core its own slice brings the same work down to a few seconds.
 */
function chunkFiles(files: readonly string[], chunkCount: number): string[][] {
	return Array.from(chunks(files, Math.max(1, Math.ceil(files.length / chunkCount))))
}

interface ValeCheck {
	configPath: string
	files: string[]
}

interface ValeRun extends ProcessOutput {
	exitCode: number
}

async function runVale(vale: ValeCommand, configPath: string, files: readonly string[]): Promise<ValeRun> {
	try {
		const result = await runFile(vale.file, [...vale.argv, "--config", configPath, ...files], {
			cwd: repoRootPathBuilder,
			maxBuffer: 50 * 1024 * 1024,
		})

		return { ...result, exitCode: 0 }
	} catch (error: unknown) {
		if (!isProcessError(error)) throw error

		return {
			stdout: error.stdout,
			stderr: error.stderr,
			exitCode: typeof error.code === "number" ? error.code : 1,
		}
	}
}

/**
 * The closing line Vale prints per process.
 * A chunked run would otherwise repeat it once per slice.
 */
const SUMMARY_LINE = /^[✔✖] (\d+) errors?, (\d+) warnings? and (\d+) suggestions? in (\d+) files?\.\n?$/mu

/**
 * A chunk's output with Vale's closing summary line removed and its counts returned.
 */
function splitSummary(stdout: string): { body: string; counts: number[] } {
	const match = SUMMARY_LINE.exec(stdout)

	if (!match) return { body: stdout, counts: [0, 0, 0, 0] }

	return {
		body: stdout.slice(0, match.index) + stdout.slice(match.index + match[0].length),
		counts: match.slice(1).map(Number),
	}
}

/**
 * Every check's chunks run at once.
 *
 * Output is written in chunk order after all have finished.
 * A file's findings stay together.
 *
 * Two checks never interleave.
 * Each check closes with one summary that sums its chunks.
 */
async function runChecks(vale: ValeCommand, checks: readonly ValeCheck[]): Promise<number> {
	const parallelism = availableParallelism()

	const runs = checks.map(({ configPath, files }) => {
		console.log(`Running Vale check with config: ${configPath}`)

		return Promise.all(chunkFiles(files, parallelism).map((chunk) => runVale(vale, configPath, chunk)))
	})

	let exitCode = 0

	for (const results of await Promise.all(runs)) {
		const totals = [0, 0, 0, 0]

		for (const { stdout, stderr, exitCode: code } of results) {
			const { body, counts } = splitSummary(stdout)

			process.stdout.write(body)
			process.stderr.write(stderr)

			counts.forEach((count, index) => (totals[index] += count))
			exitCode = Math.max(exitCode, code)
		}

		const [errors, warnings, suggestions, files] = totals
		const mark = errors || warnings ? "✖" : "✔"

		console.log(`${mark} ${errors} errors, ${warnings} warnings and ${suggestions} suggestions in ${files} files.`)
	}

	return exitCode
}

async function lint(surface: Surface, narrowing: readonly string[]) {
	const resolvedPathSpecs = await pathspecsFor(surface)
	const surfaceFiles = await workingTreeFiles(resolvedPathSpecs)

	if (!surfaceFiles.length) {
		throw new Error(`No files in the working tree matched the ${surface} Vale surface`)
	}

	const filteredSurfaceFiles = narrowTo(surfaceFiles, narrowing)

	if (narrowing.length) {
		const unmatched = await describeUnmatched(narrowing, filteredSurfaceFiles, surface)

		if (unmatched.length) {
			throw new Error(
				`${unmatched.length} of ${narrowing.length} paths reached no file in the ${surface} ` +
					`surface, so Vale did not read them:\n  ${unmatched.join("\n  ")}`
			)
		}
	}

	const vale = await valeCommand(import.meta.url)
	const checks: ValeCheck[] = [{ configPath: configFor(surface).toString(), files: filteredSurfaceFiles }]

	if (surface === "code") {
		const sourceFiles = filteredSurfaceFiles.filter((file) => /\.(?:ts|tsx|py)$/u.test(file))

		if (sourceFiles.length) {
			checks.push({ configPath: configFor("code-terms").toString(), files: sourceFiles })
		}
	}

	return runChecks(vale, checks)
}

async function main(): Promise<number> {
	const {
		values: options,
		// Narrow paths to the selected surface so callers get the same exclusions as CI.
		positionals: narrowing,
	} = parseArguments({
		options: {
			surface: {
				type: "string",
				short: "s",
				multiple: true,
			},
		},
		allowPositionals: true,
	})

	if (!options.surface?.length) {
		console.error("No surface specified")

		return 1
	}

	const surfaces: Surface[] = []

	for (const surface of options.surface) {
		assertSurfaceArg(surface)
		surfaces.push(surface)
	}

	let exitCode = 0

	for (const surface of surfaces) {
		exitCode = await lint(surface, narrowing)

		if (exitCode !== 0) {
			return exitCode
		}
	}

	return exitCode
}

process.exitCode = await runCLICommand(main)
