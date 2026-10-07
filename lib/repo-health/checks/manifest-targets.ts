/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Checks that every `exports` and `imports` target in every workspace manifest resolves to a tracked file.
 *
 *   An `out/` target maps back to its source (`./out/x.js` ← `lib/x.ts`, `lib/x.tsx` or `lib/x/index.ts`, with `src/`
 *   in place of `lib/` under `docs/`), and a tracked source must also fall inside the workspace `tsconfig.json`
 *   `include`/`exclude` globs, or `tsc -b` skips it and the tarball lacks the promised file.
 *
 *   Only `imports["#*"]` may match no file, because every workspace declares it and the data-only weights overlays
 *   compile no TypeScript.
 */

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { resolvePath } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"

type ExportValue = string | null | ExportValue[] | { [condition: string]: ExportValue }

interface WorkspaceManifest {
	exports?: ExportValue | Record<string, ExportValue>
	imports?: Record<string, ExportValue>
}

const CONVENTIONAL_EMPTY_PATTERNS = new Set(["#*"])

/**
 * The `include` and `exclude` globs of a workspace `tsconfig.json`, as written.
 *
 * A config lacking either field admits every source.
 * The checker does not follow `extends` because every emitting workspace states both fields locally.
 */
export interface CompileScope {
	include?: readonly string[]
	exclude?: readonly string[]
}

/**
 * Converts a tsconfig glob to a matcher over workspace-relative paths.
 *
 * `**` spans directories.
 * `*` matches within one segment.
 *
 * An entry without a wildcard matches that path and everything under it.
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
 * Returns whether `tsc` emits the workspace-relative `path` under `scope`.
 *
 * The path must match an `include` glob when the config has one.
 * It must match no `exclude` glob.
 */
export function compilerAdmits(scope: CompileScope, path: string): boolean {
	const included = !scope.include || scope.include.some((glob) => tsconfigGlob(glob).test(path))
	const excluded = scope.exclude?.some((glob) => tsconfigGlob(glob).test(path)) ?? false

	return included && !excluded
}

/**
 * Reads a workspace's compile scope, returning an empty scope that admits every source when there
 * is no `tsconfig.json`; TypeScript's own parser reads the file because the configs contain comments.
 */
async function readCompileScope(repoRoot: string, workspace: string): Promise<CompileScope> {
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

function* targetStrings(value: ExportValue | null): Generator<string> {
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
 * Splits an emitted path below `out/` into the source root that emits it and the rest of the path.
 *
 * A directory with its own `tsconfig.json` beside `lib/`, such as `sdk/`, compiles to `out/<root>/`.
 * Every other emitted path comes from `lib/`, or from `src/` under `docs`.
 */
function emittingRoot(workspace: string, emitted: string, extraRoots: readonly string[]): [string, string] {
	const root = extraRoots.find((candidate) => emitted.startsWith(`${candidate}/`))

	if (root) return [root, emitted.slice(root.length + 1)]

	return [workspace === "docs" ? "src" : "lib", emitted]
}

/**
 * Returns the repo-relative files that can satisfy a target without a pattern,
 * mapping an `out/` target back to its source files.
 */
export function sourceCandidates(workspace: string, target: string, extraRoots: readonly string[] = []): string[] {
	const path = target.replace(/^\.\//u, "")
	const compiled = /^out\/(.*)$/u.exec(path)

	if (!compiled) return [`${workspace}/${path}`]

	const [sourceRoot, rest] = emittingRoot(workspace, compiled[1]!, extraRoots)
	const base = rest.replace(/\.d\.ts$/u, "").replace(/\.(?:js|mjs|cjs|ts)$/u, "")

	return [
		`${workspace}/${sourceRoot}/${base}.ts`,
		`${workspace}/${sourceRoot}/${base}.tsx`,
		`${workspace}/${sourceRoot}/${base}/index.ts`,
	]
}

/**
 * Returns the repo-relative directory that holds a pattern target's files,
 * mapping an `out/` prefix back to the source directory.
 */
export function patternDirectory(workspace: string, target: string, extraRoots: readonly string[] = []): string {
	const prefix = target.replace(/^\.\//u, "").split("*")[0]!
	const compiled = /^out\/(.*)$/u.exec(prefix)

	if (!compiled) return `${workspace}/${prefix}`

	const [sourceRoot, rest] = emittingRoot(workspace, compiled[1]!, extraRoots)

	return `${workspace}/${sourceRoot}/${rest}`
}

/**
 * The directories beside `lib/` that compile as their own project, each with
 * the scope its `tsconfig.json` states.
 */
async function readExtraRoots(
	repoRoot: string,
	workspace: string,
	trackedFiles: readonly string[]
): Promise<Map<string, CompileScope>> {
	const pattern = new RegExp(`^${workspace.replaceAll(".", "\\.")}/([^/]+)/tsconfig\\.json$`, "u")
	const roots = new Map<string, CompileScope>()

	for (const file of trackedFiles) {
		const root = pattern.exec(file)?.[1]

		if (root) {
			roots.set(root, await readCompileScope(repoRoot, `${workspace}/${root}`))
		}
	}

	return roots
}

/**
 * Returns a diagnostic for one target, or null when a tracked file satisfies it and,
 * for an `out/` target, the compile scope emits that file.
 */
function judgeTarget(
	workspace: string,
	field: string,
	subpath: string,
	target: string,
	trackedFiles: readonly string[],
	tracked: ReadonlySet<string>,
	scope: CompileScope,
	extraRoots: ReadonlyMap<string, CompileScope>
): Diagnostic | null {
	const file = `${workspace}/package.json`
	const compiled = target.startsWith("./out/")
	const rootNames = [...extraRoots.keys()]

	const emitted = (path: string): boolean => {
		if (!compiled) return true

		const relative = path.slice(workspace.length + 1)
		const root = rootNames.find((name) => relative.startsWith(`${name}/`))

		return root
			? compilerAdmits(extraRoots.get(root)!, relative.slice(root.length + 1))
			: compilerAdmits(scope, relative)
	}

	if (target.includes("*")) {
		if (CONVENTIONAL_EMPTY_PATTERNS.has(subpath)) return null
		const directory = patternDirectory(workspace, target, rootNames)
		const under = trackedFiles.filter((path) => path.startsWith(directory))

		if (under.some(emitted)) return null

		return {
			severity: DiagnosticSeverity.Error,
			file,
			message: under.length
				? `${field}["${subpath}"] → ${target}: ${workspace}/tsconfig.json compiles none of the ${under.length} tracked files under ${directory}, so nothing emits the target`
				: `${field}["${subpath}"] → ${target}: no tracked file under ${directory}`,
			line: null,
			details: null,
		}
	}

	const candidates = sourceCandidates(workspace, target, rootNames)
	const source = candidates.find((candidate) => tracked.has(candidate))

	if (!source) {
		return {
			severity: DiagnosticSeverity.Error,
			file,
			message: `${field}["${subpath}"] → ${target}: none of ${candidates.join(", ")} is tracked`,
			line: null,
			details: null,
		}
	}

	if (emitted(source)) return null

	return {
		severity: DiagnosticSeverity.Error,
		file,
		message: `${field}["${subpath}"] → ${target}: ${source} is tracked, but ${workspace}/tsconfig.json does not compile it (include/exclude), so nothing emits the target`,
		line: null,
		details: null,
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
 * The `manifest-targets` check: an error for each manifest target without a tracked, emitted source.
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
			const manifest = await readPackageJSON(resolvePath(root, workspace, "package.json"))
			const scope = await readCompileScope(root, workspace)
			const extraRoots = await readExtraRoots(root, workspace, context.trackedFiles)

			for (const [field, map] of manifestMaps(manifest)) {
				for (const [subpath, value] of Object.entries(map)) {
					for (const target of targetStrings(value)) {
						if (!target.startsWith("./")) continue

						const diagnostic = judgeTarget(
							workspace,
							field,
							subpath,
							target,
							context.trackedFiles,
							tracked,
							scope,
							extraRoots
						)

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
