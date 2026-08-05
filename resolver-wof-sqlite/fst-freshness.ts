/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Does an `fst-*.bin` still match the gazetteer it was built from?
 *
 *   WHY THIS EXISTS. Every FST artifact is a projection of one WOF admin database, and the admin
 *   database is a sealed readonly artifact that a rebuild REPLACES. Nothing mechanically tied the two
 *   together: the 2026-08-04 admin swap (4.87M rows, ancestry repaired, macrohood/microhood ingested)
 *   left `fst-global-priority.bin` at its 2026-05-28 build and the per-locale set at 2026-07-26, and
 *   the only way to notice was to compare mtimes by hand. The artifacts kept loading, kept answering
 *   queries, and answered them from a gazetteer that no longer exists.
 *
 *   `FSTProvenance` already recorded `sourceDB` — the source's PATH, which is exactly the field that
 *   cannot change when the bytes behind it do. So the stamp gains the source's IDENTITY (md5 + byte
 *   size) and this module compares it. The shape deliberately mirrors
 *   `scripts/weights-overlay-linker.ts`'s `pairIndexStaleReason`: one function returning a reason
 *   string or `undefined`, so a fact added to the stamp cannot be checked by some callers and not
 *   others — which is how three of the four base linkers ended up unable to notice a PIX1 schema bump.
 *
 *   FORMAT IS PART OF FRESHNESS. The check compares the serializer version too, not just the source
 *   md5. A guard that checks only the source reads a format-obsolete binary as "current" (the R5
 *   freshness-guard lesson, format edition), and a file below {@link MIN_STAMPED_FORMAT_VERSION}
 *   cannot carry a stamp at all — reported as its own reason rather than silently passing.
 *
 *   STALE IS A WARNING, NOT A FAULT. A dev tree with an old FST must still run; the artifact is a
 *   decode-time bias list, not a correctness dependency. Callers print {@link formatFSTStaleWarning}
 *   and continue.
 */

import { createHash } from "node:crypto"
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs"

import { tryParsingJSON } from "@mailwoman/core/objects"

import { FST_FORMAT_VERSION } from "./fst-serialize.ts"
import type { FSTProvenance } from "./fst-types.ts"

/**
 * Fixed header size in bytes — mirrors `fst-serialize.ts`'s `HEADER_SIZE`. Duplicated rather than exported across
 * because this module reads the header by SEEK (never buffering the file), and the serializer's constant is private to
 * its own read/write pair.
 */
const HEADER_SIZE = 32

/**
 * `"FST\0"` little-endian, the four magic bytes every artifact opens with.
 */
const MAGIC = 0x00_54_53_46

/**
 * Byte offset of the u32 trailer offset inside the header (the last of its eight fields).
 */
const PROVENANCE_OFFSET_FIELD = 28

/**
 * First serializer version carrying the trailing provenance block. Below this a file has no place to put a stamp, so
 * "unstamped" is a statement about the FORMAT, not about the builder.
 */
export const MIN_STAMPED_FORMAT_VERSION = 3

/**
 * Hex characters in an md5 digest.
 */
const MD5_HEX_LENGTH = 32

/**
 * Bytes per read in {@link md5FileSync}. 8 MiB measured at 7.3 s for the 5.27 GB admin DB on the lab playpen — the same
 * throughput as `md5sum(1)`, so the sidecar below is what makes the check cheap, not the chunk size.
 */
const MD5_CHUNK_BYTES = 8 * 1024 * 1024

/**
 * What an FST was built from, recorded so a later reader can tell whether that thing still exists.
 *
 * `bytes` is not redundant with `md5` — it is the field that survives a truncated or half-written source and makes the
 * mismatch legible in the warning ("5,273,722,880 → 5,372,076,032" names the rebuild; a hex delta does not).
 */
export interface FSTSourceIdentity {
	md5: string
	bytes: number
}

/**
 * The stamp fields a freshness guard reads off an artifact, plus the format version it was written at.
 *
 * Every field is optional because every one of them can be legitimately absent on an artifact that predates it, and the
 * meaning-of-zero rule applies to all of them: absent is a distinct state from "matches", and the reasons below say so
 * in different words.
 */
export interface FSTStampFields {
	formatVersion: number
	provenance: FSTProvenance | undefined
}

/**
 * What a caller expects the artifact to have been built from.
 *
 * `exclusionPolicy` is optional and caller-supplied on purpose. The policy id lives in
 * `mailwoman/gazetteer-pipeline/fst.ts` (which depends on this package, not the other way round), so only the caller
 * knows which policy it means — the same split as the pair-index guard, where the format+magnitude half is shared and
 * the source-md5 half stays with the script that knows its sources.
 */
export interface FSTExpectation {
	source: FSTSourceIdentity
	/**
	 * Serializer version to require. Defaults to {@link FST_FORMAT_VERSION} — the version this tree writes — so a caller
	 * cannot forget the format half of the comparison. Override only to check against a specific older floor.
	 */
	formatVersion?: number
	exclusionPolicy?: string
}

/**
 * Read an artifact's stamp WITHOUT deserializing it — a header seek plus the trailer, three reads totalling a few
 * kilobytes. The distinction matters: `fst-global-priority.bin` is 317 MB and this runs on every `yarn test` via the
 * weights linkers, so `readFileSync` + `readFSTProvenance` would trade a freshness guard for a slower test suite and
 * nobody would keep it.
 *
 * Returns `undefined` for a file that is absent, too small, or not an FST at all — none of which is this function's
 * business to diagnose.
 */
export function peekFSTStampFields(path: string): FSTStampFields | undefined {
	if (!existsSync(path)) return undefined
	const size = statSync(path).size

	if (size < HEADER_SIZE) return undefined
	const fd = openSync(path, "r")

	try {
		const header = Buffer.alloc(HEADER_SIZE)
		readSync(fd, header, 0, HEADER_SIZE, 0)

		if (header.readUInt32LE(0) !== MAGIC) return undefined
		const formatVersion = header.readUInt16LE(4)

		if (formatVersion < MIN_STAMPED_FORMAT_VERSION) return { formatVersion, provenance: undefined }
		const trailerStart = header.readUInt32LE(PROVENANCE_OFFSET_FIELD)

		// 0 = "this build wrote no trailer" (the serializer's own encoding); anything past EOF is a
		// truncated file. Both read as "no stamp", which is what the caller does with them anyway.
		if (trailerStart === 0 || trailerStart + 4 > size) return { formatVersion, provenance: undefined }

		const lengthBytes = Buffer.alloc(4)
		readSync(fd, lengthBytes, 0, 4, trailerStart)
		const jsonLength = lengthBytes.readUInt32LE(0)

		if (jsonLength === 0 || trailerStart + 4 + jsonLength > size) return { formatVersion, provenance: undefined }

		const json = Buffer.alloc(jsonLength)
		readSync(fd, json, 0, jsonLength, trailerStart + 4)

		return { formatVersion, provenance: tryParsingJSON<FSTProvenance>(json.toString("utf8")) ?? undefined }
	} finally {
		closeSync(fd)
	}
}

/**
 * Streaming MD5 of a file, SYNCHRONOUS.
 *
 * The async `md5File` in `@mailwoman/core/utils` is the one to reach for anywhere else. This exists because the FST
 * builder and its whole call chain are synchronous by design (`buildFSTFromWOF` → `buildLocaleFSTs`), and making them
 * async to stamp a checksum would cascade through the Pastel commands and the tests for one hash. It reads in
 * {@link MD5_CHUNK_BYTES} chunks rather than `readFileSync` — the source is a multi-gigabyte database.
 */
export function md5FileSync(path: string): string {
	const hash = createHash("md5")
	const fd = openSync(path, "r")

	try {
		const chunk = Buffer.alloc(MD5_CHUNK_BYTES)

		for (;;) {
			const read = readSync(fd, chunk, 0, MD5_CHUNK_BYTES, null)

			if (read <= 0) break
			hash.update(chunk.subarray(0, read))
		}
	} finally {
		closeSync(fd)
	}

	return hash.digest("hex")
}

/**
 * The source identity an FST build should stamp, or a check should compare against.
 *
 * Uses the `.md5` sidecar convention the weights linkers already established on this exact file: `<path>.md5` in
 * md5sum(1) format (`<hash> <filename>`), trusted only while its mtime is at least the source's. An older sidecar is
 * recomputed. Without it the admin DB costs 7.3 s per call and the guard would be quietly disabled by whoever noticed
 * `yarn test` got slower.
 *
 * `refreshSidecar` writes the recomputed digest back. Best-effort: a sealed data root or a read-only mount fails the
 * write and the caller still gets its answer, because refusing to check freshness on a read-only tree would be the
 * wrong trade.
 */
export function readWOFSourceIdentity(path: string, { refreshSidecar = true } = {}): FSTSourceIdentity {
	const stats = statSync(path)
	const memoKey = `${path}\0${stats.mtimeMs}\0${stats.size}`
	const hit = sourceIdentityMemo.get(memoKey)

	if (hit) return hit
	const sidecarPath = `${path}.md5`
	let md5: string | undefined

	if (existsSync(sidecarPath)) {
		const sidecarStats = statSync(sidecarPath)

		if (sidecarStats.mtimeMs >= stats.mtimeMs) {
			const [hash] = readFileSync(sidecarPath, "utf8").trim().split(/\s+/)

			if (hash && hash.length === MD5_HEX_LENGTH) {
				md5 = hash
			}
		}
	}

	if (!md5) {
		md5 = md5FileSync(path)

		if (refreshSidecar) {
			try {
				writeFileSync(sidecarPath, `${md5}  ${path.split("/").pop()}\n`)
			} catch {
				// Read-only data root — the digest is still correct, it just isn't cached.
			}
		}
	}

	const identity: FSTSourceIdentity = { md5, bytes: stats.size }
	sourceIdentityMemo.set(memoKey, identity)

	return identity
}

/**
 * Memo for {@link readWOFSourceIdentity}, keyed on (path, mtimeMs, size) — NOT on path alone, for the same reason
 * `computeSurfaceCountryCounts` isn't: the admin DB is a sealed artifact that a rebuild REPLACES, so a path-only memo
 * would serve a stale digest against a new file for the life of the process.
 */
const sourceIdentityMemo = new Map<string, FSTSourceIdentity>()

/**
 * Why an FST artifact is stale against `expected`, or `undefined` when it still matches.
 *
 * The order is deliberate: FORMAT first (a version-obsolete file is stale whatever its source says), then the presence
 * of a stamp, then the source identity, then the build policy. Each returns prose a reader can act on — the reasons are
 * printed verbatim into {@link formatFSTStaleWarning}.
 */
export function fstStaleReason(fields: FSTStampFields | undefined, expected: FSTExpectation): string | undefined {
	if (!fields) return "unreadable or not an FST artifact"
	const requiredFormat = expected.formatVersion ?? FST_FORMAT_VERSION

	if (fields.formatVersion < requiredFormat) {
		return `format v${fields.formatVersion} → v${requiredFormat}`
	}

	if (fields.formatVersion < MIN_STAMPED_FORMAT_VERSION) {
		return `format v${fields.formatVersion} predates the build stamp (needs v${MIN_STAMPED_FORMAT_VERSION}+)`
	}

	const provenance = fields.provenance

	if (!provenance) return "carries no build stamp"

	if (!provenance.sourceDBMD5) {
		return `built ${provenance.builtAt} with no source checksum — rebuild to stamp one`
	}

	if (provenance.sourceDBMD5 !== expected.source.md5) {
		return `source db ${provenance.sourceDBMD5.slice(0, 8)} → ${expected.source.md5.slice(0, 8)} (built ${provenance.builtAt})`
	}

	// Reached only when the md5s agree, so a size disagreement means one of the two was recorded
	// against a different file than it was hashed from. Cheap to check, and it never fires by accident.
	if (provenance.sourceDBBytes !== undefined && provenance.sourceDBBytes !== expected.source.bytes) {
		return `source db size ${provenance.sourceDBBytes} → ${expected.source.bytes} at a matching md5 — one of the two is misrecorded`
	}

	if (expected.exclusionPolicy !== undefined && provenance.exclusionPolicy !== expected.exclusionPolicy) {
		return `exclusion policy ${provenance.exclusionPolicy ?? "(none)"} → ${expected.exclusionPolicy}`
	}

	return undefined
}

/**
 * The whole check, for a caller that has a path and a source DB and wants a warning string or nothing.
 *
 * Returns `undefined` when the artifact is current OR when it is absent — an absent artifact is a different problem
 * with a different message, and every existing caller already reports it in place.
 */
export function fstFreshnessWarning({
	fstPath,
	sourceDBPath,
	formatVersion,
	exclusionPolicy,
	rebuildCommand,
}: {
	fstPath: string
	sourceDBPath: string
	formatVersion?: number
	exclusionPolicy?: string
	rebuildCommand: string
}): string | undefined {
	if (!existsSync(fstPath) || !existsSync(sourceDBPath)) return undefined

	const reason = fstStaleReason(peekFSTStampFields(fstPath), {
		source: readWOFSourceIdentity(sourceDBPath),
		...(formatVersion === undefined ? {} : { formatVersion }),
		...(exclusionPolicy === undefined ? {} : { exclusionPolicy }),
	})

	return reason === undefined ? undefined : formatFSTStaleWarning({ fstPath, reason, rebuildCommand })
}

/**
 * The one warning format, so `grep -r "FST STALE"` finds every site that can emit one.
 */
export function formatFSTStaleWarning({
	fstPath,
	reason,
	rebuildCommand,
}: {
	fstPath: string
	reason: string
	rebuildCommand: string
}): string {
	return `WARNING: FST STALE — ${fstPath}: ${reason}. Rebuild with: ${rebuildCommand}`
}
