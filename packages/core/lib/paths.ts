/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Path homes: the repo root, the data root, the package roots.
 *
 *   Extracted from `core/utils` (2026-09): a shelf is not a home, and these two modules carried 366 of
 *   ~540 consumer references through that door — 68% of everything `@mailwoman/core/utils` was asked for.
 *   `repo` and `data-root` also reference each other, which made them the shelf's only internal edge.
 */
import {
	createPathBuilderResolver,
	createPathResolver,
	dirname,
	type Join,
	type PathBuilder,
	resolvePath,
} from "path-ts"

import { fileURLToPath } from "#module/file-url"
/**
 * Aliased path to the root of the repository.
 *
 * @typedef {"mailwoman"} RepoRootAlias
 */

/**
 * Compiled directory name for TS output files.
 */
export const OutDirectoryName = "out"

export type OutDirectoryName = typeof OutDirectoryName

const RepoRootAlias = "mailwoman" as const

type RepoRootAlias = typeof RepoRootAlias

// Depth shared by BOTH trees: this file sits at `core/lib/paths.ts` and its emit at
// `core/out/paths.js`, so "lib" here is the sibling of "out". Count from repo root to the FILE'S
// DIRECTORY: packages/core/lib is 3. The ancestor this file was extracted from sat one level deeper
// (packages/core/utils, 4) and its reflection still had "out" written where this has "lib".
const PathReflection = ["packages", "core", "lib"] as const

type PathReflection = typeof PathReflection

/**
 * The directory path of the current file, post-compilation.
 */
// `import.meta.url`, not `import.meta.dirname`: the Docusaurus config loader (jiti 1.x, a CommonJS transform) rewrites
// only `import.meta.url`, and this module sits on that loader's import path through `@mailwoman/core/utils`.
const __dirname = dirname(fileURLToPath(import.meta.url)) as Join<[RepoRootAlias, ...PathReflection], "/">

/**
 * The absolute path to the root of the repository.
 *
 * THERE IS NO SOURCE/COMPILED BRANCH HERE ANY MORE, and that is a property of the layout rather than a simplification
 * anyone is free to undo. Source lives at `core/lib/paths.ts` and its emit at `core/out/paths.js`: `lib/` and `out/`
 * are SIBLINGS, so both trees put this file at the same depth and one constant serves both. If this file moves to a
 * different depth, {@link PathReflection} must move with it — the dictionary-path failure that followed the 2026-09
 * extraction was this constant counting the OLD depth.
 *
 * Before source moved under `lib/`, source sat one level shallower than its own output and this file carried an
 * `__isCompiledTree` flag — `basename(resolvePath(__dirname, "..")) === "out"` — to pick between two `__upCount`s and
 * two {@link CorePackageAbsolutePath} spellings. That flag was wrong in production once: it checked `resolvePath("..",
 * "..")`, which overshoots `out/` to `core/` and so was ALWAYS false, resolving {@link CorePackageAbsolutePath} to
 * `core/out` in the compiled tree and landing dictionary reads at the nonexistent `core/out/data` (#481). Equal depth
 * removes the branch that bug lived in.
 *
 * If a future layout change breaks that equality — moving this file to a different depth under `lib/`, or pointing
 * `outDir` somewhere that is not a sibling of `lib/` — the fix is to restore the equality, not to reintroduce the flag.
 * {@link PathReflection} is the single declaration of that shared depth.
 *
 * WHY NOT NATIVE RESOLUTION (2026-08-05 triage, still current). `node:module`'s `findPackageJSON` would compute
 * {@link CorePackageAbsolutePath} without any arithmetic, but it cannot name {@link RepoRootAbsolutePath} — the
 * MONOREPO root is not a package on any resolution path from here — so the arithmetic survives regardless. It would
 * also break the demo bundle: this module is reachable from a BUNDLED graph (`core/resources/libpostal.ts` imports it
 * and `@mailwoman/core/resources` is a webpack alias), and that build maps every `node:` specifier to an empty shim
 * (`docs/plugins/demo-assets/plugin.ts` lists `node:module` beside `node:path` and `node:url`). A shimmed builtin fails
 * SILENTLY — the import succeeds and the binding is `undefined` — so a `node:module` call here would be an undefined
 * call at module top level rather than a resolution error someone sees. Keep the string arithmetic.
 */
const __upCount = PathReflection.length
const RepoRootAbsolutePath = resolvePath(__dirname, ...Array.from({ length: __upCount }, () => ".."))
const PackagesAbsolutePath = resolvePath(RepoRootAbsolutePath, "packages")

type RepoRootAbsolutePath = RepoRootAlias

/**
 * Path builder relative to the repo root.
 */
export const repoRootPathBuilder = createPathBuilderResolver<RepoRootAlias>(RepoRootAbsolutePath)

/**
 * Absolute-path-string resolver relative to the repo root — the string-returning sibling of {@link repoRootPathBuilder},
 * for handing paths straight to `node:fs` and other string APIs without a `.toString()`.
 */
export const repoRootPath = createPathResolver<RepoRootAlias>(RepoRootAbsolutePath)

/**
 * Path builder relative to the directory containing the public workspaces.
 */
export const workspacePathBuilder = createPathBuilderResolver<RepoRootAlias>(PackagesAbsolutePath)

/**
 * Absolute-path-string resolver relative to the directory containing the public workspaces.
 */
export const workspacePath = createPathResolver<RepoRootAlias>(PackagesAbsolutePath)

/**
 * Path builder relative to the `@mailwoman/core` workspace root (the directory containing `package.json` for this
 * package).
 *
 * Two levels up in BOTH trees — `core/lib/utils/repo.ts` and `core/out/utils/repo.js` both sit under a direct child of
 * `core/` — which is why this takes a fixed `".."` pair rather than the mode-dependent third segment it used to carry.
 * See the note on {@link RepoRootAbsolutePath} for why that branch is gone.
 *
 * Used to locate package-bundled assets (dictionary data) that live under the workspace root, NOT the repo root — so
 * that `npm install @mailwoman/core` ships those assets alongside the JS without any post-install copy step.
 */
const CorePackageAbsolutePath = resolvePath(__dirname, "..")
/**
 * Path builder rooted at `@mailwoman/core`, so data under `core/data/` resolves the same in source and compiled trees.
 * See the `__isCompiledTree` note in this file before reaching across that boundary.
 */
export const corePackagePathBuilder = createPathBuilderResolver<RepoRootAlias>(CorePackageAbsolutePath)

/**
 * Absolute-path-string resolver relative to the `@mailwoman/core` workspace root — the string-returning sibling of
 * {@link corePackagePathBuilder}.
 */
export const corePackagePath = createPathResolver<RepoRootAlias>(CorePackageAbsolutePath)

/**
 * Path builder relative to a specific package's output directory.
 */
export function tsOutPathBuilder<S extends string[]>(
	...pathSegments: S
): PathBuilder<Join<[RepoRootAlias, OutDirectoryName, ...S], "/">> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return repoRootPathBuilder(OutDirectoryName, ...pathSegments) as any
}

export type AddressResource = "chromium-i18n/ssl-address" | "libpostal" | "internal"

/**
 * Path builder relative to a address resource dictionary directory.
 *
 * Data lives at `core/data/<resource>/dictionaries/...` so the @mailwoman/core npm package ships dictionaries via its
 * `files` glob. Use {@link corePackagePathBuilder} directly for non- dictionary assets (e.g. chromium-i18n/ssl-address)
 * that don't have the `dictionaries/` subdir.
 */
export function resourceDictionaryPathBuilder<A extends AddressResource, S extends string[]>(
	resource: A,
	...pathSegments: S
) {
	return corePackagePathBuilder("data", resource, "dictionaries", ...pathSegments)
}

/**
 * Absolute-path-string resolver for an address resource dictionary directory — the string-returning sibling of
 * {@link resourceDictionaryPathBuilder}.
 */
export function resourceDictionaryPath<A extends AddressResource, S extends string[]>(resource: A, ...pathSegments: S) {
	return corePackagePath("data", resource, "dictionaries", ...pathSegments)
}

/**
 * Absolute path to the test directory.
 */
export const functionTestsDirectory = repoRootPathBuilder("test")
