/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Checks that every `exports` and `imports` target in every workspace manifest resolves to a tracked file.
 *
 *   The check maps each `out/` target back to its source. For example, `./out/x.js` comes from `lib/x.ts`,
 *   `lib/x.tsx` or `lib/x/index.ts`, and `docs/` uses `src/` in place of `lib/`. A pattern target passes when the
 *   directory before its `*` holds a tracked file. Only `imports["#*"]` may match no file, because every workspace
 *   declares it and the data-only weights overlays compile no TypeScript.
 *
 *   A tracked source must also fall inside the workspace `tsconfig.json` `include` and `exclude` globs. Otherwise
 *   `tsc -b` skips it, and the tarball lacks the promised `out/` file.
 */

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
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
 * The `include` and `exclude` globs of a workspace `tsconfig.json`, as written.
 *
 * The reader does not follow `extends`, because every emitting workspace states both fields locally.
 * A config without either field admits every source.
 */
export interface CompileScope {
	include?: readonly string[]
	exclude?: readonly string[]
}

/**
 * Converts a tsconfig glob to a matcher over workspace-relative paths.
 *
 * `**` spans directories and `*` matches within one segment.
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
 * The path must match an `include` glob when the config has any, and it must match no `exclude` glob.
 */
export function compilerAdmits(scope: CompileScope, path: string): boolean {
	const included = !scope.include || scope.include.some((glob) => tsconfigGlob(glob).test(path))
	const excluded = scope.exclude?.some((glob) => tsconfigGlob(glob).test(path)) ?? false

	return included && !excluded
}

/**
 * Reads a workspace's compile scope.
 *
 * It returns an empty scope, which admits every source, when the workspace has no `tsconfig.json`.
 *
 * TypeScript's own parser reads the file because the configs contain comments.
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
 * Returns the repo-relative files that can satisfy a target without a pattern.
 * An `out/` target maps back to its source files.
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
 * Returns the repo-relative directory that holds a pattern target's files.
 * An `out/` prefix maps back to the source directory.
 */
export function patternDirectory(workspace: string, target: string): string {
	const prefix = target.replace(/^\.\//u, "").split("*")[0]!
	const sourceRoot = workspace === "docs" ? "src/" : "lib/"

	return `${workspace}/${prefix.replace(/^out\//u, sourceRoot)}`
}

/**
 * Returns a diagnostic for one target, or null when the target passes.
 *
 * A target passes when a tracked file satisfies it and, for an `out/` target,
 * the compile scope emits that file.
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
 * The `manifest-targets` check.
 *
 * It reports an error for each manifest target without a tracked, emitted source.
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
