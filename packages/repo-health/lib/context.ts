/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The one place a `RepoContext` is collected from a live checkout, and the source text and syntax trees it holds.
 *   Adapters and tests call this rather than spawning `git ls-files` themselves, so every check reads the same file set,
 *   and a check that reads a source calls {@linkcode readContextSource} or {@linkcode parseContextSource}, so the checks
 *   one invocation runs read and parse each file once between them.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { trackedFiles } from "@mailwoman/core/git"
import { repoRootPath } from "@mailwoman/core/paths"
import { type PathBuilderLike, resolvePath } from "path-ts"
import { parallelMap } from "spliterator"
import ts from "typescript"

import type { RepoContext } from "#check"

/**
 * A `RepoContext` for the checkout at `repoRoot` (default: the repository this module sits in).
 *
 * The file listing is `trackedFiles` from `@mailwoman/core/git` directly.
 * A wrapper here that returned that call unchanged would be a second public name for one function.
 * `export-name-affix` reports it.
 */
export async function collectRepoContext(repoRoot: PathBuilderLike = repoRootPath()): Promise<RepoContext> {
	return { repoRoot: repoRoot.toString(), trackedFiles: await trackedFiles(repoRoot) }
}

/**
 * How a source is parsed.
 *
 * The script target is always `ts.ScriptTarget.Latest`, which is the same enum value as `ESNext`.
 */
export interface ContextParseOptions {
	/**
	 * Set each node's `parent` while parsing (default false).
	 */
	setParentNodes?: boolean
	/**
	 * Default: TSX for a `.tsx` path, TS for every other path.
	 */
	scriptKind?: ts.ScriptKind
}

/**
 * What one context has read and parsed, keyed by absolute path.
 */
interface ContextSources {
	texts: Map<string, Promise<string>>
	/**
	 * Keyed by the parse options, then by path, so each option set parses a file once.
	 */
	trees: Map<string, Map<string, ts.SourceFile>>
}

/**
 * Held by the context object, so the cache lives exactly as long as the context.
 * A context built by spreading another starts empty.
 *
 * A cached read assumes the tree does not change while its context is in use.
 * A check only reads, and `mwops health fix` builds a new context for each pass.
 *
 * A source written and read again through one context reads as it was before the write.
 * The move planner and applier therefore read the disk directly.
 */
const contextSources = new WeakMap<RepoContext, ContextSources>()

function sourcesOf(context: RepoContext): ContextSources {
	let sources = contextSources.get(context)

	if (!sources) {
		sources = { texts: new Map(), trees: new Map() }
		contextSources.set(context, sources)
	}

	return sources
}

/**
 * The text of the file at `path` (absolute, or relative to the context's root), read once per context.
 *
 * A failed read rejects, and every later call for that path rejects with the same error.
 */
export function readContextSource(context: RepoContext, path: string): Promise<string> {
	const key: string = resolvePath(context.repoRoot, path)
	const { texts } = sourcesOf(context)
	let pending = texts.get(key)

	if (!pending) {
		pending = readLocalTextFile(key)
		texts.set(key, pending)
	}

	return pending
}

/**
 * The text of each file in `paths`, in the order given, with up to the filesystem fan-out's reads in flight.
 *
 * The reads complete in any order, and the texts are then taken in the order given.
 * The error thrown is therefore the one for the first unreadable path in `paths`,
 * as a loop reading one file at a time would throw.
 */
export async function readContextSources(context: RepoContext, paths: readonly string[]): Promise<string[]> {
	// Each failure is caught here and rethrown below, in input order, by the same memoized read.
	await parallelMap(paths, (path) => readContextSource(context, path).catch(() => undefined)).toArray()

	const texts: string[] = []

	for (const path of paths) {
		texts.push(await readContextSource(context, path))
	}

	return texts
}

/**
 * The syntax tree of the file at `path`, parsed once per context and option set.
 *
 * The tree's `fileName` is the absolute path.
 * Callers share the tree, so none may mutate it.
 */
export async function parseContextSource(
	context: RepoContext,
	path: string,
	options: ContextParseOptions = {}
): Promise<ts.SourceFile> {
	const key: string = resolvePath(context.repoRoot, path)
	const text = await readContextSource(context, key)
	const setParentNodes = options.setParentNodes ?? false
	const scriptKind = options.scriptKind ?? (key.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
	const optionKey = `${scriptKind}:${setParentNodes}`
	const { trees } = sourcesOf(context)
	let byPath = trees.get(optionKey)

	if (!byPath) {
		byPath = new Map()
		trees.set(optionKey, byPath)
	}

	let source = byPath.get(key)

	if (!source) {
		source = ts.createSourceFile(key, text, ts.ScriptTarget.Latest, setParentNodes, scriptKind)
		byPath.set(key, source)
	}

	return source
}
