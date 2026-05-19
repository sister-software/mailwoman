/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   End-to-end corpus build (Phase 1 task #10 in the plan).
 *
 *   `buildCorpus(opts)` orchestrates every stage of the pipeline:
 *
 *   1. **Adapter runs** — drives every adapter in turn (via `runAdapter`), writing
 *        `<intermediate>/<adapter.id>/canonical.jsonl` shards.
 *   2. **Synthesis** — optional. For each canonical row, every applicable augmentation in the row's
 *        country-default policy emits an augmented row alongside the original.
 *   3. **Alignment** — every row (original + augmented) is aligned via `alignRow`. Successes go to
 *        `labeled.jsonl`; quarantines are appended to `quarantine.jsonl` with reasons.
 *   4. **Splits** — `splitRows` partitions labeled `source_id`s into train/val/test by locality holdout.
 *        Manifest written to `splits/SPLIT_MANIFEST.json` + per-split `train.txt` / `val.txt` /
 *        `test.txt`.
 *   5. **Parquet shards** — `writeShards` streams labeled rows into 1M-row `.parquet` shards per split
 *        under `corpus-v<version>/{train,val,test}/part-NNNN.parquet` (SNAPPY-compressed, 50k-row
 *        row groups), with per-shard checksums + per-stage manifest in
 *        `corpus-v<version>/MANIFEST.json`.
 *   6. **Top-level manifest** — `<outputDir>/MANIFEST.json` ties every per-stage manifest together with
 *        a top-level corpus_version, built_at, and aggregate counts.
 *
 *   Output layout:
 *
 *   ```
 *   <outputDir>/
 *   MANIFEST.json
 *   intermediate/
 *     <adapter.id>/canonical.jsonl   # one per adapter
 *     labeled.jsonl                  # post-alignment, pre-shard
 *     quarantine.jsonl               # rows that failed alignment
 *   splits/
 *     SPLIT_MANIFEST.json
 *     train.txt / val.txt / test.txt
 *   corpus-v<version>/
 *     MANIFEST.json
 *     train/part-NNNN.parquet
 *     val/part-NNNN.parquet
 *     test/part-NNNN.parquet
 * ```
 *
 *   The intermediate files live alongside the final shards for reproducibility + debugging. Operators
 *   can `rm -rf intermediate/` after the build if disk is tight; the final `corpus-v<version>/` is
 *   self-contained.
 */

import { createReadStream, createWriteStream, type WriteStream } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { defaultAdapterRegistry } from "./adapter.js"
import { alignRow } from "./align.js"
import { writeShards, type ShardManifest } from "./parquet.js"
import { runAdapter, type AdapterRunManifest } from "./runner.js"
import {
	defaultHoldouts,
	splitForRow,
	writeSplitManifestsFromLabeledFiles,
	type SplitManifest,
	type SplitName,
} from "./split.js"
import { defaultAugmentationsForCountry, synthesizeRow } from "./synthesize.js"
import type { AdapterOptions, CanonicalRow, CorpusAdapter, LabeledRow } from "./types.js"

/** Stage tags surfaced to `onProgress`. */
export type BuildStage = "adapter-run" | "align" | "split" | "shard" | "manifest"

/** Per-invocation options for `buildCorpus`. */
export interface BuildCorpusOptions {
	/** Root output directory. All build artifacts land beneath it. */
	outputDir: string

	/** Corpus version (e.g. `"0.1.0"`). Stamped onto every row + into the output dir name. */
	corpusVersion: string

	/**
	 * Adapters to drive, in order. Defaults to `defaultAdapterRegistry.list()`. Pass an explicit list
	 * to filter (e.g. `[wofAdminAdapter]` for a smoke run).
	 */
	adapters?: readonly CorpusAdapter[]

	/**
	 * Per-adapter `AdapterOptions` — looked up by adapter id. Adapters whose id is missing from this
	 * map are skipped (and noted in the manifest).
	 */
	adapterInputs: Record<string, AdapterOptions>

	/** Enable synthesis pass. Default `true`. Set `false` for fixture-driven smoke tests. */
	synthesize?: boolean

	/** Forwarded to `writeShards`. Default 1_000_000. */
	rowsPerShard?: number

	/** Progress hook. Errors thrown abort the build. */
	onProgress?: (stage: BuildStage, message: string) => void
}

/** Top-level manifest tying every stage together. */
export interface BuildCorpusManifest {
	corpus_version: string
	built_at: string
	adapters: AdapterRunManifest[]
	skipped_adapters: string[]
	splits: { counts: SplitManifest["counts"]; holdouts: SplitManifest["holdouts"] }
	shards: { counts: ShardManifest["counts"]; total_rows: number }
	quarantine_count: number
	total_aligned_rows: number
}

/**
 * Drive the full corpus build to completion.
 *
 * Memory profile: the function maintains an in-memory `Map<source_id, SplitName>` to bridge the
 * align → shard hand-off. For Phase 1 fixture-scale runs (≤ 10⁴ rows) this is trivial. For real 5M+
 * runs, the map fits comfortably in a few hundred MB; the canonical.jsonl and labeled.jsonl
 * payloads stream and never sit in memory.
 */
export async function buildCorpus(opts: BuildCorpusOptions): Promise<BuildCorpusManifest> {
	const adapters = opts.adapters ?? defaultAdapterRegistry.list()
	const synthesize = opts.synthesize ?? true
	const rowsPerShard = opts.rowsPerShard ?? 1_000_000
	const built_at = new Date().toISOString()

	await mkdir(opts.outputDir, { recursive: true })
	const intermediateDir = join(opts.outputDir, "intermediate")
	await mkdir(intermediateDir, { recursive: true })

	// 1. Adapter runs.
	const adapterRuns: AdapterRunManifest[] = []
	const skipped: string[] = []
	for (const adapter of adapters) {
		const adapterOptions = opts.adapterInputs[adapter.id]
		if (!adapterOptions) {
			skipped.push(adapter.id)
			opts.onProgress?.("adapter-run", `skipped ${adapter.id} (no input configured)`)
			continue
		}
		opts.onProgress?.("adapter-run", `running ${adapter.id}`)
		const m = await runAdapter({
			adapter,
			adapterOptions,
			outputDir: intermediateDir,
			corpusVersion: opts.corpusVersion,
		})
		adapterRuns.push(m)
	}

	// 2 + 3. Synthesis + alignment: stream every canonical.jsonl, optionally augment, align,
	// and route each labeled row directly to its split-specific JSONL (`labeled-{train,val,test}.
	// jsonl`). Memory cost is O(1) — the prior in-memory `splitInputs` array + `splitByIdMap`
	// + `SplitManifest.{train,val,test}` arrays are gone; per-row split is decided inline via
	// `splitForRow` (a pure function of source_id + region + holdout policy).
	const labeledPaths: Record<SplitName, string> = {
		train: join(intermediateDir, "labeled-train.jsonl"),
		val: join(intermediateDir, "labeled-val.jsonl"),
		test: join(intermediateDir, "labeled-test.jsonl"),
	}
	const labeledStreams: Record<SplitName, WriteStream> = {
		train: createWriteStream(labeledPaths.train, { encoding: "utf8" }),
		val: createWriteStream(labeledPaths.val, { encoding: "utf8" }),
		test: createWriteStream(labeledPaths.test, { encoding: "utf8" }),
	}
	const quarantinePath = join(intermediateDir, "quarantine.jsonl")
	const quarantineStream = createWriteStream(quarantinePath, { encoding: "utf8" })

	let aligned = 0
	let quarantined = 0
	const counts: Record<SplitName, number> = { train: 0, val: 0, test: 0 }
	const holdouts = defaultHoldouts()

	const writeQuarantine = (row: CanonicalRow, reason: string): void => {
		quarantineStream.write(`${JSON.stringify({ row, reason })}\n`)
	}

	for (const adapterRun of adapterRuns) {
		opts.onProgress?.("align", `aligning ${adapterRun.adapter_id}`)
		for await (const row of streamJsonl<CanonicalRow>(adapterRun.jsonl_path)) {
			const fanned: CanonicalRow[] = [row]
			if (synthesize) {
				for (const aug of synthesizeRow(row, defaultAugmentationsForCountry(row.country))) {
					fanned.push(aug)
				}
			}
			for (const r of fanned) {
				const result = alignRow(r)
				if (result.kind === "labeled") {
					const split = splitForRow(result.row, holdouts)
					labeledStreams[split].write(`${JSON.stringify(result.row)}\n`)
					counts[split]++
					aligned++
				} else {
					writeQuarantine(r, result.row.reason)
					quarantined++
				}
			}
		}
	}

	for (const s of Object.values(labeledStreams)) s.end()
	quarantineStream.end()
	await Promise.all([...Object.values(labeledStreams).map(streamEnd), streamEnd(quarantineStream)])

	// 4. Splits — manifest derived by streaming the per-split labeled files; no in-memory
	// source-id arrays. `sort(1)` from coreutils produces the deterministic per-split .txt
	// manifests with disk spill for splits that exceed in-memory thresholds.
	opts.onProgress?.("split", `splitting ${aligned} aligned rows`)
	const splitsDir = join(opts.outputDir, "splits")
	const splitCounts = await writeSplitManifestsFromLabeledFiles({
		labeledPaths,
		outputDir: splitsDir,
		corpusVersion: opts.corpusVersion,
		counts,
		holdouts,
	})

	// 5. Parquet shards — per-split labeled JSONL streams in, sharded `.parquet` out. The prior
	// `splitFor(source_id)` callback (and the `Map<source_id, SplitName>` behind it) is gone.
	opts.onProgress?.("shard", "writing parquet shards")
	const shardManifest = await writeShards(
		{
			train: streamJsonl<LabeledRow>(labeledPaths.train),
			val: streamJsonl<LabeledRow>(labeledPaths.val),
			test: streamJsonl<LabeledRow>(labeledPaths.test),
		},
		{
			outputDir: opts.outputDir,
			corpusVersion: opts.corpusVersion,
			rowsPerShard,
		}
	)

	// 6. Top-level manifest.
	opts.onProgress?.("manifest", "writing top-level MANIFEST.json")
	const manifest: BuildCorpusManifest = {
		corpus_version: opts.corpusVersion,
		built_at,
		adapters: adapterRuns,
		skipped_adapters: skipped,
		splits: { counts: splitCounts, holdouts },
		shards: { counts: shardManifest.counts, total_rows: shardManifest.total_rows },
		quarantine_count: quarantined,
		total_aligned_rows: aligned,
	}
	await writeFile(join(opts.outputDir, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
	return manifest
}

async function* streamJsonl<T>(path: string): AsyncIterable<T> {
	const stream = createReadStream(path, { encoding: "utf8" })
	const rl = createInterface({ input: stream, crlfDelay: Infinity })
	for await (const line of rl) {
		const trimmed = line.trim()
		if (!trimmed) continue
		yield JSON.parse(trimmed) as T
	}
}

function streamEnd(s: WriteStream): Promise<void> {
	return new Promise((resolve, reject) => {
		s.once("close", resolve)
		s.once("error", reject)
	})
}
