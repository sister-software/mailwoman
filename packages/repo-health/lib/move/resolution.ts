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
 * A resolver that answers as though the whole plan had already happened. Pass no moves for the resolver that reads the
 * checkout as it stands.
 *
 * `contents` overrides what a file reads as, keyed by repo-relative path. The manifests belong in it: a subpath KEY
 * survives a move while its target changes, so `@mailwoman/core/decoder/serialize-json` still names the moved file
 * afterwards — and a resolver reading the manifest as it stands would report that specifier unrepointable and refuse a
 * plan that is in fact complete.
 */
export function createMoveResolver(
	repoRoot: string,
	moves: readonly ModuleMove[] = [],
	contents: ReadonlyMap<string, string> = new Map()
): MoveResolver {
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

	const overridden = new Map([...contents].map(([path, text]) => [absolute(path), text]))
	const canonicalized = new Map<string, string>()

	/**
	 * The real path a probe names, for a probe that goes through a symlink.
	 *
	 * A workspace is reached as `node_modules/@mailwoman/x/…`, which is a different string for the same file — and for a
	 * file the plan has not written yet, `realpath` cannot answer at all, because nothing is there to resolve. So the
	 * walk trims trailing segments until it reaches something that exists, resolves THAT, and puts the trimmed segments
	 * back. Every overlay entry is keyed by a real path, and this is what lets a probe find one.
	 */
	const canonical = (path: string): string => {
		if (!path.includes("/node_modules/")) return path

		const cached = canonicalized.get(path)

		if (cached) return cached

		const trimmed: string[] = []
		let head = path

		while (head.includes("/") && !ts.sys.fileExists(head) && !ts.sys.directoryExists(head)) {
			const slash = head.lastIndexOf("/")

			trimmed.unshift(head.slice(slash + 1))
			head = head.slice(0, slash)
		}

		const real = ts.sys.realpath?.(head) ?? head
		const answer = trimmed.length ? `${real}/${trimmed.join("/")}` : real

		canonicalized.set(path, answer)

		return answer
	}

	const fileExists = (path: string): boolean => {
		const real = canonical(path)

		if (origins.has(real)) return true

		if (removed.has(real) || BUILD_OUTPUT.test(real)) return false

		return ts.sys.fileExists(path)
	}

	const host: ts.ModuleResolutionHost = {
		...ts.sys,
		fileExists,
		readFile: (path) => {
			const real = canonical(path)

			return overridden.get(real) ?? ts.sys.readFile(origins.get(real) ?? path)
		},
		directoryExists: (path) =>
			directories.has(canonical(path)) || (!BUILD_OUTPUT.test(`${path}/`) && ts.sys.directoryExists(path)),
		realpath: (path) => {
			const real = canonical(path)

			return origins.has(real) ? real : (ts.sys.realpath?.(path) ?? path)
		},
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
