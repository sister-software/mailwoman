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
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"

interface RootManifest {
	workspaces: string[]
}

type ExportValue = string | null | ExportValue[] | { [condition: string]: ExportValue }

interface WorkspaceManifest {
	exports?: ExportValue | Record<string, ExportValue>
	imports?: Record<string, ExportValue>
}

const CONVENTIONAL_EMPTY_PATTERNS = new Set(["#*"])

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
 * The diagnostic one target earns, or null when a tracked file satisfies it.
 */
function judgeTarget(
	workspace: string,
	field: string,
	subpath: string,
	target: string,
	trackedFiles: readonly string[],
	tracked: ReadonlySet<string>
): Diagnostic | null {
	const file = `${workspace}/package.json`

	if (target.includes("*")) {
		if (CONVENTIONAL_EMPTY_PATTERNS.has(subpath)) return null
		const directory = patternDirectory(workspace, target)

		if (trackedFiles.some((path) => path.startsWith(directory))) return null

		return {
			severity: DiagnosticSeverity.Error,
			file,
			message: `${field}["${subpath}"] → ${target}: no tracked file under ${directory}`,
		}
	}

	const candidates = sourceCandidates(workspace, target)

	if (candidates.some((candidate) => tracked.has(candidate))) return null

	return {
		severity: DiagnosticSeverity.Error,
		file,
		message: `${field}["${subpath}"] → ${target}: none of ${candidates.join(", ")} is tracked`,
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
		const rootManifest = await readLocalJSONFile<RootManifest>(resolvePath(root, "package.json"))
		const diagnostics: Diagnostic[] = []

		for (const workspace of rootManifest.workspaces) {
			const manifest = await readLocalJSONFile<WorkspaceManifest>(resolvePath(root, `${workspace}/package.json`))

			for (const [field, map] of manifestMaps(manifest)) {
				for (const [subpath, value] of Object.entries(map)) {
					for (const target of targetStrings(value)) {
						if (!target.startsWith("./")) continue
						const diagnostic = judgeTarget(workspace, field, subpath, target, context.trackedFiles, tracked)

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
