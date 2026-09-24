/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build per-script parquet files from the DeepSeek-generated transliteration jsonl and emit the
 *   corpus-v0.4.0 manifest that combines them with the existing kryptonite + v0.3.0 files.
 *
 *   Sibling to `kryptonite.ts`. The two modules share the same composition pattern: take a
 *   base manifest, append new parquet files, write a combined manifest. Differences specific to
 *   transliteration:
 *
 *   - One jsonl contains rows from N target scripts (source = `deepseek-translit-<slug>`). We bucket by
 *       `source` and write one parquet file per script so `audit.ts` can attribute each file to its
 *       synthetic source without relying on filename-prefix inference.
 *   - Each file is written to `train/part-translit-<slug>.parquet` (distinct from kryptonite's
 *       `part-0000.parquet`, which v0.4.0's first builder already produced).
 *   - Inherits the path-canonicalization fix flagged in Thread B's postmortem: v0.3.0 file paths are
 *       rewritten from `$MAILWOMAN_DATA_ROOT/...` to `/data/...` in the combined manifest so
 *       all paths share one container-friendly form.
 *
 *   See docs/engineering/reference/CORPUS_V0_4_0_GENERATION.md for prompts, model, and the
 *   reproducibility interface.
 *
 *   Invoke via `mailwoman corpus slice translit \
 *   --jsonl /data/corpus/versioned/v0.4.0/transliteration/canonical-transliteration.jsonl \
 *   --base-manifest /data/corpus/versioned/v0.4.0/corpus-v0.4.0/manifest.json \
 *   --out-dir /data/corpus/versioned/v0.4.0`
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { delimitedSource } from "@mailwoman/core/fs/delimited"
import { pathExists, readLocalJSONFile, tryStat } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile, writeLocalTextFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { join } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { PARQUET_COLUMNS, PARQUET_COMPRESSION, ROW_GROUP_SIZE, rowToParquet } from "#parquet/schema"
import type { ParquetFileDescriptor, ParquetManifest } from "#parquet/writers"
import { writeParquetFile } from "#parquet/writers"
import { type CanonicalRow, type LabeledRow, requireSurface } from "#types"
import { alignRow } from "#utils"

export interface TranslitOverlayOptions {
	jsonl: string
	baseManifest: string
	outDir: string
	/**
	 * Default `"0.4.0"`.
	 */
	corpusVersion?: string
	/**
	 * Default `"/data/"`.
	 */
	canonicalPathPrefix?: string
	/**
	 * Prefix the base manifest's file paths currently carry, to be rewritten
	 * to {@link TranslitOverlayOptions.canonicalPathPrefix}.
	 *
	 * Defaults to `dataRootPath()` with a trailing slash — the root that wrote those paths.
	 * Pass it explicitly when translating a manifest generated under a different
	 * `$MAILWOMAN_DATA_ROOT` than the one you are running with.
	 */
	legacyPathPrefix?: string
}

function toCanonicalRow(raw: Record<string, unknown>, corpusVersion: string): CanonicalRow {
	return {
		raw: raw["raw"] as string,
		components: raw["components"] as Record<string, string>,
		country: (raw["country"] as string) ?? "US",
		locale: (raw["locale"] as string) ?? undefined,
		source: raw["source"] as string,
		source_id: raw["source_id"] as string,
		corpus_version: corpusVersion,
		license: (raw["license"] as string) ?? "Synthetic (DeepSeek-v4-flash, AGPL-compatible)",
		recipe: raw["recipe"] as CanonicalRow["recipe"],
		register: (raw["register"] as string | null) ?? null,
		surface: requireSurface(raw, "translit"),
	}
}

/**
 * Write one parquet file for a single source slug.
 *
 * @returns The populated ParquetFileDescriptor + a list of quarantine reasons
 * for rows that failed alignment.
 */
async function writeOneFile(
	rows: readonly LabeledRow[],
	outPath: string,
	source: string
): Promise<ParquetFileDescriptor> {
	let firstSourceID = ""
	let lastSourceID = ""

	for (const row of rows) {
		if (firstSourceID === "") {
			firstSourceID = row.source_id
		}

		lastSourceID = row.source_id
	}

	await writeParquetFile(rows.map(rowToParquet), outPath)

	const fileStat = await tryStat(outPath)
	const sha256 = await sha256File(outPath)

	return {
		split: "train",
		path: outPath,
		format: "parquet",
		compression: PARQUET_COMPRESSION,
		rows: rows.length,
		bytes: fileStat?.size ?? 0,
		sha256,
		first_source_id: firstSourceID,
		last_source_id: lastSourceID,
		// Stamp source so audit.ts attributes the file without falling back to filename-prefix inference.
		source,
	}
}

function canonicalizeFilePath(path: string, legacyPrefix: string, canonicalPrefix: string): string {
	if (path.startsWith(legacyPrefix)) return canonicalPrefix + path.slice(legacyPrefix.length)

	return path
}

export async function buildTranslitOverlay(
	options: TranslitOverlayOptions,
	report?: (line: string) => void
): Promise<void> {
	const corpusVersion = options.corpusVersion ?? "0.4.0"
	// This is a portable manifest namespace rather than a host filesystem default.
	const canonicalPathPrefix = options.canonicalPathPrefix ?? "/data/"
	const legacyPathPrefix = options.legacyPathPrefix ?? `${dataRootPath()}/`

	if (!(await pathExists(options.jsonl))) throw new Error(`jsonl not found: ${options.jsonl}`)

	if (!(await pathExists(options.baseManifest))) throw new Error(`base-manifest not found: ${options.baseManifest}`)

	const corpusDir = join(options.outDir, `corpus-v${corpusVersion}`)
	const trainDir = join(corpusDir, "train")
	await makeDirectories(trainDir)

	// Bucket canonical rows by source.
	// Quarantined rows are logged.
	const buckets = new Map<string, LabeledRow[]>()
	const quarantine: string[] = []
	let totalIn = 0

	for await (const raw of JSONSpliterator.fromAsync<Record<string, unknown>>(delimitedSource(options.jsonl))) {
		totalIn++
		const canon = toCanonicalRow(raw, corpusVersion)
		const result = alignRow(canon)

		if (result.kind !== "labeled") {
			quarantine.push(`${canon.source_id}\t${result.row.reason}`)

			continue
		}

		const bucket = buckets.get(canon.source)

		if (bucket) {
			bucket.push(result.row)
		} else {
			buckets.set(canon.source, [result.row])
		}
	}

	report?.(`read ${totalIn} rows; ${quarantine.length} quarantined; ${buckets.size} script buckets`)

	const newFiles: ParquetFileDescriptor[] = []
	const sortedKeys = [...buckets.keys()].toSorted()

	for (const source of sortedKeys) {
		const rows = buckets.get(source)!
		const slug = source.startsWith("deepseek-translit-") ? source.slice("deepseek-translit-".length) : source
		const outPath = join(trainDir, `part-translit-${slug}.parquet`)
		const descriptor = await writeOneFile(rows, outPath, source)
		newFiles.push(descriptor)
		report?.(`  ${source}: ${descriptor.rows} rows → ${outPath} (${descriptor.bytes} bytes)`)
	}

	if (quarantine.length) {
		const qPath = join(corpusDir, "quarantine-transliteration.tsv")
		await writeLocalTextFile(quarantine, qPath)
		report?.(`quarantine log → ${qPath} (${quarantine.length} rows)`)
	}

	// Compose final manifest: rewrite the base's file paths from the data root → /data/...
	// And append the new translit files.
	// The kryptonite file already lives in the base manifest (it was written there by Thread B).
	const base = await readLocalJSONFile<ParquetManifest>(options.baseManifest)

	const rewrittenBase = base.slices.map((file) => ({
		...file,
		path: canonicalizeFilePath(file.path, legacyPathPrefix, canonicalPathPrefix),
	}))

	const newTrainRows = newFiles.reduce((sum, file) => sum + file.rows, 0)

	const combined: ParquetManifest = {
		corpus_version: corpusVersion,
		schema: PARQUET_COLUMNS,
		rows_per_slice: base.rows_per_slice,
		row_group_size: base.row_group_size ?? ROW_GROUP_SIZE,
		slices: [...rewrittenBase, ...newFiles],
		counts: {
			train: base.counts.train + newTrainRows,
			val: base.counts.val,
			test: base.counts.test,
		},
		total_rows: base.total_rows + newTrainRows,
	}

	const combinedPath = join(corpusDir, "MANIFEST.json")
	await writeLocalJSONFile(combined, combinedPath)
	report?.(`wrote combined manifest → ${combinedPath}`)
	report?.(`  total_rows=${combined.total_rows} (base=${base.total_rows}, added=${newTrainRows})`)
	report?.(`  files=${combined.slices.length} (base=${base.slices.length}, added=${newFiles.length})`)
	report?.(`  compression=${PARQUET_COMPRESSION}`)
	const pathFix = rewrittenBase.filter((s, i) => s.path !== base.slices[i]!.path).length

	if (pathFix > 0) {
		report?.(`  path-canonicalized base files: ${pathFix} (legacy '${legacyPathPrefix}' → '${canonicalPathPrefix}')`)
	}
}
