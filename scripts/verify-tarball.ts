/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The pre-publish tarball audit: prove a packed workspace actually CONTAINS what its manifest
 *   promises, before the bytes leave this machine. Two independent guards, one entry point, shared
 *   by every publish path (`publish-workspace.ts` for releases, `bless-package.ts` for the
 *   first-publish bootstrap).
 *
 *   The gap this closes: `yarn pack` treats every `files` entry as a glob, and a glob matching
 *   nothing contributes nothing, SILENTLY. A workspace whose derived binaries were never built
 *   therefore packs to a tarball of metadata describing artifacts that are not in it, and npm
 *   accepts it. Published versions are immutable, so between packing and publishing is
 *   the only place the mistake is still recoverable.
 *
 *   A literal (non-glob) `files` entry is the author stating a file exists. Treat its absence as a
 *   defect rather than an empty match.
 *
 *   WHAT IS CHECKED:
 *
 *   1. Every LITERAL `files` entry resolves inside the tarball. Globs are skipped — they are
 *        legitimately allowed to match nothing (`**\/*.ts` in a data-only package) — as are the
 *        `!`-negations. A directory entry is satisfied by any member beneath it.
 *   2. Every concrete `exports` target resolves inside the tarball (the pre-existing guard, moved
 *        here from `publish-workspace.ts` so both publish paths inherit it). It would have caught
 *        the v7.2.0 ship-break: exports pointing at files the `files` globs excluded.
 */

import { isPresent, parseJSONStrict } from "@mailwoman/core/objects"
import { spawnProcessSync } from "@mailwoman/core/process"
import { TextSpliterator } from "spliterator"

import { collectExportTargets } from "./publish-exports.ts"

/**
 * Glob metacharacters. An entry carrying any of these is a pattern, and a pattern matching nothing is legal — only
 * literal paths are promises we can hold the author to.
 */
const GLOB_PATTERN = /[*?[\]{}]/

export interface TarballContents {
	manifest: {
		name?: string
		files?: unknown
		exports?: unknown
		imports?: unknown
		bin?: unknown
	}
	/**
	 * Every path in the tarball, `./`-relative to the package root (tar's `package/` prefix stripped).
	 */
	shipped: Set<string>
}

/**
 * Normalize a `files` entry or tarball member to one comparable form: `./`-prefixed, no trailing slash.
 */
function normalizeEntry(entry: string): string {
	const trimmed = entry.replace(/\/+$/, "")

	if (trimmed.startsWith("./")) return trimmed

	return `./${trimmed.replace(/^\/+/, "")}`
}

/**
 * True when `entry` names something present in the tarball — either the exact path, or a directory with at least one
 * member beneath it (`out/` is satisfied by `./out/index.js`; tar may or may not list the directory itself).
 */
function isShipped(entry: string, shipped: Set<string>): boolean {
	if (shipped.has(entry)) return true

	const prefix = `${entry}/`

	for (const path of shipped) {
		if (path.startsWith(prefix)) return true
	}

	return false
}

/**
 * A manifest's LITERAL `files` entries — the ones whose author is stating a file exists, with the globs and the
 * `!`-negations dropped.
 *
 * Shared with `fetch-hf-weights.ts`, which materializes exactly the entries this audit later refuses a publish over.
 * Sharing the predicate rather than restating it is what keeps the two from disagreeing about what counts as a promise:
 * a materializer with a looser rule stages files nothing checks, and one with a stricter rule leaves a declared
 * artifact for the audit to find at publish time.
 */
export function literalFilesEntries(files: unknown): string[] {
	if (!Array.isArray(files)) return []

	return files
		.filter((entry): entry is string => typeof entry === "string")
		.filter((entry) => !entry.startsWith("!") && !GLOB_PATTERN.test(entry))
}

/**
 * Which literal `files` entries the tarball does not contain. Exported for tests.
 */
export function collectMissingFileEntries(files: unknown, shipped: Set<string>): string[] {
	return literalFilesEntries(files).filter((entry) => !isShipped(normalizeEntry(entry), shipped))
}

/**
 * Which concrete `exports` targets the tarball does not contain. Exported for tests.
 */
export function collectMissingExportTargets(exports: unknown, shipped: Set<string>): string[] {
	return collectExportTargets(exports ?? {}).filter((target) => !isShipped(normalizeEntry(target), shipped))
}

/**
 * Which concrete package-import targets are absent from the tarball.
 */
export function collectMissingImportTargets(imports: unknown, shipped: Set<string>): string[] {
	return collectExportTargets(imports ?? {}).filter((target) => !isShipped(normalizeEntry(target), shipped))
}

/**
 * Every path a `bin` field promises — npm accepts both the string form (`"bin": "./out/cli.js"`) and the map form.
 */
function collectBinTargets(bin: unknown): string[] {
	if (typeof bin === "string") return [bin]

	if (!bin || typeof bin !== "object") return []

	return Object.values(bin as Record<string, unknown>).filter((target): target is string => typeof target === "string")
}

/**
 * Which `bin` targets the tarball does not contain. Exported for tests.
 *
 * The same promise an `exports` target makes, and the same silent failure when it is broken: `files` globs decide what
 * is packed, `bin` decides what npm symlinks onto the user's PATH, and nothing reconciles the two. A workspace whose
 * `out/` was never built packs fine, publishes fine, and then `npx <pkg>` dies with ENOENT on a path the manifest
 * itself named.
 */
export function collectMissingBinTargets(bin: unknown, shipped: Set<string>): string[] {
	return collectBinTargets(bin).filter((target) => !isShipped(normalizeEntry(target), shipped))
}

/**
 * Read a packed tarball's member list and its `package.json`. Throws with the tar exit status rather than a parse error
 * on a truncated or non-tarball input, so a pack failure upstream reads as a pack failure here.
 */
export function readTarball(tarballPath: string): TarballContents {
	const listing = spawnProcessSync("tar", ["-tzf", tarballPath], { encoding: "utf8" })

	if (listing.status !== 0) {
		throw new Error(`verify-tarball: tar -tzf failed for ${tarballPath} (exit ${listing.status}): ${listing.stderr}`)
	}

	const manifestRead = spawnProcessSync("tar", ["-xzf", tarballPath, "-O", "package/package.json"], {
		encoding: "utf8",
	})

	if (manifestRead.status !== 0) {
		throw new Error(
			`verify-tarball: could not read package.json from ${tarballPath} (exit ${manifestRead.status}): ${manifestRead.stderr}`
		)
	}

	const shipped = new Set(
		[...TextSpliterator.from(listing.stdout)]
			.filter(isPresent)
			.map((line) => normalizeEntry(line.replace(/^package\//, "")))
	)

	return { manifest: parseJSONStrict<TarballContents["manifest"]>(manifestRead.stdout), shipped }
}

export interface TarballAudit {
	name: string
	/**
	 * Literal (non-glob, non-negated) `files` entries verified present.
	 */
	literalFiles: number
	/**
	 * Concrete `exports` targets verified present.
	 */
	exportTargets: number
	/**
	 * `bin` targets verified present.
	 */
	binTargets: number
}

/**
 * Audit a packed tarball; throw with every violation listed if it does not contain what it promises.
 *
 * Callers publish only when this returns. It is deliberately a throw rather than a boolean: there is no partial pass,
 * and a published version cannot be taken back.
 */
export function verifyTarball(tarballPath: string): TarballAudit {
	const { manifest, shipped } = readTarball(tarballPath)
	const name = manifest.name ?? tarballPath
	const missingFiles = collectMissingFileEntries(manifest.files, shipped)
	const missingExports = collectMissingExportTargets(manifest.exports, shipped)
	const missingImports = collectMissingImportTargets(manifest.imports, shipped)
	const missingBins = collectMissingBinTargets(manifest.bin, shipped)

	if (missingFiles.length || missingExports.length || missingImports.length || missingBins.length) {
		const lines = [`verify-tarball: ${name} does not contain what its manifest promises — refusing to publish:`]

		for (const entry of missingFiles) {
			lines.push(`  - files["${entry}"] is not in the tarball (declared, never packed — build or fetch it first)`)
		}

		for (const target of missingExports) {
			lines.push(`  - exports target ${target} is not in the tarball`)
		}

		for (const target of missingImports) {
			lines.push(`  - imports target ${target} is not in the tarball`)
		}

		for (const target of missingBins) {
			lines.push(`  - bin target ${target} is not in the tarball (npm would PATH-link a file that isn't there)`)
		}

		throw new Error(lines.join("\n"))
	}

	return {
		name,
		literalFiles: (Array.isArray(manifest.files) ? manifest.files : []).filter(
			(entry: unknown): entry is string =>
				typeof entry === "string" && !entry.startsWith("!") && !GLOB_PATTERN.test(entry)
		).length,
		exportTargets: collectExportTargets(manifest.exports ?? {}).length,
		binTargets: collectBinTargets(manifest.bin).length,
	}
}
