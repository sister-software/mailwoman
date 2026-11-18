// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Lints the JavaScript and TypeScript code blocks of the published docs pages with oxlint.
 *
 *   oxlint reads no Markdown, so each block is written to its own file under
 *   {@link EXTRACT_ROOT}, inside the repository.
 *   A file there gets the repository's oxlint config and resolves `mailwoman` imports
 *   through the workspace install, as a reader's project resolves them from npm.
 *
 *   One oxlint call covers every written file.
 *   Each finding is moved back to its page line and column.
 *
 *   A cache in {@link CACHE_FILE} keeps each page's findings.
 *   A page is linted again only when one of these changed: its bytes, the lint setup,
 *   or a workspace its blocks import.
 *
 *   A page whose modification time and size match its entry reuses the entry without a read.
 *   A page whose bytes hash to the entry's hash reuses it too.
 *
 *   That covers a checkout that rewrites a file with the same content.
 *
 *   A fix run applies oxlint's fixes to every block and writes each changed block
 *   back into its page, then lints the rewritten pages.
 */

import { readLocalTextFile, tryReadLocalJSONFile } from "@mailwoman/core/fs/readers"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import {
	makeDirectories,
	removePathIfPresent,
	writeLocalJSONFileAtomically,
	writeLocalTextFile,
} from "@mailwoman/core/fs/writers"
import { git } from "@mailwoman/core/git"
import { sha256Hex } from "@mailwoman/core/hash"
import { parseJSONStrict, prettyJSON } from "@mailwoman/core/json"
import { pathToFileURL } from "@mailwoman/core/module/file-url"
import { resolvePackageCommand } from "@mailwoman/core/module/package-command"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { isProcessError, runFile } from "@mailwoman/core/process"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { dirname, join } from "path-ts"
import { TextSpliterator } from "spliterator"

import { type CodeBlock, extractCodeBlocks, replaceCodeBlocks } from "./blocks.ts"

/**
 * The repo-relative directory the extracted blocks are written to.
 *
 * It sits under the gitignored `.cache/`, outside every `tsconfig.json` that `yarn compile` builds.
 */
const EXTRACT_ROOT = ".cache/code-blocks"

/**
 * The repo-relative cache of each page's findings.
 */
const CACHE_FILE = ".cache/mailwoman/code-blocks.json"

/**
 * The page trees whose code blocks readers copy.
 */
const PAGE_ROOTS = ["docs/articles/", "docs/src/pages/"]

const PAGE_EXTENSION = /\.mdx?$/

/**
 * The files whose content decides what oxlint reports, besides the page itself.
 */
const SETUP_FILE = /^(?:oxlint\.[^/]+\.ts|config\/oxlint\/.+\.ts|lib\/repo-health\/markdown\/.+\.ts)$/

/**
 * The rule code given to a diagnostic oxlint reports without one. oxlint reports a parse error that way.
 */
const PARSE_ERROR_CODE = "oxlint(parse)"

/**
 * A `git ls-tree` entry: mode, type and object ID separated by spaces, then a tab and the path.
 */
const LS_TREE_ENTRY = /^\S+ \S+ (\S+)\t(.+)$/

/**
 * The most oxlint-then-oxfmt passes a fix run makes before it lints what remains.
 */
const MAXIMUM_FIX_PASSES = 3

/**
 * The stdout buffer for oxlint's JSON report, well above its size for every docs block.
 */
const REPORT_BUFFER_BYTES = 64 * 1024 * 1024

/**
 * The compiler settings tsgolint reads for the extracted files.
 *
 * They match a reader's ESM project on Node, with the `node` condition
 * so a workspace resolves to its source.
 */
const EXTRACT_TSCONFIG = {
	compilerOptions: {
		target: "esnext",
		module: "nodenext",
		moduleResolution: "nodenext",
		customConditions: ["node"],
		jsx: "react-jsx",
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		allowJs: true,
		types: ["node"],
	},
	include: ["**/*"],
}

/**
 * An import or dynamic-import specifier written in a block.
 */
const IMPORT_SPECIFIER = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*["']([^"']+)["']/g

/**
 * One oxlint finding, placed on its page.
 */
interface CodeBlockFinding {
	file: string
	line: number
	column: number
	severity: string
	code: string
	message: string
}

interface CacheEntry {
	mtimeMs: number
	size: number
	sha256: string
	blocks: number
	/**
	 * The workspace directories the page's blocks import, so a hit can recheck them without reading the page.
	 */
	workspaces: string[]
	/**
	 * The tree IDs of those workspaces when the page was linted.
	 */
	dependencies: string
	findings: CodeBlockFinding[]
}

interface CacheFile {
	setup: string
	pages: Record<string, CacheEntry>
}

/**
 * What one run read, linted and found.
 */
interface CodeBlockLintResult {
	findings: CodeBlockFinding[]
	pages: number
	blocks: number
	linted: number
	cached: number
	/**
	 * The pages a fix run rewrote.
	 */
	fixed: string[]
	/**
	 * The run's wall-clock time in milliseconds, from the first read to the cache write.
	 */
	elapsedMs: number
	/**
	 * Why the cache was discarded, or `null` when it was read or not requested.
	 */
	cacheNote: string | null
}

interface CodeBlockLintOptions {
	repoRoot: string
	trackedFiles: readonly string[]
	/**
	 * Read and write {@link CACHE_FILE}.
	 */
	cache: boolean
	/**
	 * Apply oxlint's fixes and write the changed blocks back into their pages before linting.
	 */
	fix: boolean
}

interface OxlintDiagnostic {
	message: string
	code?: string
	severity: string
	filename: string
	labels?: Array<{ span: { line: number; column: number } }>
}

interface PageBlocks {
	page: string
	blocks: CodeBlock[]
}

/**
 * The package name of every workspace, mapped to its repo-relative directory.
 */
async function workspacePackages(repoRoot: string): Promise<Map<string, string>> {
	const packages = new Map<string, string>()

	for (const directory of await readWorkspaceDirectories(repoRoot)) {
		const manifest = await readPackageJSON(join(repoRoot, directory, "package.json"))

		if (manifest.name) {
			packages.set(manifest.name, directory)
		}
	}

	return packages
}

/**
 * The package a bare specifier names, such as `@mailwoman/neural` for `@mailwoman/neural/onnx-runner`.
 */
function packageOf(specifier: string): string {
	const parts = specifier.split("/")

	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!
}

/**
 * The workspace directories the blocks import, sorted.
 */
function importedWorkspaces(blocks: readonly CodeBlock[], packages: ReadonlyMap<string, string>): string[] {
	const directories = new Set<string>()

	for (const block of blocks) {
		for (const match of block.text.matchAll(IMPORT_SPECIFIER)) {
			const directory = packages.get(packageOf(match[1] ?? match[2] ?? match[3]!))

			if (directory) {
				directories.add(directory)
			}
		}
	}

	return [...directories].toSorted()
}

/**
 * The committed tree ID of each workspace, and the workspaces with uncommitted changes.
 */
async function workspaceTrees(repoRoot: string): Promise<{ trees: Map<string, string>; dirty: Set<string> }> {
	const trees = new Map<string, string>()

	for (const line of TextSpliterator.from(await git(["ls-tree", "HEAD", "--", "packages/"], repoRoot))) {
		const [, id, path] = LS_TREE_ENTRY.exec(line) ?? []

		if (path && id) {
			trees.set(path, id)
		}
	}

	const dirty = new Set<string>()
	const status = await git(["status", "--porcelain=v1", "--untracked-files=all", "--", "packages/"], repoRoot)

	for (const line of TextSpliterator.from(status, { trim: false })) {
		const [, directory] = /^.. (packages\/[^/]+)\//.exec(line) ?? []

		if (directory) {
			dirty.add(directory)
		}
	}

	return { trees, dirty }
}

/**
 * The dependency stamp of a page, or `null` when a workspace it imports has uncommitted changes.
 */
function dependencyStamp(
	workspaces: readonly string[],
	trees: ReadonlyMap<string, string>,
	dirty: ReadonlySet<string>
): string | null {
	if (workspaces.some((directory) => dirty.has(directory))) return null

	return workspaces.map((directory) => `${directory}:${trees.get(directory) ?? "untracked"}`).join(",")
}

/**
 * A hash of the oxlint and tsgolint versions and of every tracked file that configures the lint.
 */
async function setupStamp(repoRoot: string, trackedFiles: readonly string[]): Promise<string> {
	const base = pathToFileURL(join(repoRoot, "package.json")).href
	const parts: string[] = [prettyJSON(EXTRACT_TSCONFIG)]

	for (const name of ["oxlint", "oxlint-tsgolint"]) {
		parts.push(`${name}@${(await readPackageJSON(base, name)).version}`)
	}

	for (const file of trackedFiles.filter((path) => SETUP_FILE.test(path)).toSorted()) {
		parts.push(file, await readLocalTextFile(join(repoRoot, file)))
	}

	return sha256Hex(parts)
}

async function readCache(
	repoRoot: string,
	setup: string
): Promise<{ pages: Record<string, CacheEntry>; note: string | null }> {
	let cache: CacheFile | null

	try {
		cache = await tryReadLocalJSONFile<CacheFile>(join(repoRoot, CACHE_FILE))
	} catch (error) {
		return { pages: {}, note: `${CACHE_FILE} is unreadable (${String(error)}), so every page is linted` }
	}

	if (!cache) return { pages: {}, note: null }

	if (cache.setup !== setup) return { pages: {}, note: "the lint setup changed, so every page is linted" }

	return { pages: cache.pages, note: null }
}

/**
 * Writes every block of `pages` under {@link EXTRACT_ROOT}, replacing what an earlier
 * run wrote, and returns each written file's page and block.
 */
async function writeExtraction(
	repoRoot: string,
	pages: readonly PageBlocks[]
): Promise<Map<string, { page: string; block: CodeBlock }>> {
	await removePathIfPresent(join(repoRoot, EXTRACT_ROOT))
	await makeDirectories(join(repoRoot, EXTRACT_ROOT))
	await writeLocalTextFile(prettyJSON(EXTRACT_TSCONFIG), join(repoRoot, EXTRACT_ROOT, "tsconfig.json"))

	const byFile = new Map<string, { page: string; block: CodeBlock }>()

	for (const { page, blocks } of pages) {
		for (const block of blocks) {
			const path = `${EXTRACT_ROOT}/${page}/${block.index}.${block.extension}`

			await makeDirectories(join(repoRoot, dirname(path)))
			await writeLocalTextFile(block.text, join(repoRoot, path))
			byFile.set(path, { page, block })
		}
	}

	return byFile
}

/**
 * Runs oxlint over the extracted files and returns its diagnostics.
 *
 * oxlint exits 1 when it reports a finding, so a JSON report on stdout decides whether the run completed.
 *
 * @throws When oxlint prints no JSON report, with its output attached.
 */
async function runOxlint(repoRoot: string, files: readonly string[], fix: boolean): Promise<OxlintDiagnostic[]> {
	const command = await resolvePackageCommand(pathToFileURL(join(repoRoot, "package.json")).href, "oxlint", "oxlint")
	const args = [...command.argv, "--no-ignore", "--format=json", ...(fix ? ["--fix"] : []), ...files]
	let output: { stdout: string; stderr: string }

	try {
		output = await runFile(command.file, args, { cwd: repoRoot, maxBuffer: REPORT_BUFFER_BYTES })
	} catch (error) {
		if (!isProcessError(error)) throw error

		output = error
	}

	try {
		return parseJSONStrict<{ diagnostics: OxlintDiagnostic[] }>(output.stdout).diagnostics
	} catch {
		throw new Error(
			`oxlint printed no JSON report for ${files.length} extracted block(s):\n${output.stdout}\n${output.stderr}`
		)
	}
}

/**
 * Applies oxlint's fixes to every block of `pages` and writes each changed block back into its page.
 *
 * @returns The pages that changed.
 */
async function fixPages(repoRoot: string, pages: readonly PageBlocks[]): Promise<string[]> {
	const byFile = await writeExtraction(repoRoot, pages)

	await runOxlint(repoRoot, [...byFile.keys()], true)

	const replacements = new Map<string, Map<number, string>>()

	for (const [path, { page, block }] of byFile) {
		const text = await readLocalTextFile(join(repoRoot, path))

		if (text === block.text) continue

		const pageReplacements = replacements.get(page) ?? new Map<number, string>()

		pageReplacements.set(block.index, text)
		replacements.set(page, pageReplacements)
	}

	for (const [page, pageReplacements] of replacements) {
		const source = await readLocalTextFile(join(repoRoot, page))

		await writeLocalTextFile(replaceCodeBlocks(source, pageReplacements), join(repoRoot, page))
	}

	const changed = [...replacements.keys()].toSorted()

	// oxlint's fixes leave layout to the formatter, as a brace fix writes `{ call() }` on one
	// line. oxfmt formats the code inside a page's fences, so it runs over each rewritten page.
	if (changed.length) {
		const command = await resolvePackageCommand(pathToFileURL(join(repoRoot, "package.json")).href, "oxfmt", "oxfmt")

		await runFile(command.file, [...command.argv, "--write", ...changed], { cwd: repoRoot })
	}

	return changed
}

/**
 * Lints the blocks of `pages` and returns each page's findings, placed on its lines.
 */
async function lintPages(repoRoot: string, pages: readonly PageBlocks[]): Promise<Map<string, CodeBlockFinding[]>> {
	const byFile = await writeExtraction(repoRoot, pages)
	const pageFindings = new Map<string, CodeBlockFinding[]>(pages.map(({ page }) => [page, []]))

	for (const diagnostic of await runOxlint(repoRoot, [...byFile.keys()], false)) {
		const source = byFile.get(diagnostic.filename)

		if (!source) {
			throw new Error(`oxlint reported ${diagnostic.filename}, which no extracted block was written to`)
		}

		const span = diagnostic.labels?.[0]?.span

		pageFindings.get(source.page)!.push({
			file: source.page,
			line: source.block.firstLine + (span ? span.line - 1 : 0),
			column: (span?.column ?? 1) + source.block.indent.length,
			severity: diagnostic.severity,
			code: diagnostic.code ?? PARSE_ERROR_CODE,
			message: diagnostic.message,
		})
	}

	for (const [page, findings] of pageFindings) {
		pageFindings.set(
			page,
			findings.toSorted((a, b) => a.line - b.line || a.column - b.column)
		)
	}

	return pageFindings
}

/**
 * Lints every code block of the published docs pages, reusing cached findings where the cache allows.
 */
export async function lintCodeBlocks(options: CodeBlockLintOptions): Promise<CodeBlockLintResult> {
	const started = performance.now()
	const { repoRoot, trackedFiles } = options

	const pagePaths = trackedFiles.filter(
		(path) => PAGE_EXTENSION.test(path) && PAGE_ROOTS.some((root) => path.startsWith(root))
	)

	const fixed = new Set<string>()

	// A pass can leave work for the next one: oxfmt expands a brace fix into a multi-line statement.
	// A padding rule then reports that statement.
	// The passes stop when one changes no page.
	for (let pass = 0; options.fix && pass < MAXIMUM_FIX_PASSES; pass++) {
		const pages: PageBlocks[] = []

		for (const page of pagePaths) {
			const blocks = extractCodeBlocks(await readLocalTextFile(join(repoRoot, page)))

			if (blocks.length) {
				pages.push({ page, blocks })
			}
		}

		const changed = await fixPages(repoRoot, pages)

		if (!changed.length) break

		for (const page of changed) {
			fixed.add(page)
		}
	}

	const setup = await setupStamp(repoRoot, trackedFiles)
	const { pages: cached, note } = options.cache ? await readCache(repoRoot, setup) : { pages: {}, note: null }
	const { trees, dirty } = await workspaceTrees(repoRoot)
	const packages = await workspacePackages(repoRoot)
	const nextCache: Record<string, CacheEntry> = {}
	const findings: CodeBlockFinding[] = []
	const toLint: Array<PageBlocks & { entry: Omit<CacheEntry, "findings"> | null }> = []
	let blockCount = 0
	let cachedCount = 0

	for (const page of pagePaths) {
		const stats = await tryStat(join(repoRoot, page))

		if (!stats) continue

		const previous = cached[page]

		if (previous && previous.mtimeMs === stats.mtimeMs && previous.size === stats.size) {
			const stamp = dependencyStamp(previous.workspaces, trees, dirty)

			if (stamp !== null && stamp === previous.dependencies) {
				nextCache[page] = previous
				findings.push(...previous.findings)
				blockCount += previous.blocks

				cachedCount++

				continue
			}
		}

		const source = await readLocalTextFile(join(repoRoot, page))
		const sha256 = sha256Hex(source)
		const blocks = extractCodeBlocks(source)
		const workspaces = importedWorkspaces(blocks, packages)
		const stamp = dependencyStamp(workspaces, trees, dirty)

		blockCount += blocks.length

		if (previous && stamp !== null && previous.sha256 === sha256 && previous.dependencies === stamp) {
			nextCache[page] = { ...previous, mtimeMs: stats.mtimeMs, size: stats.size }
			findings.push(...previous.findings)

			cachedCount++

			continue
		}

		const entry =
			stamp === null
				? null
				: { mtimeMs: stats.mtimeMs, size: stats.size, sha256, blocks: blocks.length, workspaces, dependencies: stamp }

		if (!blocks.length) {
			if (entry) {
				nextCache[page] = { ...entry, findings: [] }
			}

			continue
		}

		toLint.push({ page, blocks, entry })
	}

	if (toLint.length) {
		const pageFindings = await lintPages(repoRoot, toLint)

		for (const { page, entry } of toLint) {
			const pageResult = pageFindings.get(page) ?? []

			findings.push(...pageResult)

			if (entry) {
				nextCache[page] = { ...entry, findings: pageResult }
			}
		}
	}

	if (options.cache) {
		await makeDirectories(join(repoRoot, dirname(CACHE_FILE)))
		await writeLocalJSONFileAtomically({ setup, pages: nextCache } satisfies CacheFile, join(repoRoot, CACHE_FILE))
	}

	return {
		findings: findings.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column),
		pages: pagePaths.length,
		blocks: blockCount,
		linted: toLint.length,
		cached: cachedCount,
		fixed: [...fixed].toSorted(),
		elapsedMs: Math.round(performance.now() - started),
		cacheNote: note,
	}
}
