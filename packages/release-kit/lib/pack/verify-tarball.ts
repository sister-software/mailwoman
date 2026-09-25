/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { parseJSONStrict } from "@mailwoman/core/json"
import { isPresent } from "@mailwoman/core/objects"
import { spawnProcessSync } from "@mailwoman/core/process"
import type { PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

import { collectExportTargets } from "#pack/publish/exports"

const GLOB_PATTERN = /[*?[\]{}]/

interface TarballContents {
	manifest: {
		name?: string
		files?: unknown
		exports?: unknown
		imports?: unknown
		bin?: unknown
	}

	shipped: Set<string>
}

function normalizeEntry(entry: string): string {
	const trimmed = entry.replace(/\/+$/, "")

	if (trimmed.startsWith("./")) return trimmed

	return `./${trimmed.replace(/^\/+/, "")}`
}

function isShipped(entry: string, shipped: Set<string>): boolean {
	if (shipped.has(entry)) return true

	const prefix = `${entry}/`

	for (const path of shipped) {
		if (path.startsWith(prefix)) return true
	}

	return false
}

/**
 * Returns a manifest's literal `files` entries, dropping globs and `!` negations.
 *
 * The Hugging Face weights fetch plan shares this predicate so that it materializes
 * exactly the entries this audit later requires.
 */
export function literalFilesEntries(files: unknown): string[] {
	if (!Array.isArray(files)) return []

	return files
		.filter((entry): entry is string => typeof entry === "string")
		.filter((entry) => !entry.startsWith("!") && !GLOB_PATTERN.test(entry))
}

/**
 * Returns the literal `files` entries that the tarball does not contain.
 */
export function collectMissingFileEntries(files: unknown, shipped: Set<string>): string[] {
	return literalFilesEntries(files).filter((entry) => !isShipped(normalizeEntry(entry), shipped))
}

/**
 * Returns the concrete `exports` targets that the tarball does not contain.
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

function collectBinTargets(bin: unknown): string[] {
	if (typeof bin === "string") return [bin]

	if (!bin || typeof bin !== "object") return []

	return Object.values(bin as Record<string, unknown>).filter((target): target is string => typeof target === "string")
}

/**
 * Returns the `bin` targets that the tarball does not contain.
 *
 * Nothing else reconciles `bin` with `files`, so an unbuilt target would publish cleanly
 * and fail only when a user runs it.
 */
export function collectMissingBinTargets(bin: unknown, shipped: Set<string>): string[] {
	return collectBinTargets(bin).filter((target) => !isShipped(normalizeEntry(target), shipped))
}

function readTarball(tarballPath: PathBuilderLike): TarballContents {
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

/**
 * Counts the manifest promises that {@link verifyTarball} checked in a tarball that passed.
 */
export interface TarballAudit {
	name: string

	/**
	 * The number of `files` entries checked, excluding globs and `!` negations.
	 */
	literalFiles: number

	/**
	 * The number of `exports` targets checked, excluding wildcard patterns.
	 */
	exportTargets: number

	/**
	 * The number of `bin` targets checked.
	 */
	binTargets: number
}

/**
 * Audits a packed tarball against its manifest's `files`, `exports`, `imports`
 * and `bin` entries, throwing with every missing path listed.
 *
 * Callers publish only when this returns, because a published version cannot be withdrawn.
 */
export function verifyTarball(tarballPath: PathBuilderLike): TarballAudit {
	const { manifest, shipped } = readTarball(tarballPath)
	const name = manifest.name ?? tarballPath.toString()
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
		literalFiles: literalFilesEntries(manifest.files).length,
		exportTargets: collectExportTargets(manifest.exports ?? {}).length,
		binTargets: collectBinTargets(manifest.bin).length,
	}
}

/**
 * Formats the audit summary line that every publish path prints.
 */
export function formatTarballAudit(audit: Pick<TarballAudit, "literalFiles" | "exportTargets" | "binTargets">): string {
	return `${audit.literalFiles} literal files, ${audit.exportTargets} export targets, ${audit.binTargets} bin targets`
}
