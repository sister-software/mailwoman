// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Finds an exported declaration whose only importers are tests.
 *
 *   Knip counts a test's import as a use, so it reports no export whose one importer is that export's own test.
 *   This check builds the import graph of every tracked module.
 *   It resolves each specifier with TypeScript through `createMoveResolver` and follows re-exports to the module
 *   that declares the name.
 *
 *   An export is used when a module that's not a test imports it.
 *   The import may be static, a dynamic `import()`, an `import("x").Name` type, or a re-export chain through a
 *   barrel, a `#` import or another workspace's `exports` subpath.
 *   An export is also used when its module is an entry the runtime loads by path: a knip `entry` pattern, a
 *   `*.run.ts` tool, or a command module under `cli/commands/`.
 *
 *   Public interface follows the conventions knip already reads.
 *   An export tagged `@public` is never reported.
 *   An export reachable from a published workspace's explicit `exports` subpath (`.`, `./env`, …) is reported
 *   separately as public, because a user outside the repository may be its caller.
 *   The `./*` pattern every workspace declares doesn't make a module public, as it doesn't for knip.
 *
 *   The `debt` check pins the count of internal findings, so it ratchets down.
 *   This check lists each site.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { isPresent } from "@mailwoman/core/objects"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { relative, resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck, type RepoContext } from "#repo-health/check"
import { EVERY_EXPORT, type ModuleFacts, moduleFacts } from "#repo-health/checks/exports/module-facts"
import { parseContextSource, readContextSources } from "#repo-health/context"
import { createMoveResolver, type MoveResolver } from "#repo-health/move/resolution"
import { PACKAGE_SOURCE_PATH, trackedSourcePaths } from "#repo-health/tracked-sources"

/**
 * Every tracked module that can import another, as `git ls-files` pathspecs.
 */
const IMPORTER_GLOBS = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.mjs", "*.jsx"]

/**
 * Generated or vendored trees whose imports describe no source of ours.
 */
const IMPORTER_EXCLUDED_PREFIXES = ["docs/build/", "docs/.docusaurus/", "packages/sentencepiece-wasm/"]

/**
 * A Vitest or Playwright file.
 */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u

/**
 * A path segment, or a module's basename, that marks shared test support: fixtures, helpers and suites.
 */
const TEST_SEGMENTS: ReadonlySet<string> = new Set(["test", "tests", "__tests__", "test-kit", "test-fixtures"])

/**
 * A module the runtime loads by path, so its exports are used without an importer.
 */
const RUN_ENTRY = /\.run\.[cm]?tsx?$/u
const COMMAND_MODULE = /^packages\/[^/]+\/cli\/commands\//u

/**
 * Directories the knip pattern walks never enter: installed packages and build output.
 */
const WALK_EXCLUDED = ["**/node_modules/**", "**/out/**"]

/**
 * True when `file` (repo-relative) is a test or test support.
 * An import from such a file never counts as a use.
 */
function isTestModule(file: string): boolean {
	if (TEST_FILE.test(file)) return true

	return file.split("/").some((segment) => TEST_SEGMENTS.has(segment.replace(/\.[cm]?[jt]sx?$/u, "")))
}

/**
 * The parts of `knip.json` this check reads: each workspace's `entry` patterns.
 */
interface KnipConfig {
	workspaces?: Record<string, { entry?: string[] }>
}

/**
 * How specific a knip workspace key is.
 *
 * Knip applies the literal key over a brace list such as `packages/{fastify,mcp}`.
 * It applies either over the `packages/*` default.
 */
function keySpecificity(key: string): number {
	if (!/[*?{[]/u.test(key)) return 2

	return key.endsWith("/*") ? 0 : 1
}

/**
 * Every repo-relative file a knip `entry` pattern matches.
 *
 * Each workspace's patterns come from the most specific key that covers the workspace.
 */
async function knipEntryFiles(context: RepoContext): Promise<Set<string>> {
	if (!context.trackedFiles.includes("knip.json")) return new Set()

	const knip = await readLocalJSONFile<KnipConfig>(resolvePath(context.repoRoot, "knip.json"))
	const owners = new Map<string, string>()

	for (const key of Object.keys(knip.workspaces ?? {})) {
		const directories =
			keySpecificity(key) === 2
				? [key]
				: (
						await Globerator.from(key, {
							cwd: context.repoRoot,
							absolute: true,
							onlyFiles: false,
							exclude: WALK_EXCLUDED,
						}).toArray()
					).map((path) => relative(context.repoRoot, path))

		for (const directory of directories) {
			const current = owners.get(directory)

			if (current == null || keySpecificity(key) > keySpecificity(current)) {
				owners.set(directory, key)
			}
		}
	}

	const files = new Set<string>()

	for (const [directory, key] of owners) {
		const patterns = knip.workspaces?.[key]?.entry ?? []

		if (!patterns.length) continue

		const matched = await Globerator.from(patterns, {
			cwd: resolvePath(context.repoRoot, directory),
			absolute: true,
			exclude: WALK_EXCLUDED,
			throwIfDirectoryMissing: false,
		}).toArray()

		for (const path of matched) {
			files.add(relative(context.repoRoot, path))
		}
	}

	return files
}

/**
 * What one workspace's manifest contributes to the entry sets.
 */
interface WorkspaceEntries {
	/**
	 * Repo-relative files the workspace's explicit `exports` subpaths resolve to.
	 */
	subpathTargets: string[]
	/**
	 * Published to npm rather than `private`, so its subpath targets are public interface.
	 */
	published: boolean
}

/**
 * The explicit `exports` subpaths of a manifest, as specifiers of the package itself.
 */
function explicitSubpathSpecifiers(name: string, exportsField: unknown): string[] {
	if (typeof exportsField === "string") return [name]

	if (exportsField == null || typeof exportsField !== "object") return []

	const keys = Object.keys(exportsField)

	if (!keys.every((key) => key.startsWith("."))) return [name]

	return keys
		.filter((key) => !key.includes("*") && key !== "./package.json")
		.map((key) => (key === "." ? name : `${name}${key.slice(1)}`))
}

async function readWorkspaceEntries(context: RepoContext, resolver: MoveResolver): Promise<WorkspaceEntries[]> {
	const directories = [".", ...(await readWorkspaceDirectories(context.repoRoot))]
	const entries: WorkspaceEntries[] = []

	for (const directory of directories) {
		const manifestFile = directory === "." ? "package.json" : `${directory}/package.json`
		const manifest = await readPackageJSON(resolvePath(context.repoRoot, manifestFile))
		const specifiers = manifest.name ? explicitSubpathSpecifiers(manifest.name, manifest.exports) : []
		const subpathTargets = specifiers.map((specifier) => resolver.resolve(specifier, manifestFile))

		entries.push({
			subpathTargets: subpathTargets.filter(isPresent),
			published: !manifest.private,
		})
	}

	return entries
}

/**
 * How an export is reached, once re-exports are followed.
 */
interface ExportReach {
	testImporters: Set<string>
	used: boolean
	publicEntry: boolean
}

/**
 * An export reached only by tests.
 */
export interface TestOnlyExport {
	/**
	 * Repo-relative path of the declaring module.
	 */
	file: string
	line: number
	name: string
	/**
	 * Repo-relative paths of the tests that import it, sorted.
	 */
	testImporters: string[]
	/**
	 * Referenced inside its own module, so the `export` keyword serves only the test.
	 * Otherwise the declaration has no caller outside tests.
	 */
	usedInModule: boolean
	/**
	 * Reachable from a published workspace's explicit `exports` subpath,
	 * so a caller may live outside the repository.
	 */
	publicEntry: boolean
}

function scriptKindOf(file: string): ts.ScriptKind {
	const jsx = file.endsWith("x")

	if (/\.[cm]?jsx?$/u.test(file)) return jsx ? ts.ScriptKind.JSX : ts.ScriptKind.JS

	return jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

/**
 * Every exported declaration under a workspace source root or the root `lib/` that only tests import.
 *
 * An export tagged `@public`, used by a module that's not a test, or exported
 * from a runtime entry is left out.
 */
export async function findTestOnlyExports(context: RepoContext): Promise<TestOnlyExport[]> {
	const paths = await trackedSourcePaths(context, {
		globs: IMPORTER_GLOBS,
		excludePrefixes: IMPORTER_EXCLUDED_PREFIXES,
		existingOnly: true,
	})

	await readContextSources(context, paths)

	const resolver = createMoveResolver(context.repoRoot)
	const facts = new Map<string, ModuleFacts>()

	for (const path of paths) {
		const file = relative(context.repoRoot, path)
		const source = await parseContextSource(context, path, { setParentNodes: true, scriptKind: scriptKindOf(file) })

		facts.set(
			file,
			moduleFacts(source, (specifier) => resolver.resolve(specifier, file))
		)
	}

	const reach = new Map<string, ExportReach>()

	const reachOf = (file: string, name: string): ExportReach => {
		const key = `${file}\0${name}`
		let found = reach.get(key)

		if (!found) {
			found = { testImporters: new Set(), used: false, publicEntry: false }
			reach.set(key, found)
		}

		return found
	}

	type Mark = (found: ExportReach) => void

	/**
	 * Applies `mark` to the declaration that `name` reaches from `file`, following re-exports.
	 *
	 * `seen` holds each module and name already followed, so a cycle of barrels ends.
	 */
	const markName = (file: string, name: string, mark: Mark, seen: Set<string>): void => {
		const key = `${file}\0${name}`

		if (seen.has(key)) return

		seen.add(key)

		const module = facts.get(file)

		if (!module) return

		if (name === EVERY_EXPORT) {
			const names = [...module.declared.keys(), ...module.reExports.keys()]

			for (const each of names) {
				markName(file, each, mark, seen)
			}

			for (const star of module.stars) {
				markName(star, EVERY_EXPORT, mark, seen)
			}

			return
		}

		if (module.declared.has(name)) return mark(reachOf(file, name))

		const reExport = module.reExports.get(name)

		if (reExport) return markName(reExport.target, reExport.name, mark, seen)

		if (name === "default") return

		for (const star of module.stars) {
			markName(star, name, mark, seen)
		}
	}

	for (const [file, module] of facts) {
		const mark: Mark = isTestModule(file)
			? (found) => {
					found.testImporters.add(file)
				}
			: (found) => {
					found.used = true
				}

		for (const use of module.uses) {
			for (const name of use.names) {
				markName(use.target, name, mark, new Set())
			}
		}
	}

	const used: Mark = (found) => {
		found.used = true
	}

	const publicEntry: Mark = (found) => {
		found.publicEntry = true
	}

	const workspaces = await readWorkspaceEntries(context, resolver)
	const subpathTargets = new Set(workspaces.flatMap((workspace) => workspace.subpathTargets))
	const knipEntries = await knipEntryFiles(context)

	for (const file of facts.keys()) {
		if (isTestModule(file)) continue

		// A knip entry that's also an `exports` target is the package's interface, read below.
		// It's not a module the runtime loads by path.
		const loadedByPath =
			RUN_ENTRY.test(file) || COMMAND_MODULE.test(file) || (knipEntries.has(file) && !subpathTargets.has(file))

		if (loadedByPath) {
			markName(file, EVERY_EXPORT, used, new Set())
		}
	}

	for (const file of workspaces.flatMap((workspace) => (workspace.published ? workspace.subpathTargets : []))) {
		markName(file, EVERY_EXPORT, publicEntry, new Set())
	}

	const findings: TestOnlyExport[] = []

	for (const [file, module] of facts) {
		if (!PACKAGE_SOURCE_PATH.test(file) || isTestModule(file)) continue

		for (const [name, declaration] of module.declared) {
			const found = reach.get(`${file}\0${name}`)

			if (!found || found.used || declaration.publicTag || !found.testImporters.size) continue

			findings.push({
				file,
				line: declaration.line,
				name,
				testImporters: [...found.testImporters].toSorted(),
				usedInModule: declaration.usedInModule,
				publicEntry: found.publicEntry,
			})
		}
	}

	return findings.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

/**
 * The check: one warning per internal export only tests import, and one warning listing the published ones.
 */
export const testOnlyExportsCheck: RepoCheck = {
	id: "test-only-exports",
	description:
		"An exported declaration whose only importers are tests: delete it with its test, or give it a caller. Knip counts a test's import as a use, so it reports none of these.",
	async run(context) {
		const diagnostics: Diagnostic[] = []
		const findings = await findTestOnlyExports(context)
		const published = findings.filter((finding) => finding.publicEntry)

		for (const finding of findings) {
			if (finding.publicEntry) continue

			const reach = finding.usedInModule
				? "is used in its own module, and only tests import it"
				: "has no caller outside tests"

			diagnostics.push({
				severity: DiagnosticSeverity.Warning,
				file: finding.file,
				line: finding.line,
				message: `export \`${finding.name}\` ${reach}. Delete it with its test, give it a caller, or drop the \`export\` and test through a caller.`,
				details: finding.testImporters,
			})
		}

		if (published.length) {
			diagnostics.push({
				severity: DiagnosticSeverity.Warning,
				file: null,
				line: null,
				message: `${published.length} exports of a published package's explicit \`exports\` subpath have no caller in the repository apart from tests. Tag one \`@public\` if it's meant for users, or delete it.`,
				details: published.map((finding) => `${finding.file}:${finding.line} ${finding.name}`),
			})
		}

		return diagnostics
	},
}
