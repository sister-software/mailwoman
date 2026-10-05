#!/usr/bin/env node

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Vale prose linting entry point.
 */

/// <reference types="node" />

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { workingTreeFiles } from "@mailwoman/core/git"
import { repoRootPathBuilder } from "@mailwoman/core/paths"
import { isProcessError, type ProcessOutput, runFile } from "@mailwoman/core/process"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { runCLICommand } from "@mailwoman/core/scripting/command"
import { availableParallelism } from "@mailwoman/core/utils/system"
import { type ValeCommand, valeCommand } from "@mailwoman/core/vale"
import { chunks } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import { writePythonDocstringProjections } from "#config/vale/python-docstrings"
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
 * The directories whose documents a git file listing can miss.
 *
 * `workingTreeFiles` runs `git ls-files --cached --others --exclude-standard`,
 * so a path any ignore rule covers drops out.
 * `scratchpad/` is covered by `.git/info/exclude` in some clones and by no rule in others,
 * because that file is per-clone and uncommitted.
 *
 * A listing built from git alone therefore lints these documents in one checkout and skips
 * them in the next, which is why a findings document written there could not be linted at all.
 *
 * Enumerating them from the filesystem gives every clone the same surface.
 */
const DOCS_DIRECTORIES_OUTSIDE_GIT: readonly string[] = ["scratchpad"]

/**
 * Markdown under {@link DOCS_DIRECTORIES_OUTSIDE_GIT}, as repository-relative paths.
 *
 * A directory that does not exist contributes no path, because a clone without a scratchpad is ordinary.
 */
async function documentsOutsideGit(): Promise<string[]> {
	const found: string[] = []

	for (const directory of DOCS_DIRECTORIES_OUTSIDE_GIT) {
		const root = repoRootPathBuilder(directory)

		if (!(await pathExists(root))) continue

		for await (const entry of Globerator.from("**/*.{md,mdx}", { cwd: root, absolute: false })) {
			found.push(`${directory}/${entry.toString()}`)
		}
	}

	return found
}

/**
 * Whether a run that names no path reads {@link DOCS_DIRECTORIES_OUTSIDE_GIT}.
 *
 * A run naming a path reads it, so `lint-prose.ts -s docs scratchpad/<date>/<file>.md` lints that document.
 * A run naming none skips those directories.
 *
 * The reason is the size of the existing set rather than a judgment that the prose there matters less.
 * Measured on 2026-09-29: 62 of 68 scratchpad documents carry 667 errors between
 * them, dominated by `styles.Negation` at 173 and `styles.Nothing` at 135,
 * while the tracked docs surface carries 0 errors.
 *
 * Chaining that set into `yarn lint` would refuse every push until all 62 are rewritten.
 * A clone-specific exemption list cannot express the boundary either,
 * because each clone holds different scratch files.
 */
const UNNARROWED_RUN_READS_DIRECTORIES_OUTSIDE_GIT = false

/**
 * The file list split into one slice per core for concurrent Vale processes.
 *
 * Vale reads an explicit file list on a single core.
 * Each core processes its own slice, and the full run takes a few seconds.
 */
function chunkFiles(files: readonly string[], chunkCount: number): string[][] {
	return Array.from(chunks(files, Math.max(1, Math.ceil(files.length / chunkCount))))
}

interface ValeCheck {
	configPath: string
	files: string[]
	displayPathPrefix?: string
}

interface ValeRun extends ProcessOutput {
	exitCode: number
}

async function runVale(
	vale: ValeCommand,
	configPath: string,
	files: readonly string[],
	displayPathPrefix?: string
): Promise<ValeRun> {
	function display(value: string): string {
		return displayPathPrefix ? value.replaceAll(`${displayPathPrefix}/`, "") : value
	}

	try {
		const result = await runFile(vale.file, [...vale.argv, "--config", configPath, ...files], {
			cwd: repoRootPathBuilder,
			maxBuffer: 50 * 1024 * 1024,
		})

		return { ...result, stdout: display(result.stdout), stderr: display(result.stderr), exitCode: 0 }
	} catch (error: unknown) {
		if (!isProcessError(error)) throw error

		return {
			stdout: display(error.stdout),
			stderr: display(error.stderr),
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
function splitSummary(stdout: string): { body: string; counts: [number, number, number, number] } {
	const match = SUMMARY_LINE.exec(stdout)

	if (!match) return { body: stdout, counts: [0, 0, 0, 0] }

	return {
		body: stdout.slice(0, match.index) + stdout.slice(match.index + match[0].length),
		counts: [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])],
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

	const runs = checks.map(({ configPath, files, displayPathPrefix }) => {
		console.log(`Running Vale check with config: ${configPath}`)

		return Promise.all(
			chunkFiles(files, parallelism).map((chunk) => runVale(vale, configPath, chunk, displayPathPrefix))
		)
	})

	let exitCode = 0

	for (const results of await Promise.all(runs)) {
		const totals: [number, number, number, number] = [0, 0, 0, 0]

		for (const { stdout, stderr, exitCode: code } of results) {
			const { body, counts } = splitSummary(stdout)

			process.stdout.write(body)
			process.stderr.write(stderr)

			totals[0] += counts[0]
			totals[1] += counts[1]
			totals[2] += counts[2]
			totals[3] += counts[3]
			exitCode = Math.max(exitCode, code)
		}

		const [errors, warnings, suggestions, files] = totals
		const mark = errors || warnings ? "✖" : "✔"

		console.log(`${mark} ${errors} errors, ${warnings} warnings and ${suggestions} suggestions in ${files} files.`)
	}

	return exitCode
}

async function stagedPaths(): Promise<string[]> {
	const result = await runFile("git", ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"], {
		cwd: repoRootPathBuilder,
	})

	return result.stdout.split("\0").filter((path) => path.length > 0)
}

async function lint(surface: Surface, narrowing: readonly string[], staged: boolean) {
	const resolvedPathSpecs = await pathspecsFor(surface)
	const tracked = await workingTreeFiles(resolvedPathSpecs)

	const readsOutsideGit =
		surface !== "code" && ((narrowing.length > 0 && !staged) || UNNARROWED_RUN_READS_DIRECTORIES_OUTSIDE_GIT)

	// A clone whose ignore rules do not cover these directories lists them twice,
	// so the union is taken by key rather than by concatenation.
	const listedFiles = [...new Set(readsOutsideGit ? [...tracked, ...(await documentsOutsideGit())] : tracked)]

	const existence = await Promise.all(
		listedFiles.map(async (file) => ((await pathExists(repoRootPathBuilder(...file.split("/")))) ? file : null))
	)

	const surfaceFiles = existence.filter((file): file is string => file !== null)

	if (!surfaceFiles.length) {
		throw new Error(`No files in the working tree matched the ${surface} Vale surface`)
	}

	const filteredSurfaceFiles = narrowTo(surfaceFiles, narrowing)

	if (staged && !filteredSurfaceFiles.length) return 0

	if (narrowing.length && !staged) {
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

		const pythonFiles = sourceFiles.filter((file) => file.endsWith(".py"))

		if (pythonFiles.length) {
			await using scratch = await temporaryDirectory("vale-python-docstrings-")
			const projections = await writePythonDocstringProjections(pythonFiles, repoRootPathBuilder, scratch.path)

			if (projections.files.length) {
				checks.push({
					configPath: repoRootPathBuilder("config", "vale", ".vale-python-docstrings.ini").toString(),
					files: projections.files,
					displayPathPrefix: projections.displayPathPrefix,
				})
			}

			return await runChecks(vale, checks)
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
			staged: { type: "boolean" },
		},
		allowPositionals: true,
	})

	if (!options.surface?.length) {
		console.error("No surface specified")

		return 1
	}

	if (options.staged && narrowing.length) {
		throw new Error("--staged reads the Git index and cannot be combined with path arguments")
	}

	const selectedPaths = options.staged ? await stagedPaths() : narrowing

	if (options.staged && !selectedPaths.length) return 0

	const surfaces: Surface[] = []

	for (const surface of options.surface) {
		assertSurfaceArg(surface)
		surfaces.push(surface)
	}

	let exitCode = 0

	for (const surface of surfaces) {
		exitCode = await lint(surface, selectedPaths, options.staged === true)

		if (exitCode !== 0) {
			return exitCode
		}
	}

	return exitCode
}

process.exitCode = await runCLICommand(main)
