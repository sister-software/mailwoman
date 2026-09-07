/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Every `exports` and `imports` target in every workspace manifest names a file the repository carries.
 *
 *   A manifest entry whose target moved or never existed is a published path that resolves to nothing, and nothing
 *   earlier than the release preflight's tarball audit read one: `@mailwoman/core` shipped `./utils/jsonl` for
 *   several releases after the module went (#2052), then `./utils/hash` and `./utils/stats` after those modules moved
 *   (#2141). This check reads the manifests against the tracked file list at PR time.
 *
 *   Targets under `out/` are the compiler's output and are not tracked, so each is mapped back to the source that
 *   emits it (`./out/x.js` and `./out/x.d.ts` come from `lib/x.ts`, `lib/x.tsx` or `lib/x/index.ts`; `docs/` keeps its
 *   `src/`). A pattern target is satisfied when the directory before its `*` holds at least one tracked file. The one
 *   pattern allowed to map onto an empty tree is `imports["#*"]`: every workspace carries it by convention, the data-only
 *   weights overlays included, and those compile nothing.
 *
 *   A tracked source is not yet an emitted target. A workspace `tsconfig.json` whose `exclude` names the source (or
 *   whose `include` misses it) makes `tsc -b` skip it, and the tarball then lacks the `out/` file the manifest promises
 *   while every tracked-file reading passes — which is what the release preflight's tarball audit found on a test-kit
 *   subpath. So a compiled target is also read against the workspace's own `include` / `exclude` globs.
 */

import { pathExists, readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { resolvePath } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"

type ExportValue = string | null | ExportValue[] | { [condition: string]: ExportValue }

interface WorkspaceManifest {
	exports?: ExportValue | Record<string, ExportValue>
	imports?: Record<string, ExportValue>
}

const CONVENTIONAL_EMPTY_PATTERNS = new Set(["#*"])

/**
 * The half of a workspace `tsconfig.json` that decides whether a tracked source is emitted: the `include` and `exclude`
 * globs as written. `extends` is not followed — every emitting workspace states both locally — and a config that states
 * neither makes no claim, so it admits every source.
 */
export interface CompileScope {
	include?: readonly string[]
	exclude?: readonly string[]
}

/**
 * A tsconfig glob as a matcher over workspace-relative paths. `**` spans directories, `*` stays inside one segment, and
 * an entry with no wildcard names a path and everything under it (`out`, `node_modules`, `.docusaurus`).
 */
export function tsconfigGlob(glob: string): RegExp {
	const normalized = glob.replace(/^\.\//u, "").replace(/\/$/u, "")

	const body = normalized.replaceAll(/\*\*\/|\*\*|\*|[.+^${}()|[\]\\]/gu, (token) => {
		switch (token) {
			case "**/":
				return "(?:.*/)?"
			case "**":
				return ".*"
			case "*":
				return "[^/]*"
			default:
				return `\\${token}`
		}
	})

	return normalized.includes("*") ? new RegExp(`^${body}$`, "u") : new RegExp(`^${body}(?:/.*)?$`, "u")
}

/**
 * Whether `tsc` emits `path` (workspace-relative) under `scope`: inside some `include` glob when the config states any,
 * and outside every `exclude` glob.
 */
export function compilerAdmits(scope: CompileScope, path: string): boolean {
	const included = !scope.include || scope.include.some((glob) => tsconfigGlob(glob).test(path))
	const excluded = scope.exclude?.some((glob) => tsconfigGlob(glob).test(path)) ?? false

	return included && !excluded
}

/**
 * The workspace's compile scope, or an empty one (admits everything) when it carries no `tsconfig.json`. Read through
 * TypeScript's own JSONC parser: the configs carry line comments.
 */
export async function readCompileScope(repoRoot: string, workspace: string): Promise<CompileScope> {
	const configPath = resolvePath(repoRoot, workspace, "tsconfig.json")

	if (!(await pathExists(configPath))) return {}

	const { config } = ts.parseConfigFileTextToJson(configPath, await readLocalTextFile(configPath))
	const scope: CompileScope = {}

	if (Array.isArray(config?.include)) {
		scope.include = config.include as string[]
	}

	if (Array.isArray(config?.exclude)) {
		scope.exclude = config.exclude as string[]
	}

	return scope
}

function* targetStrings(value: ExportValue | undefined): Generator<string> {
	if (typeof value === "string") {
		yield value
	} else if (Array.isArray(value)) {
		for (const entry of value) {
			yield* targetStrings(entry)
		}
	} else if (value && typeof value === "object") {
		for (const entry of Object.values(value)) {
			yield* targetStrings(entry)
		}
	}
}

/**
 * The repo-relative files any one of which satisfies a concrete (pattern-free) target, `out/` mapped back to source.
 */
export function sourceCandidates(workspace: string, target: string): string[] {
	const path = target.replace(/^\.\//u, "")
	const compiled = /^out\/(.*)$/u.exec(path)

	if (!compiled) return [`${workspace}/${path}`]

	const base = compiled[1]!.replace(/\.d\.ts$/u, "").replace(/\.(?:js|mjs|cjs|ts)$/u, "")
	const sourceRoot = workspace === "docs" ? "src" : "lib"

	return [
		`${workspace}/${sourceRoot}/${base}.ts`,
		`${workspace}/${sourceRoot}/${base}.tsx`,
		`${workspace}/${sourceRoot}/${base}/index.ts`,
	]
}

/**
 * The repo-relative directory a pattern target's files live under, `out/` mapped back to source.
 */
export function patternDirectory(workspace: string, target: string): string {
	const prefix = target.replace(/^\.\//u, "").split("*")[0]!
	const sourceRoot = workspace === "docs" ? "src/" : "lib/"

	return `${workspace}/${prefix.replace(/^out\//u, sourceRoot)}`
}

/**
 * The diagnostic one target earns, or null when a tracked file satisfies it — and, for a target under `out/`, when the
 * workspace's compile scope emits that file.
 */
function judgeTarget(
	workspace: string,
	field: string,
	subpath: string,
	target: string,
	trackedFiles: readonly string[],
	tracked: ReadonlySet<string>,
	scope: CompileScope
): Diagnostic | null {
	const file = `${workspace}/package.json`
	const compiled = target.startsWith("./out/")
	const emitted = (path: string): boolean => !compiled || compilerAdmits(scope, path.slice(workspace.length + 1))

	if (target.includes("*")) {
		if (CONVENTIONAL_EMPTY_PATTERNS.has(subpath)) return null
		const directory = patternDirectory(workspace, target)
		const under = trackedFiles.filter((path) => path.startsWith(directory))

		if (under.some(emitted)) return null

		return {
			severity: DiagnosticSeverity.Error,
			file,
			message: under.length
				? `${field}["${subpath}"] → ${target}: ${workspace}/tsconfig.json compiles none of the ${under.length} tracked files under ${directory}, so nothing emits the target`
				: `${field}["${subpath}"] → ${target}: no tracked file under ${directory}`,
		}
	}

	const candidates = sourceCandidates(workspace, target)
	const source = candidates.find((candidate) => tracked.has(candidate))

	if (!source) {
		return {
			severity: DiagnosticSeverity.Error,
			file,
			message: `${field}["${subpath}"] → ${target}: none of ${candidates.join(", ")} is tracked`,
		}
	}

	if (emitted(source)) return null

	return {
		severity: DiagnosticSeverity.Error,
		file,
		message: `${field}["${subpath}"] → ${target}: ${source} is tracked, but ${workspace}/tsconfig.json does not compile it (include/exclude), so nothing emits the target`,
	}
}

function manifestMaps(manifest: WorkspaceManifest): Array<[string, Record<string, ExportValue>]> {
	const maps: Array<[string, Record<string, ExportValue>]> = []

	if (manifest.exports && typeof manifest.exports === "object" && !Array.isArray(manifest.exports)) {
		maps.push(["exports", manifest.exports as Record<string, ExportValue>])
	}

	if (manifest.imports) {
		maps.push(["imports", manifest.imports])
	}

	return maps
}

/**
 * The check the two stale-subpath incidents asked for: a manifest target that names no tracked file is an error.
 */
export const manifestTargetsCheck: RepoCheck = {
	id: "manifest-targets",
	description:
		"Every exports and imports target in every workspace manifest resolves to a tracked source or data file.",
	async run(context) {
		const root = context.repoRoot
		const tracked = new Set(context.trackedFiles)
		const diagnostics: Diagnostic[] = []

		for (const workspace of await readWorkspaceDirectories(root)) {
			const manifest = await readLocalJSONFile<WorkspaceManifest>(resolvePath(root, `${workspace}/package.json`))
			const scope = await readCompileScope(root, workspace)

			for (const [field, map] of manifestMaps(manifest)) {
				for (const [subpath, value] of Object.entries(map)) {
					for (const target of targetStrings(value)) {
						if (!target.startsWith("./")) continue
						const diagnostic = judgeTarget(workspace, field, subpath, target, context.trackedFiles, tracked, scope)

						if (diagnostic) {
							diagnostics.push(diagnostic)
						}
					}
				}
			}
		}

		return diagnostics
	},
}
