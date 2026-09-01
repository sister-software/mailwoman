/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build per-script parquet slices from the DeepSeek-generated transliteration JSONL and emit the
 *   corpus-v0.4.0 MANIFEST that combines them with the existing kryptonite + v0.3.0 slices.
 *
 *   Sibling to `slice-kryptonite.ts`. The two modules share the same composition pattern: take a
 *   base MANIFEST, append new slices, write a combined MANIFEST. Differences specific to
 *   transliteration:
 *
 *   - One JSONL contains rows from N target scripts (source = `deepseek-translit-<slug>`). We bucket by
 *       `source` and write one slice per script so `audit.ts` can attribute each slice to its
 *       synthetic source without relying on filename-prefix inference.
 *   - Each slice is written to `train/part-translit-<slug>.parquet` (distinct from kryptonite's
 *       `part-0000.parquet`, which v0.4.0's first builder already produced).
 *   - Inherits the path-canonicalization fix flagged in Thread B's postmortem: v0.3.0 slice paths are
 *       rewritten from `$MAILWOMAN_DATA_ROOT/...` to `/data/...` in the combined MANIFEST so
 *       all paths share one container-friendly form.
 *
 *   See docs/engineering/reference/CORPUS_V0_4_0_GENERATION.md for prompts, model, and the
 *   reproducibility contract.
 *
 *   Invoke via `mailwoman corpus slice translit \
 *   --jsonl /data/corpus/versioned/v0.4.0/transliteration/canonical-transliteration.jsonl \
 *   --base-manifest /data/corpus/versioned/v0.4.0/corpus-v0.4.0/MANIFEST.json \
 *   --out-dir /data/corpus/versioned/v0.4.0`
 */

import { mailwomanDataRoot } from "@mailwoman/core/data-root"
import { pathExists, readLocalJSONFile, tryStat } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile, writeLocalTextFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { join } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { ParquetWriter } from "#parquet-wrapper/index"
import type { CanonicalRow, LabeledRow } from "#types"
import {
	alignRow,
	appendShape,
	LABELED_ROW_SCHEMA,
	PARQUET_COLUMNS,
	ROW_GROUP_SIZE,
	rowToParquet,
	SLICE_COMPRESSION,
} from "#utils"
import type { ParquetRow, SliceDescriptor, SliceManifest } from "#utils"

export interface SliceTranslitOptions {
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
	 * Prefix the base manifest's slice paths currently carry, to be rewritten to
	 * {@link SliceTranslitOptions.canonicalPathPrefix}. Defaults to `mailwomanDataRoot()` with a trailing slash — the
	 * root that WROTE those paths. Pass it explicitly when translating a manifest generated under a different
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
		synth: raw["synth"] as CanonicalRow["synth"],
	}
}

/**
 * Write one slice for a single source slug. Returns the populated SliceDescriptor + a list of quarantine reasons for
 * rows that failed alignment.
 */
async function writeOneSlice(
	rows: readonly LabeledRow[],
	outPath: string,
	source: string,
	corpusVersion: string
): Promise<SliceDescriptor> {
	let firstSourceID = ""
	let lastSourceID = ""

	{
		await using writer = await ParquetWriter.openFile<ParquetRow>(LABELED_ROW_SCHEMA, outPath, {
			rowGroupSize: ROW_GROUP_SIZE,
		})

		writer.setMetadata("mailwoman.corpus_version", corpusVersion)
		writer.setMetadata("mailwoman.split", "train")
		writer.setMetadata("mailwoman.slice_source", source)

		for (const row of rows) {
			const pq = rowToParquet(row)
			await writer.appendRow(appendShape(pq))

			if (firstSourceID === "") {
				firstSourceID = row.source_id
			}

			lastSourceID = row.source_id
		}
	}

	const fileStat = await tryStat(outPath)
	const sha256 = await sha256File(outPath)

	return {
		split: "train",
		path: outPath,
		format: "parquet",
		compression: SLICE_COMPRESSION,
		rows: rows.length,
		bytes: fileStat?.size ?? 0,
		sha256,
		first_source_id: firstSourceID,
		last_source_id: lastSourceID,
		// Stamp source so audit.ts attributes the slice without falling back to filename-prefix inference.
		source,
	}
}

function canonicalizeSlicePath(path: string, legacyPrefix: string, canonicalPrefix: string): string {
	if (path.startsWith(legacyPrefix)) return canonicalPrefix + path.slice(legacyPrefix.length)

	return path
}

export async function buildTranslitSlice(
	options: SliceTranslitOptions,
	report?: (line: string) => void
): Promise<void> {
	const corpusVersion = options.corpusVersion ?? "0.4.0"
	// This is a portable manifest namespace, not a host filesystem default.
	const canonicalPathPrefix = options.canonicalPathPrefix ?? "/data/"
	const legacyPathPrefix = options.legacyPathPrefix ?? `${mailwomanDataRoot()}/`

	if (!(await pathExists(options.jsonl))) throw new Error(`jsonl not found: ${options.jsonl}`)

	if (!(await pathExists(options.baseManifest))) throw new Error(`base-manifest not found: ${options.baseManifest}`)

	const corpusDir = join(options.outDir, `corpus-v${corpusVersion}`)
	const trainDir = join(corpusDir, "train")
	await makeDirectories(trainDir)

	// Bucket canonical rows by source. Quarantined rows are logged.
	const buckets = new Map<string, LabeledRow[]>()
	const quarantine: string[] = []
	let totalIn = 0

	for await (const raw of JSONSpliterator.fromAsync<Record<string, unknown>>(options.jsonl)) {
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

	const newSlices: SliceDescriptor[] = []
	const sortedKeys = [...buckets.keys()].toSorted()

	for (const source of sortedKeys) {
		const rows = buckets.get(source)!
		const slug = source.startsWith("deepseek-translit-") ? source.slice("deepseek-translit-".length) : source
		const outPath = join(trainDir, `part-translit-${slug}.parquet`)
		const descriptor = await writeOneSlice(rows, outPath, source, corpusVersion)
		newSlices.push(descriptor)
		report?.(`  ${source}: ${descriptor.rows} rows → ${outPath} (${descriptor.bytes} bytes)`)
	}

	if (quarantine.length) {
		const qPath = join(corpusDir, "quarantine-transliteration.tsv")
		await writeLocalTextFile(quarantine.join("\n") + "\n", qPath)
		report?.(`quarantine log → ${qPath} (${quarantine.length} rows)`)
	}

	// Compose final MANIFEST: rewrite base.slices paths from /mnt/playpen/... → /data/... and append
	// the new translit slices. Kryptonite slice already lives in the base manifest (it was written
	// there by Thread B).
	const base = await readLocalJSONFile<SliceManifest>(options.baseManifest)

	const rewrittenBase = base.slices.map((sh) => ({
		...sh,
		path: canonicalizeSlicePath(sh.path, legacyPathPrefix, canonicalPathPrefix),
	}))

	const newTrainRows = newSlices.reduce((sum, sh) => sum + sh.rows, 0)

	const combined: SliceManifest = {
		corpus_version: corpusVersion,
		schema: PARQUET_COLUMNS,
		rows_per_slice: base.rows_per_slice,
		row_group_size: base.row_group_size ?? ROW_GROUP_SIZE,
		slices: [...rewrittenBase, ...newSlices],
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
	report?.(`  slices=${combined.slices.length} (base=${base.slices.length}, added=${newSlices.length})`)
	report?.(`  compression=${SLICE_COMPRESSION}`)
	const pathFix = rewrittenBase.filter((s, i) => s.path !== base.slices[i]!.path).length

	if (pathFix > 0) {
		report?.(`  path-canonicalized base slices: ${pathFix} (legacy '${legacyPathPrefix}' → '${canonicalPathPrefix}')`)
	}
}
