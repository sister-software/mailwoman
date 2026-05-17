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

import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { CanonicalRow, LabeledRow } from "./types.js"

export type SplitName = "train" | "val" | "test"

export interface SplitOptions {
	/**
	 * Region-name → holdout policy, keyed by ISO 3166-1 alpha-2 country. The values are the
	 * region-component strings the splitter looks for in `row.components.region`. Override to change
	 * the holdout for an experiment; defaults to `defaultHoldouts()`.
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
 */
export function defaultHoldouts(): Record<string, readonly string[]> {
	return {
		US: ["Vermont", "VT", "Wyoming", "WY", "North Dakota", "ND"],
		FR: ["Corse", "Lozère", "Lozere", "Creuse"],
	}
}

type SplitInputRow = Pick<CanonicalRow, "source_id" | "country" | "corpus_version" | "components">

/**
 * Compute a `SplitManifest` from an iterable of labeled (or canonical) rows. Both shapes are
 * accepted — only `source_id`, `country`, `corpus_version`, and `components.region` are consulted.
 */
export function splitRows(rows: Iterable<SplitInputRow>, opts: SplitOptions = {}): SplitManifest {
	const holdouts = opts.holdouts ?? defaultHoldouts()
	const train: string[] = []
	const val: string[] = []
	const test: string[] = []
	let corpus_version = ""

	for (const row of rows) {
		if (!corpus_version && row.corpus_version) corpus_version = row.corpus_version

		const region = row.components.region
		const countryHoldouts = holdouts[row.country] ?? []
		const isHeldOut = region !== undefined && countryHoldouts.includes(region)

		if (isHeldOut) {
			// 50/50 deterministic by source_id hash. Same input always lands in the same split.
			const bucket = hashBucket(row.source_id, 2)
			if (bucket === 0) val.push(row.source_id)
			else test.push(row.source_id)
		} else {
			train.push(row.source_id)
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
 * Write a `SplitManifest` to `<outputDir>/{train,val,test}.json`. The manifests are line-separated
 * source_id lists (one id per line) so they diff cleanly in git. Also writes
 * `<outputDir>/MANIFEST.json` with the full structured manifest including holdouts + counts +
 * corpus version.
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
