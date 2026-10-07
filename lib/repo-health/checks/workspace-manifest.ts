/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A workspace that compiles `lib/` to `out/` exposes its modules through one `"./*"` pattern. An explicit subpath key
 *   remains only when the pattern cannot express it: the `"."` entry, a module that is not `.ts`, a non-code file, or
 *   an entry with conditions other than `types`, `node` and `default`.
 *
 *   An importer writes the module's path under `lib/`, so `@mailwoman/zoning/sdk/cells` names `lib/sdk/cells.ts`.
 *   A subpath key that renames its file, such as `./address-layout` for `lib/address/layout.ts`, is reported, and the fix
 *   rewrites each importer to the path spelling.
 *
 *   The same workspaces publish TypeScript from `lib/` only. A root config and a package-root `tools/` directory stay
 *   out of the tarball.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { parseJSONStrict, prettyJSON } from "@mailwoman/core/json"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { resolvePath } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck, type RepoContext } from "#repo-health/check"
import type { RepoFix } from "#repo-health/fix"
import type { ManifestReplacement } from "#repo-health/move/types"

const EXPORTS_CHECK_ID = "workspace-exports"
const FILES_CHECK_ID = "workspace-files"

/**
 * Workspaces whose explicit subpath list is kept by decision (#2404).
 */
const EXPLICIT_SUBPATH_WORKSPACES: ReadonlySet<string> = new Set(["packages/core"])

const PATTERN_KEY = "./*"

const PATTERN_ENTRY = {
	types: "./out/*.d.ts",
	node: "./lib/*.ts",
	default: "./out/*.js",
} as const

const STANDARD_CONDITIONS = Object.keys(PATTERN_ENTRY).join(",")
const LIB_MODULE = /^\.\/lib\/(?<module>.+)\.ts$/u
const ROOT_MODULE = /^\.\/(?<root>[^/]+)\/(?<module>.+)\.ts$/u

type ExportValue = string | null | ExportValue[] | { [condition: string]: ExportValue }

interface WorkspaceManifest {
	exports?: Record<string, ExportValue>
	imports?: Record<string, ExportValue>
	[field: string]: unknown
}

/**
 * The pattern entry of a source root beside `lib/`, which compiles to `out/<root>/`.
 */
export function rootPatternEntry(root: string): Record<string, string> {
	return { types: `./out/${root}/*.d.ts`, node: `./${root}/*.ts`, default: `./out/${root}/*.js` }
}

/**
 * Returns whether a pattern resolves every condition of `value` to the same file.
 *
 * A standard entry maps one module to `./out/<module>.d.ts`, `./lib/<module>.ts` and `./out/<module>.js`.
 * A module of an extra source root maps to `./out/<root>/<module>.d.ts`, `./<root>/<module>.ts`
 * and `./out/<root>/<module>.js`, which that root's `"./<root>/*"` pattern expresses.
 */
export function patternExpresses(value: ExportValue, roots: readonly string[] = []): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false

	if (Object.keys(value).join(",") !== STANDARD_CONDITIONS) return false

	if (typeof value.node !== "string") return false

	const lib = LIB_MODULE.exec(value.node)?.groups?.["module"]

	if (lib) return value.types === `./out/${lib}.d.ts` && value.default === `./out/${lib}.js`

	const inRoot = ROOT_MODULE.exec(value.node)?.groups

	if (!inRoot || !roots.includes(inRoot["root"]!)) return false

	const emitted = `./out/${inRoot["root"]}/${inRoot["module"]}`

	return value.types === `${emitted}.d.ts` && value.default === `${emitted}.js`
}

/**
 * The pattern keys a workspace declares: one per extra source root, then `"./*"` for `lib/`.
 */
function patternKeys(roots: readonly string[]): Map<string, Record<string, string>> {
	return new Map([
		...roots.map((root): [string, Record<string, string>] => [`./${root}/*`, rootPatternEntry(root)]),
		[PATTERN_KEY, { ...PATTERN_ENTRY }],
	])
}

/**
 * Returns the `exports` map a pattern workspace declares, keeping every entry the patterns cannot express.
 */
export function patternExports(
	exports: Readonly<Record<string, ExportValue>>,
	roots: readonly string[] = []
): Record<string, ExportValue> {
	const patterns = patternKeys(roots)
	const result: Record<string, ExportValue> = {}

	for (const [key, value] of Object.entries(exports)) {
		if (patterns.has(key)) continue

		if (key !== "." && patternExpresses(value, roots)) continue

		result[key] = value
	}

	for (const [key, entry] of patterns) {
		result[key] = entry
	}

	return result
}

/**
 * Returns the `imports` map with a `#<root>/*` key for every extra source root,
 * ahead of the `#*` key for `lib/`.
 */
export function patternImports(
	imports: Readonly<Record<string, ExportValue>>,
	roots: readonly string[]
): Record<string, ExportValue> {
	const result: Record<string, ExportValue> = {}

	for (const root of roots) {
		result[`#${root}/*`] = rootPatternEntry(root)
	}

	for (const [key, value] of Object.entries(imports)) {
		if (!(key in result)) {
			result[key] = value
		}
	}

	return result
}

/**
 * Returns the keys `patternExports` would remove, and whether any pattern entry is missing or differs.
 */
function exportDrift(
	exports: Readonly<Record<string, ExportValue>>,
	roots: readonly string[]
): { removable: string[]; patternDiffers: boolean } {
	const patterns = patternKeys(roots)

	const removable = Object.entries(exports)
		.filter(([key, value]) => key !== "." && !patterns.has(key) && patternExpresses(value, roots))
		.map(([key]) => key)

	const patternDiffers = [...patterns].some(([key, entry]) => prettyJSON(exports[key] ?? null) !== prettyJSON(entry))

	return { removable, patternDiffers }
}

/**
 * The extra source roots whose `#<root>/*` import key is missing or differs.
 */
function importDrift(imports: Readonly<Record<string, ExportValue>>, roots: readonly string[]): string[] {
	return roots.filter((root) => prettyJSON(imports[`#${root}/*`] ?? null) !== prettyJSON(rootPatternEntry(root)))
}

/**
 * Reads the `rootDir` a workspace's `tsconfig.json` states, parsed by TypeScript
 * because the configs contain comments.
 */
async function readRootDirectory(repoRoot: string, workspace: string, tracked: ReadonlySet<string>) {
	const configFile = `${workspace}/tsconfig.json`

	if (!tracked.has(configFile)) return null

	const path = resolvePath(repoRoot, configFile)
	const { config } = ts.parseConfigFileTextToJson(path.toString(), await readLocalTextFile(path))

	return typeof config?.compilerOptions?.rootDir === "string" ? (config.compilerOptions.rootDir as string) : undefined
}

interface CompilingWorkspace {
	workspace: string
	manifestFile: string
	manifest: WorkspaceManifest
	/**
	 * The directories beside `lib/` that compile as their own project, such as `sdk`.
	 */
	roots: string[]
}

/**
 * Every workspace that compiles `lib/` to `out/`, with its parsed manifest and extra source roots.
 */
async function compilingWorkspaces(context: RepoContext): Promise<CompilingWorkspace[]> {
	const tracked = new Set(context.trackedFiles)
	const found: CompilingWorkspace[] = []

	for (const workspace of await readWorkspaceDirectories(context.repoRoot)) {
		const rootDirectory = await readRootDirectory(context.repoRoot, workspace, tracked)

		if (rootDirectory !== "./lib" && rootDirectory !== "lib") continue

		const manifestFile = `${workspace}/package.json`

		const manifest = parseJSONStrict<WorkspaceManifest>(
			await readLocalTextFile(resolvePath(context.repoRoot, manifestFile))
		)

		const roots = context.trackedFiles
			.filter((file) => file.startsWith(`${workspace}/`) && file.endsWith("/tsconfig.json"))
			.map((file) => file.slice(workspace.length + 1, -"/tsconfig.json".length))
			.filter((root) => root && !root.includes("/"))
			.toSorted()

		found.push({ workspace, manifestFile, manifest, roots })
	}

	return found
}

/**
 * The compiling workspaces whose `exports` map follows the pattern, with the map each one declares.
 */
async function patternWorkspaces(
	context: RepoContext
): Promise<Array<CompilingWorkspace & { exports: Record<string, ExportValue> }>> {
	return (await compilingWorkspaces(context)).flatMap((entry) => {
		const { exports } = entry.manifest

		if (EXPLICIT_SUBPATH_WORKSPACES.has(entry.workspace)) return []

		if (!exports || typeof exports !== "object" || Array.isArray(exports)) return []

		return [{ ...entry, exports }]
	})
}

/**
 * The `workspace-exports` check: an error for each workspace whose `exports` map lists
 * a module that `"./*"` already expresses, or that lacks the `"./*"` pattern.
 */
export const workspaceExportsCheck: RepoCheck = {
	id: EXPORTS_CHECK_ID,
	description: 'A workspace compiling lib/ exposes its .ts modules through one "./*" pattern rather than a key each.',
	async run(context) {
		const diagnostics: Diagnostic[] = []

		for (const { manifestFile, manifest, exports, roots } of await patternWorkspaces(context)) {
			const { removable, patternDiffers } = exportDrift(exports, roots)
			const missingImports = importDrift(manifest.imports ?? {}, roots)

			if (!removable.length && !patternDiffers && !missingImports.length) continue

			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				file: manifestFile,
				message: patternDiffers
					? `exports lacks a standard pattern entry ("./*", or "./<root>/*" for a source root beside lib/) and lists ${removable.length} key(s) the patterns would express. \`mwops health fix ${EXPORTS_CHECK_ID}\` rewrites the map and every importer.`
					: removable.length
						? `exports lists ${removable.length} key(s) that its patterns already express. \`mwops health fix ${EXPORTS_CHECK_ID}\` rewrites the map and every importer.`
						: `imports lacks the "#<root>/*" key of ${missingImports.length} source root(s). \`mwops health fix ${EXPORTS_CHECK_ID}\` adds it.`,
				details: [...removable, ...missingImports.map((root) => `#${root}/*`)],
			})
		}

		return diagnostics
	},
}

/**
 * Repairs {@linkcode workspaceExportsCheck} findings by replacing each reported manifest.
 *
 * The move planner re-resolves every importer against the replacement and rewrites a
 * specifier whose key was removed to the path spelling that the pattern proves.
 */
export const workspaceExportsFix: RepoFix = {
	id: EXPORTS_CHECK_ID,
	description: 'Replace each redundant export key with the "./*" pattern and rewrite its importers.',
	async plan(context) {
		const manifests: ManifestReplacement[] = []

		for (const { manifestFile, manifest, exports, roots } of await patternWorkspaces(context)) {
			const { removable, patternDiffers } = exportDrift(exports, roots)
			const missingImports = importDrift(manifest.imports ?? {}, roots)

			if (!removable.length && !patternDiffers && !missingImports.length) continue

			manifests.push({
				file: manifestFile,
				text: prettyJSON({
					...manifest,
					imports: patternImports(manifest.imports ?? {}, roots),
					exports: patternExports(exports, roots),
				}),
			})
		}

		return { moves: [], manifests }
	},
}

/**
 * `files` globs that reach TypeScript outside `lib/`: a root config such as `vitest.config.ts`,
 * or a package-root `tools/` directory, both of which stay out of the tarball.
 */
const UNSCOPED_SOURCE_GLOBS: ReadonlySet<string> = new Set([
	"*.ts",
	"*.tsx",
	"**/*.ts",
	"**/*.tsx",
	"!*.test.ts",
	"!*.test.tsx",
	"!test/**",
])

const LIB_SOURCE_GLOBS = ["lib/**/*.ts", "lib/**/*.tsx"] as const

/**
 * Negations that keep a colocated test out of the tarball.
 * Every scoped list ends with them.
 */
const TEST_NEGATIONS = ["!**/*.test.ts", "!**/*.test.tsx"] as const

/**
 * Returns a `files` list whose TypeScript globs are scoped to `lib/` and to each extra source root.
 *
 * The scoped globs take the place of the first unscoped one.
 * Every other entry keeps its position, and a missing root glob or test negation is appended.
 */
export function scopedFiles(files: readonly string[], roots: readonly string[] = []): string[] {
	const result: string[] = []
	let inserted = files.some((entry) => (LIB_SOURCE_GLOBS as readonly string[]).includes(entry))

	for (const entry of files) {
		if (!UNSCOPED_SOURCE_GLOBS.has(entry)) {
			result.push(entry)

			continue
		}

		if (!inserted) {
			result.push(...LIB_SOURCE_GLOBS)
			inserted = true
		}
	}

	const rootGlobs = roots.map((root) => `${root}/**/*.ts`).filter((glob) => !result.includes(glob))
	const negations = TEST_NEGATIONS.filter((negation) => !result.includes(negation))

	return [...result, ...rootGlobs, ...negations]
}

/**
 * The compiling workspaces whose `files` list reaches TypeScript outside its source roots,
 * omits a source root, or lacks a test negation.
 */
async function unscopedFileWorkspaces(context: RepoContext) {
	return (await compilingWorkspaces(context)).flatMap((entry) => {
		const { files } = entry.manifest

		if (!Array.isArray(files)) return []

		const listed = files as string[]
		const unscoped = listed.filter((glob) => UNSCOPED_SOURCE_GLOBS.has(glob))
		const missingRoots = entry.roots.map((root) => `${root}/**/*.ts`).filter((glob) => !listed.includes(glob))
		const missing = TEST_NEGATIONS.filter((negation) => !listed.includes(negation))
		const changes = [...unscoped, ...missingRoots, ...missing]

		return changes.length ? [{ ...entry, files: listed, unscoped: changes }] : []
	})
}

/**
 * The `workspace-files` check: an error for each compiling workspace whose `files`
 * list publishes TypeScript outside `lib/`.
 */
export const workspaceFilesCheck: RepoCheck = {
	id: FILES_CHECK_ID,
	description: "A workspace compiling lib/ publishes TypeScript from lib/ only, never from its root or tools/.",
	async run(context) {
		return (await unscopedFileWorkspaces(context)).map(({ manifestFile, unscoped }) => ({
			severity: DiagnosticSeverity.Error,
			file: manifestFile,
			message: `files needs ${unscoped.length} change(s): a glob reaching TypeScript outside its source roots, a missing source root, or a missing test negation. \`mwops health fix ${FILES_CHECK_ID}\` makes them.`,
			details: unscoped,
		}))
	},
}

/**
 * Repairs {@linkcode workspaceFilesCheck} findings by replacing the unscoped globs with `lib/` globs.
 */
export const workspaceFilesFix: RepoFix = {
	id: FILES_CHECK_ID,
	description: "Scope each workspace's published TypeScript globs to lib/.",
	async plan(context) {
		const manifests = (await unscopedFileWorkspaces(context)).map(({ manifestFile, manifest, files, roots }) => ({
			file: manifestFile,
			text: prettyJSON({ ...manifest, files: scopedFiles(files, roots) }),
		}))

		return { moves: [], manifests }
	},
}
