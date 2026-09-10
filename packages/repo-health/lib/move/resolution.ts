/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Module resolution as the proof step of a move: what a specifier names now, and what a proposed replacement
 *   would name once the files have moved.
 *
 *   Two behaviours of `ts.resolveModuleName` shape this file. Every workspace's subpath maps put `types` first, so a
 *   specifier resolves to `packages/corpus/out/recipes/nl-postcode.d.ts` in a built checkout and to
 *   `packages/corpus/lib/recipes/nl-postcode.ts` in a clean one — one specifier, two answers, decided by whether
 *   anyone had run `tsc`. Worse mid-move: `out/` still holds declarations emitted from the OLD paths, so the resolver
 *   reading the tree as it stands and the resolver reading it as it will be answer different files for the same
 *   import, and every such disagreement reads as a specifier nobody can repoint. The host therefore reports every
 *   `<package>/out/**` path as absent, which is not a workaround but the operation's subject: a module move is a
 *   source-tree change, and build output is not evidence about it.
 *
 *   The second behaviour is that resolution reads the filesystem, so proving a replacement BEFORE anything moves
 *   needs a host that reports the destination as present and the origin as gone. That is what
 *   {@linkcode createMoveResolver} builds from the moves.
 */

import { resolvePath } from "path-ts"
import ts from "typescript"

import type { ModuleMove } from "#move/types"

/**
 * Nodenext, matching every workspace's `tsconfig.json`, so this module answers what `tsc` answers.
 */
const RESOLUTION_OPTIONS: ts.CompilerOptions = {
	module: ts.ModuleKind.NodeNext,
	moduleResolution: ts.ModuleResolutionKind.NodeNext,
	allowImportingTsExtensions: true,
}

const BUILD_OUTPUT = /(?:^|\/)out\//u

export interface MoveResolver {
	/**
	 * The repo-relative source file `specifier` names when written in `containingFile`, or nothing when it resolves
	 * nowhere. Both paths are repo-relative.
	 */
	resolve(specifier: string, containingFile: string): string | undefined
}

/**
 * A resolver that answers as though every move in `moves` had already happened. Pass no moves for the resolver that
 * reads the checkout as it stands.
 */
export function createMoveResolver(repoRoot: string, moves: readonly ModuleMove[] = []): MoveResolver {
	const absolute = (path: string): string => String(resolvePath(repoRoot, path))
	const origins = new Map(moves.map((move) => [absolute(move.to), absolute(move.from)]))
	const removed = new Set(moves.map((move) => absolute(move.from)))
	const directories = new Set<string>()

	for (const move of moves) {
		const segments = move.to.split("/")

		for (let depth = 1; depth < segments.length; depth++) {
			directories.add(absolute(segments.slice(0, depth).join("/")))
		}
	}

	const fileExists = (path: string): boolean => {
		if (origins.has(path)) return true

		if (removed.has(path) || BUILD_OUTPUT.test(path)) return false

		return ts.sys.fileExists(path)
	}

	const host: ts.ModuleResolutionHost = {
		...ts.sys,
		fileExists,
		readFile: (path) => ts.sys.readFile(origins.get(path) ?? path),
		directoryExists: (path) =>
			directories.has(path) || (!BUILD_OUTPUT.test(`${path}/`) && ts.sys.directoryExists(path)),
		realpath: (path) => (origins.has(path) ? path : (ts.sys.realpath?.(path) ?? path)),
	}

	const cache = ts.createModuleResolutionCache(repoRoot, (fileName) => fileName, RESOLUTION_OPTIONS)
	const answers = new Map<string, Map<string, string | undefined>>()

	return {
		resolve(specifier, containingFile) {
			let answered = answers.get(containingFile)

			if (!answered) {
				answered = new Map<string, string | undefined>()

				answers.set(containingFile, answered)
			}

			if (answered.has(specifier)) return answered.get(specifier)

			const resolved = ts.resolveModuleName(specifier, absolute(containingFile), RESOLUTION_OPTIONS, host, cache)
				.resolvedModule?.resolvedFileName

			const source = resolved?.startsWith(`${repoRoot}/`) ? resolved.slice(repoRoot.length + 1) : resolved

			answered.set(specifier, source)

			return source
		},
	}
}
