/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Does an `fst-*.bin` still match the gazetteer it was built from?
 */

import { pathExists, readFileRange, readLocalTextFile, statPath } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { md5File } from "@mailwoman/core/hash"
import { tryParsingJSON } from "@mailwoman/core/json"
import { basename, resolvePath, type PathBuilderLike } from "path-ts"

import { FST_FORMAT_VERSION } from "#fst/serialize"
import type { FSTProvenance } from "#fst/types"

/**
 * Fixed header size in bytes, mirroring `fst-serialize.ts`'s private `HEADER_SIZE`.
 */
const HEADER_SIZE = 32

/**
 * `"FST\0"` little-endian, the four bytes every artifact opens with.
 */
const MAGIC = 0x00_54_53_46

const PROVENANCE_OFFSET_FIELD = 28

/**
 * First serializer version carrying the trailing provenance block. below it
 * a file has no place to put a stamp.
 */
export const MIN_STAMPED_FORMAT_VERSION = 3

const MD5_HEX_LENGTH = 32

/**
 * What an FST was built from, recorded so a later reader can tell whether that thing still exists.
 */
export interface FSTSourceIdentity {
	md5: string
	bytes: number
}

/**
 * The stamp fields a freshness guard reads off an artifact, plus the format version it was written at.
 */
export interface FSTStampFields {
	formatVersion: number
	provenance: FSTProvenance | undefined
}

/**
 * What a caller expects the artifact to have been built from.
 */
export interface FSTExpectation {
	source: FSTSourceIdentity
	/**
	 * Serializer version to require, defaulting to {@link FST_FORMAT_VERSION}.
	 */
	formatVersion?: number
	exclusionPolicy?: string
}

/**
 * Read an artifact's stamp without deserializing it.
 */
export async function peekFSTStampFields(path: PathBuilderLike): Promise<FSTStampFields | undefined> {
	if (!(await pathExists(path))) return undefined
	const size = (await statPath(path)).size

	if (size < HEADER_SIZE) return undefined
	const header = await readFileRange(path, 0, HEADER_SIZE)

	if (header.readUInt32LE(0) !== MAGIC) return undefined
	const formatVersion = header.readUInt16LE(4)

	if (formatVersion < MIN_STAMPED_FORMAT_VERSION) return { formatVersion, provenance: undefined }
	const trailerStart = header.readUInt32LE(PROVENANCE_OFFSET_FIELD)

	// 0 means this build wrote no trailer and past-EOF means truncated.
	// Both read as no stamp.
	if (trailerStart === 0 || trailerStart + 4 > size) return { formatVersion, provenance: undefined }

	const jsonLength = (await readFileRange(path, trailerStart, 4)).readUInt32LE(0)

	if (jsonLength === 0 || trailerStart + 4 + jsonLength > size) return { formatVersion, provenance: undefined }

	const json = await readFileRange(path, trailerStart + 4, jsonLength)

	return { formatVersion, provenance: tryParsingJSON<FSTProvenance>(json.toString("utf8")) ?? undefined }
}

/**
 * The source identity an FST build should stamp, or a check should compare against.
 */
export async function readWOFSourceIdentity(
	source: PathBuilderLike,
	{ refreshSidecar = true } = {}
): Promise<FSTSourceIdentity> {
	const path = resolvePath(source)
	const stats = await statPath(path)
	const memoKey = `${path}\0${stats.mtimeMs}\0${stats.size}`
	const hit = sourceIdentityMemo.get(memoKey)

	if (hit) return hit
	const sidecarPath = `${path}.md5`
	let md5: string | undefined

	if (await pathExists(sidecarPath)) {
		const sidecarStats = await statPath(sidecarPath)

		if (sidecarStats.mtimeMs >= stats.mtimeMs) {
			const [hash] = (await readLocalTextFile(sidecarPath)).trim().split(/\s+/)

			if (hash && hash.length === MD5_HEX_LENGTH) {
				md5 = hash
			}
		}
	}

	if (!md5) {
		md5 = await md5File(path)

		if (refreshSidecar) {
			try {
				await writeLocalTextFile(`${md5}  ${basename(path)}\n`, sidecarPath)
			} catch {
				// Read-only data root: the digest is still correct, only the cache write failed.
			}
		}
	}

	const identity: FSTSourceIdentity = { md5, bytes: stats.size }
	sourceIdentityMemo.set(memoKey, identity)

	return identity
}

const sourceIdentityMemo = new Map<string, FSTSourceIdentity>()

/**
 * Why an FST artifact is stale against `expected`, or `undefined` when it still matches.
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

	if (provenance.sourceDBBytes !== undefined && provenance.sourceDBBytes !== expected.source.bytes) {
		return `source db size ${provenance.sourceDBBytes} → ${expected.source.bytes} at a matching md5 — one of the two is misrecorded`
	}

	if (expected.exclusionPolicy !== undefined && provenance.exclusionPolicy !== expected.exclusionPolicy) {
		return `exclusion policy ${provenance.exclusionPolicy ?? "(none)"} → ${expected.exclusionPolicy}`
	}

	return undefined
}

/**
 * The whole check, for a caller with a path and a source DB that wants a warning string or none.
 */
export async function fstFreshnessWarning({
	fstPath,
	sourceDBPath,
	formatVersion,
	exclusionPolicy,
	rebuildCommand,
}: {
	fstPath: PathBuilderLike
	sourceDBPath: PathBuilderLike
	formatVersion?: number
	exclusionPolicy?: string
	rebuildCommand: string
}): Promise<string | undefined> {
	if (!(await pathExists(fstPath)) || !(await pathExists(sourceDBPath))) return undefined

	const reason = fstStaleReason(await peekFSTStampFields(fstPath), {
		source: await readWOFSourceIdentity(sourceDBPath),
		...(formatVersion === undefined ? {} : { formatVersion }),
		...(exclusionPolicy === undefined ? {} : { exclusionPolicy }),
	})

	return reason === undefined ? undefined : formatFSTStaleWarning({ fstPath, reason, rebuildCommand })
}

/**
 * The one warning format, so `grep -r "FST stale"` finds every site that emits one.
 */
export function formatFSTStaleWarning({
	fstPath,
	reason,
	rebuildCommand,
}: {
	fstPath: PathBuilderLike
	reason: string
	rebuildCommand: string
}): string {
	return `WARNING: FST STALE — ${fstPath.toString()}: ${reason}. Rebuild with: ${rebuildCommand}`
}
