/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Resolves module specifiers against the checkout, or against an overlay where a planned move has already
 *   happened.
 *
 *   The host reports every `out/` path as absent. Subpath maps list `types` first, so a built checkout would otherwise
 *   resolve to `.d.ts` files emitted from the old paths.
 */

import { resolvePath } from "path-ts"
import ts from "typescript"

import type { ModuleMove } from "#move/types"

/**
 * These options match the workspaces' `tsconfig.json` so that resolution agrees with `tsc`.
 */
const RESOLUTION_OPTIONS: ts.CompilerOptions = {
	module: ts.ModuleKind.NodeNext,
	moduleResolution: ts.ModuleResolutionKind.NodeNext,
	allowImportingTsExtensions: true,
}

const BUILD_OUTPUT = /(?:^|\/)out\//u

/**
 * Resolves specifiers to repo-relative source files.
 */
export interface MoveResolver {
	/**
	 * Returns the repo-relative file that `specifier` resolves to from the repo-relative
	 * `containingFile`, or `undefined` when it does not resolve.
	 */
	resolve(specifier: string, containingFile: string): string | undefined
}

/**
 * Creates a resolver that sees the tree as though `moves` had already happened.
 *
 * With no moves, the resolver reads the checkout as it stands.
 *
 * `contents` overrides file text by repo-relative path.
 * Callers pass the rewritten manifests here, because a subpath key keeps its name
 * after a move while its target changes.
 */
export function createMoveResolver(
	repoRoot: string,
	moves: readonly ModuleMove[] = [],
	contents: ReadonlyMap<string, string> = new Map()
): MoveResolver {
	const absolute = (path: string): string => resolvePath(repoRoot, path)
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
	 * Converts a path through a `node_modules` symlink to its real path, so it matches the overlay keys.
	 *
	 * The path may not exist yet, so the walk trims trailing segments until it reaches
	 * an existing path, resolves that, and appends the trimmed segments again.
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
