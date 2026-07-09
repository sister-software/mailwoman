/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Train / val / test split with **locality holdout** per the Phase 1 plan.
 *
 *   The corpus's val + test sets are not randomly sampled rows — they're entire low-density regions
 *   held out so the model cannot memorize them at training time. Rationale (per the plan's "Common
 *   pitfalls" section): random splits leak by neighborhood — a model fed "13 Main St, Springfield,
 *   IL" in train and "15 Main St, Springfield, IL" in test generalizes via region/locality
 *   memorization, not by learning the underlying schema.
 *
 *   Phase 1 holdouts (chosen for low data density + administrative isolation):
 *
 *   - **US**: Vermont, Wyoming, North Dakota
 *   - **FR**: Corse, Lozère, Creuse
 *
 *   Held-out rows are deterministically split 50/50 between val and test by hashing the row's
 *   `source_id`. Non-held-out rows go to train. The 90/5/5 ratio is approximate — what matters is
 *   the locality boundary, not the exact split percentages.
 *
 *   The output is a `SplitManifest`: three `string[]` arrays of `source_id`. Manifests live in git
 *   (under `corpus/splits/<version>/`) so reruns are reproducible bit-for-bit.
 */

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { childEnv } from "@mailwoman/core/utils"
import { JSONSpliterator } from "spliterator"

import type { CanonicalRow, LabeledRow } from "./types.ts"

export type SplitName = "train" | "val" | "test"

export interface SplitOptions {
	/**
	 * Region-name → holdout policy, keyed by ISO 3166-1 alpha-2 country. The values are the region-component strings the
	 * splitter looks for in `row.components.region`. Override to change the holdout for an experiment; defaults to
	 * `defaultHoldouts()`.
	 */
	holdouts?: Record<string, readonly string[]>
}

/** Output manifest: source_id lists per split. */
export interface SplitManifest {
	train: string[]
	val: string[]
	test: string[]
	/** Echoes the holdouts used, so the manifest is self-describing. */
	holdouts: Record<string, readonly string[]>
	/** Corpus version stamped onto the manifest. Read from the first row. */
	corpus_version: string
	/** Counts for quick sanity checks. */
	counts: { train: number; val: number; test: number; total: number }
}

/**
 * Phase 1 default holdouts (per plan).
 *
 * - US: Vermont, Wyoming, North Dakota (low density, easy to identify in WOF/admin sources).
 * - FR: Corse, Lozère, Creuse (small departments / regions).
 * - DE (added 2026-06-11, night-11): Saarland + Mecklenburg-Vorpommern — small Länder so the training cost is low while
 *   the slice clears the honest-eval 1000-row trust floor. DE has had NO trustable honest-eval slice since the harness
 *   shipped (flagged 2026-06-08); this takes effect at the NEXT base corpus rebuild — existing versioned corpora keep
 *   their committed SPLIT_MANIFESTs (a holdout added after a corpus is built is leakage-laundering, not a holdout).
 */
export function defaultHoldouts(): Record<string, readonly string[]> {
	return {
		US: ["Vermont", "VT", "Wyoming", "WY", "North Dakota", "ND"],
		FR: ["Corse", "Lozère", "Lozere", "Creuse"],
		DE: ["Saarland", "SL", "Mecklenburg-Vorpommern", "MV"],
	}
}

type SplitInputRow = Pick<CanonicalRow, "source_id" | "country" | "corpus_version" | "components">

/**
 * Pure per-row split decision. Used by both the in-memory `splitRows` and by the streaming `buildCorpus` align loop
 * (`build.ts`) to decide each row's split without retaining the row in heap. Identical hash bucketing semantics to the
 * array-based path so the decision is stable regardless of caller.
 */
export function splitForRow(
	row: Pick<SplitInputRow, "source_id" | "country" | "components">,
	holdouts: Record<string, readonly string[]> = defaultHoldouts()
): SplitName {
	const region = row.components.region
	const countryHoldouts = holdouts[row.country] ?? []
	const isHeldOut = region !== undefined && countryHoldouts.includes(region)

	if (!isHeldOut) return "train"

	// 50/50 deterministic by source_id hash. Same input always lands in the same split.
	return hashBucket(row.source_id, 2) === 0 ? "val" : "test"
}

/**
 * Compute a `SplitManifest` from an iterable of labeled (or canonical) rows. Both shapes are accepted — only
 * `source_id`, `country`, `corpus_version`, and `components.region` are consulted.
 *
 * Retained for in-memory callers (tests; small-scale fixture runs). Real-data builds via `buildCorpus` use the
 * streaming path (`splitForRow` + `writeSplitManifestsFromLabeledFiles`) to avoid materializing every aligned row's
 * split membership in heap.
 */
export function splitRows(rows: Iterable<SplitInputRow>, opts: SplitOptions = {}): SplitManifest {
	const holdouts = opts.holdouts ?? defaultHoldouts()
	const train: string[] = []
	const val: string[] = []
	const test: string[] = []
	let corpus_version = ""

	for (const row of rows) {
		if (!corpus_version && row.corpus_version) {
			corpus_version = row.corpus_version
		}
		const split = splitForRow(row, holdouts)

		if (split === "train") {
			train.push(row.source_id)
		} else if (split === "val") {
			val.push(row.source_id)
		} else {
			test.push(row.source_id)
		}
	}

	const total = train.length + val.length + test.length

	return {
		train,
		val,
		test,
		holdouts,
		corpus_version,
		counts: { train: train.length, val: val.length, test: test.length, total },
	}
}

/** Lightweight deterministic 0..(n-1) bucket from a string id. */
export function hashBucket(id: string, n: number): number {
	const digest = createHash("sha256").update(id).digest()
	// Read 4 bytes as uint32 to avoid bigint overhead.
	const u = digest[0]! * 0x01_00_00_00 + digest[1]! * 0x01_00_00 + digest[2]! * 0x01_00 + digest[3]!

	return u % n
}

/**
 * Write a `SplitManifest` to `<outputDir>/{train,val,test}.json`. The manifests are line-separated source_id lists (one
 * id per line) so they diff cleanly in git. Also writes `<outputDir>/MANIFEST.json` with the full structured manifest
 * including holdouts + counts + corpus version.
 *
 * Reruns produce byte-identical files (the underlying `splitRows` is deterministic).
 */
export async function writeSplitManifests(manifest: SplitManifest, outputDir: string): Promise<void> {
	await mkdir(outputDir, { recursive: true })

	for (const name of ["train", "val", "test"] as const) {
		const sorted = [...manifest[name]].sort()
		await writeFile(join(outputDir, `${name}.txt`), sorted.join("\n") + (sorted.length ? "\n" : ""), "utf8")
	}
	const summary = {
		corpus_version: manifest.corpus_version,
		holdouts: manifest.holdouts,
		counts: manifest.counts,
	}
	await writeFile(join(outputDir, "SPLIT_MANIFEST.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8")
}

/** Type re-export for callers that want to ingest LabeledRow specifically. */
export type SplitInputLabeledRow = Pick<LabeledRow, "source_id" | "country" | "corpus_version" | "components">

/**
 * Streaming variant of `writeSplitManifests`: derives the per-split source-id .txt manifests + `SPLIT_MANIFEST.json` by
 * streaming three per-split labeled-row JSONL files (one per split). Memory cost is O(1) — `sort(1)` from coreutils
 * handles the deterministic sort with disk spill for files that exceed in-memory thresholds.
 *
 * Used by `buildCorpus` after the align loop has already partitioned labeled rows into `labeled-{train,val,test}.jsonl`
 * via `splitForRow`. Counts are pre-computed by the align loop and passed in (zero re-scan).
 */
export async function writeSplitManifestsFromLabeledFiles(opts: {
	labeledPaths: Record<SplitName, string>
	outputDir: string
	corpusVersion: string
	counts: Record<SplitName, number>
	holdouts?: Record<string, readonly string[]>
}): Promise<SplitManifest["counts"]> {
	await mkdir(opts.outputDir, { recursive: true })
	const holdouts = opts.holdouts ?? defaultHoldouts()

	for (const split of ["train", "val", "test"] as const) {
		const labeledPath = opts.labeledPaths[split]
		const outPath = join(opts.outputDir, `${split}.txt`)
		await streamSortedSourceIds(labeledPath, outPath)
	}

	const total = opts.counts.train + opts.counts.val + opts.counts.test
	const summary = {
		corpus_version: opts.corpusVersion,
		holdouts,
		counts: { ...opts.counts, total },
	}
	await writeFile(join(opts.outputDir, "SPLIT_MANIFEST.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8")

	return summary.counts
}

/**
 * Extract `source_id`s from a labeled JSONL file, write them sorted to `outPath`. Empty input → empty output file (not
 * absent). Uses `sort(1)` for disk-spilling external sort so peak memory stays O(1) regardless of labeled-row count.
 */
async function streamSortedSourceIds(labeledJsonlPath: string, outPath: string): Promise<void> {
	const unsortedPath = `${outPath}.unsorted`
	const out = createWriteStream(unsortedPath, { encoding: "utf8" })
	const outClosed = new Promise<void>((resolve, reject) => {
		out.on("close", () => resolve())
		out.on("error", reject)
	})

	// JSONSpliterator parses each row (skipEmpty drops blank lines); a malformed row throws
	// SyntaxError out of the loop, matching the prior `reject(err)` fail-loud behavior. `finally`
	// always ends the write stream so `sort` reads a complete file even if the read throws.
	try {
		for await (const obj of JSONSpliterator.fromAsync<{ source_id?: string }>(labeledJsonlPath)) {
			if (typeof obj.source_id === "string") {
				out.write(`${obj.source_id}\n`)
			}
		}
	} finally {
		out.end()
	}
	await outClosed

	await new Promise<void>((resolve, reject) => {
		// LC_ALL=C: byte-sort, locale-independent → deterministic across hosts.
		const proc = spawn("sort", [unsortedPath, "-o", outPath], { env: childEnv({ LC_ALL: "C" }) })
		proc.on("error", reject)
		proc.on("exit", (code) => {
			if (code === 0) {
				resolve()
			} else {
				reject(new Error(`sort exited with code ${code}`))
			}
		})
	})
	await unlink(unsortedPath).catch(() => {})
}
