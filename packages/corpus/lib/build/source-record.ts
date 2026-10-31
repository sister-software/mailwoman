/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The record a parallel build writes when one source's work is finished, and the check that admits it for reuse.
 *
 *   A source is complete when its `SOURCE_COMPLETE.json` exists, was written under the settings and derivation this
 *   build would use, and every file it lists is on disk with its recorded size and sha256. A store directory, a
 *   per-source parquet manifest or a subset of finished parts never makes a source complete, because a worker can
 *   die after writing any of them. The record is the last file a source's work writes.
 */

import { tryReadLocalJSONFile } from "@mailwoman/core/fs/readers"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { sha256File } from "@mailwoman/core/hash"
import { canonicalJSON } from "@mailwoman/core/json"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import type { AlignTotalsRecord } from "#build/align-totals"
import type { AlignSettings } from "#build/checkpoint"
import { readParquetRecord, type DerivationInputs } from "#parquet/record"
import type { ParquetFileDescriptor } from "#parquet/writers"
import type { AdapterRunManifest } from "#runner"
import type { SplitName } from "#utils/split"

/**
 * The completion record's name in a source's state directory, `intermediate/sources/<source>/`.
 *
 * A `finish` worker writes it as the last file of the source's work.
 */
export const SOURCE_RECORD_FILE = "SOURCE_COMPLETE.json"

/**
 * Every setting outside the derivation that changes a source's files:
 * the align settings, the shuffle and the row cap.
 */
export interface SourceBuildSettings {
	align: AlignSettings
	rowsPerFile: number
	shuffleSeed: number
	shuffleWindow: number
}

/**
 * One file a complete source lists, with what its reuse is checked against.
 */
export interface RecordedFile {
	path: string
	bytes: number
	sha256: string
}

/**
 * A finished source.
 */
export interface SourceCompletionRecord {
	source: string
	settings: SourceBuildSettings
	/**
	 * The derivation every one of the source's parquet files was written under,
	 * before the writer added each file's split and part.
	 */
	derivation: DerivationInputs
	adapter: AdapterRunManifest
	/**
	 * The byte ranges of the canonical file the source was aligned in.
	 *
	 * The files do not depend on them.
	 * They are recorded for a reader of the build.
	 */
	alignRanges: { start: number; end: number }[]
	/**
	 * Every parquet file the source wrote, as the corpus manifest lists it.
	 */
	parts: ParquetFileDescriptor[]
	/**
	 * The coordinator merges each split's sorted source-id list into the split files.
	 */
	sourceIDs: Record<SplitName, RecordedFile>
	/**
	 * The quarantine files of the source's align ranges, in range order.
	 */
	quarantine: RecordedFile[]
	totals: AlignTotalsRecord
	completed_at: string
}

/**
 * The directory under `intermediate/` that holds one source's parallel-build state.
 */
export function sourceStateDirectory(intermediateDir: PathBuilderLike, source: string): PathBuilder {
	return PathBuilder.from(intermediateDir)("sources", source)
}

/**
 * The size and sha256 of a file as it stands.
 */
export async function recordFile(path: PathBuilderLike): Promise<RecordedFile> {
	const stat = await tryStat(path)

	if (!stat) throw new Error(`recordFile: ${path.toString()} does not exist`)

	return { path: path.toString(), bytes: stat.size, sha256: await sha256File(path) }
}

async function fileProblem(file: RecordedFile): Promise<string | null> {
	const stat = await tryStat(file.path)

	if (!stat) return `${file.path} is missing`

	if (stat.size !== file.bytes) return `${file.path} is ${stat.size} bytes and the record states ${file.bytes}`

	const sha256 = await sha256File(file.path)

	if (sha256 !== file.sha256) return `${file.path} has sha256 ${sha256} and the record states ${file.sha256}`

	return null
}

/**
 * Why a source's completion record cannot be reused, or `null` with the record when it can.
 *
 * Every listed file is re-hashed, so a reused source is one whose bytes were read back in this build.
 */
export async function readReusableSource(
	sourceDir: PathBuilderLike,
	expected: { settings: SourceBuildSettings; derivation: DerivationInputs }
): Promise<{ record: SourceCompletionRecord; problem: null } | { record: null; problem: string }> {
	const path = PathBuilder.from(sourceDir)(SOURCE_RECORD_FILE)
	const record = await tryReadLocalJSONFile<SourceCompletionRecord>(path).catch(() => null)

	if (!record) return { record: null, problem: `${path.toString()} is absent or unreadable` }

	if (canonicalJSON(record.settings) !== canonicalJSON(expected.settings)) {
		return { record: null, problem: `${path.toString()} was written under other build settings` }
	}

	if (canonicalJSON(record.derivation) !== canonicalJSON(expected.derivation)) {
		return { record: null, problem: `${path.toString()} was written from another input, code or config` }
	}

	const canonical = await tryStat(record.adapter.jsonl_path)

	if (canonical?.size !== record.adapter.bytes) {
		return {
			record: null,
			problem: `${record.adapter.jsonl_path} no longer has the ${record.adapter.bytes} bytes aligned`,
		}
	}

	for (const part of record.parts) {
		const problem = await fileProblem({ path: part.path, bytes: part.bytes, sha256: part.sha256 })

		if (problem) return { record: null, problem }

		const parquetRecord = await readParquetRecord(part.path)

		if (parquetRecord?.derivationHash !== part.derivation_hash) {
			return { record: null, problem: `${part.path} has no record beside it naming derivation ${part.derivation_hash}` }
		}
	}

	for (const file of [...Object.values(record.sourceIDs), ...record.quarantine]) {
		const problem = await fileProblem(file)

		if (problem) return { record: null, problem }
	}

	return { record, problem: null }
}
