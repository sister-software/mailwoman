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
 *   WHY THIS EXISTS (2026-08-02). `@mailwoman/neural-weights-en-in@8.6.0` published with its
 *   `files` array naming `pair-index-in.bin` — its ONLY payload, 176,086 pairs, 4.3 MB — and the
 *   tarball did not contain it. The package shipped as three metadata files describing an artifact
 *   that wasn't there. Nothing failed: `yarn pack` treats every `files` entry as a glob and a glob
 *   that matches nothing contributes nothing, silently. The binary is gitignored (derived, fetched
 *   from Hugging Face by CI) and simply wasn't materialized in the workspace the operator packed
 *   from — the CI publish path DOES fetch and `[ -s ]`-guard all thirteen indexes, but that path
 *   had already failed on `E404 PUT` (Trusted Publishing cannot CREATE a package), so the manual
 *   fallback was the unguarded one.
 *
 *   The lesson generalizes past that one file: a `files` entry is a PROMISE to the consumer, and
 *   the pack step reads it as a wish. An entry that names a literal path — not a glob — is the
 *   author stating the file exists. If it doesn't, that is a defect at pack time, and the only
 *   place to catch it is between packing and publishing, because npm accepts the tarball happily
 *   and a published version is immutable.
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

import { spawnSync } from "node:child_process"

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
 * Which literal `files` entries the tarball does not contain. Exported for tests.
 */
export function collectMissingFileEntries(files: unknown, shipped: Set<string>): string[] {
	if (!Array.isArray(files)) return []

	return files
		.filter((entry): entry is string => typeof entry === "string")
		.filter((entry) => !entry.startsWith("!") && !GLOB_PATTERN.test(entry))
		.filter((entry) => !isShipped(normalizeEntry(entry), shipped))
}

/**
 * Which concrete `exports` targets the tarball does not contain. Exported for tests.
 */
export function collectMissingExportTargets(exports: unknown, shipped: Set<string>): string[] {
	return collectExportTargets(exports ?? {}).filter((target) => !isShipped(normalizeEntry(target), shipped))
}

/**
 * Read a packed tarball's member list and its `package.json`. Throws with the tar exit status rather than a parse error
 * on a truncated or non-tarball input, so a pack failure upstream reads as a pack failure here.
 */
export function readTarball(tarballPath: string): TarballContents {
	const listing = spawnSync("tar", ["-tzf", tarballPath], { encoding: "utf8" })

	if (listing.status !== 0) {
		throw new Error(`verify-tarball: tar -tzf failed for ${tarballPath} (exit ${listing.status}): ${listing.stderr}`)
	}

	const manifestRead = spawnSync("tar", ["-xzf", tarballPath, "-O", "package/package.json"], { encoding: "utf8" })

	if (manifestRead.status !== 0) {
		throw new Error(
			`verify-tarball: could not read package.json from ${tarballPath} (exit ${manifestRead.status}): ${manifestRead.stderr}`
		)
	}

	const shipped = new Set(
		listing.stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => normalizeEntry(line.replace(/^package\//, "")))
	)

	return { manifest: JSON.parse(manifestRead.stdout), shipped }
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

	if (missingFiles.length || missingExports.length) {
		const lines = [`verify-tarball: ${name} does not contain what its manifest promises — refusing to publish:`]

		for (const entry of missingFiles) {
			lines.push(`  - files["${entry}"] is not in the tarball (declared, never packed — build or fetch it first)`)
		}

		for (const target of missingExports) {
			lines.push(`  - exports target ${target} is not in the tarball`)
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
	}
}
