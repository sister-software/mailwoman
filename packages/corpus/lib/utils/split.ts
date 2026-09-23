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
 *   memorization rather than by learning the underlying schema.
 *
 *   Phase 1 holdouts (chosen for low data density + administrative isolation):
 *
 *   - **US**: Vermont, Wyoming, North Dakota
 *   - **FR**: Corse, Lozère, Creuse
 *
 *   A holdout names a place. Which component carries that place is a property of the source, so the predicate reads
 *   more than one: the region a US address source emits, the postcode prefix a French one emits, or a locality.
 *   Reading the region alone held out no BAN row at all, and BAN is 96.9% of FR, so FR's validation split carried zero
 *   street rows however many French departments were named (#2353).
 *
 *   A holdout added after a corpus is built is leakage-laundering rather than a holdout, so a change here takes effect
 *   at the next corpus rebuild. Every versioned corpus keeps the `SPLIT_MANIFEST.json` it was built with.
 *
 *   Held-out rows are deterministically split 50/50 between val and test by hashing the row's
 *   `source_id`. Non-held-out rows go to train. The 90/5/5 ratio is approximate — what matters is
 *   the locality boundary rather than the exact split percentages.
 *
 *   The output is a `SplitManifest`: three `string[]` arrays of `source_id`. Manifests live in git
 *   (under `corpus/splits/<version>/`) so reruns are reproducible bit-for-bit.
 */

import { delimitedSource } from "@mailwoman/core/fs/delimited"
import { openWriteStream } from "@mailwoman/core/fs/streams"
import { writeLocalJSONFile, writeLocalTextFile, makeDirectories, removePath } from "@mailwoman/core/fs/writers"
import { createHash } from "@mailwoman/core/hash"
import { spawnProcess } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { join, type PathBuilderLike } from "path-ts"
import { JSONSpliterator } from "spliterator"

import type { CanonicalRow, LabeledRow } from "#types"

export type SplitName = "train" | "val" | "test"

/**
 * Which component values name the places one country holds out.
 *
 * A holdout is a place, so the model cannot generalize by memorizing a neighborhood.
 * Which component carries that place differs by source, and that is why more than one matcher
 * exists: `usgov-nad` and `tiger` emit a `region`, so a held-out state reaches US street rows,
 * while BAN emits `house_number|street_prefix|street|postcode|locality` and no `region` at all.
 *
 * A region-only predicate cannot hold out a single BAN row, whichever French
 * departments it names, and BAN is 96.9% of FR (#2353).
 *
 * A row is held out when any declared matcher fires.
 * Declaring none holds out nothing.
 */
export interface HoldoutPolicy {
	/**
	 * Exact values matched against `row.components.region`.
	 */
	regions?: readonly string[]
	/**
	 * Prefixes matched against `row.components.postcode`.
	 *
	 * A prefix is only usable where it names a place on its own: a French postcode's
	 * first two digits are its department, so `20` is Corse and nothing else.
	 */
	postcodePrefixes?: readonly string[]
	/**
	 * Exact values matched against `row.components.locality`.
	 */
	localities?: readonly string[]
}

/**
 * One country's holdout, as a bare region list or as a {@link HoldoutPolicy}.
 *
 * The bare array keeps meaning "these region values", which is what every committed
 * `SPLIT_MANIFEST.json` echoes and what every existing caller passes.
 */
export type CountryHoldout = readonly string[] | HoldoutPolicy

export interface SplitOptions {
	/**
	 * Holdout policy keyed by ISO 3166-1 alpha-2 country.
	 *
	 * Override to change the holdout for an experiment.
	 * Defaults to `defaultHoldouts()`.
	 */
	holdouts?: Record<string, CountryHoldout>
}

/**
 * Output manifest: source_id lists per split.
 */
export interface SplitManifest {
	train: string[]
	val: string[]
	test: string[]
	/**
	 * Echoes the holdouts used, so the manifest is self-describing.
	 *
	 * A country declaring regions alone echoes the bare array every manifest built before #2353 carries.
	 */
	holdouts: Record<string, CountryHoldout>
	/**
	 * Corpus version stamped onto the manifest.
	 *
	 * Read from the first row.
	 */
	corpus_version: string
	/**
	 * Counts for quick sanity checks.
	 */
	counts: { train: number; val: number; test: number; total: number }
}

/**
 * Phase 1 default holdouts (per plan).
 *
 * - US: Vermont, Wyoming, North Dakota (low density, easy to identify in WOF/admin sources).
 * - FR: Corse, Lozère, Creuse (small departments / regions).
 * - DE (added 2026-06-11, night-11): Saarland + Mecklenburg-Vorpommern — small Länder
 *   so the training cost is low while the holdout clears the honest-eval 1000-row trust floor.
 *   DE has had no trustable honest-eval holdout since the harness shipped
 *   (flagged 2026-06-08); this takes effect at the next base corpus rebuild —
 *   existing versioned corpora keep their committed SPLIT_MANIFESTs
 *   (a holdout added after a corpus is built is leakage-laundering rather than a holdout).
 * - GB (added 2026-09-21, #2353): Cornwall, north Wales and Halifax, keyed on the postcode area.
 *   GB had no entry at all, so both its splits held zero rows and `macro_f1` said nothing about it.
 *   How many rows it holds out is unmeasured until the next rebuild, and the entry's comment says why.
 *
 * Every entry takes effect at the next base corpus rebuild, for the reason the DE note gives.
 */
export function defaultHoldouts(): Record<string, CountryHoldout> {
	return {
		US: ["Vermont", "VT", "Wyoming", "WY", "North Dakota", "ND"],
		FR: {
			regions: ["Corse", "Lozère", "Lozere", "Creuse"],
			// The same three departments, named in the component BAN emits.
			// A French postcode's first two digits are its department: Corse 20, Creuse 23, Lozère 48.
			// Without these the FR holdout reaches `wof-admin` rows alone.
			// Those rows carry a region and no street, so FR validates on locality and region rows only (#2353).
			postcodePrefixes: ["20", "23", "48"],
		},
		DE: ["Saarland", "SL", "Mecklenburg-Vorpommern", "MV"],
		GB: {
			// Keyed on the postcode area for the reason FR is keyed on the department: a source that emits
			// a GB street row emits no `region` with it, so a region-keyed holdout cannot reach one.
			//
			// Three small, geographically coherent, peripheral areas, on the principle Corse,
			// Creuse and Lozère were picked on: Truro for Cornwall, Llandudno for north Wales,
			// Halifax for the Calder valley.
			//
			// Two letters each, and no one of them is a prefix of another.
			// That is load-bearing rather than tidy: `L` is Liverpool, and `startsWith("L")` would
			// take Llandudno with it, making the holdout larger than the one anybody reviewed.
			// A test holds every prefix to two letters.
			postcodePrefixes: ["TR", "LL", "HX"],
			// Cornwall alone, so the admin rows held out name the same place the street rows do.
			regions: ["Cornwall"],
			//
			// WHICH ROWS THESE PREFIXES REACH.
			// Every GB street row in the corpus comes from `synth-gb`, which renders HM Land Registry
			// Price Paid Data — `ppd/<date>/gb-tuples.csv`, 25,674,049 rows — through a template.
			// The `synth-` prefix names the recipe rather than the data, the same way `synth-nl`
			// reads OpenAddresses NL and `synth-nz` reads a LINZ-derived extract.
			// GB's other two sources, `wof-postalcode` and `wof-admin`, carry no street at all.
			//
			// So a Price Paid row's POSTCODE column is what these prefixes match,
			// and Price Paid covers England and Wales.
			// Scotland and Northern Ireland register land separately, which is why no
			// Scottish postcode area was available to hold out.
			//
			// Confirm the held-out street-row count against the next base corpus rebuild and check
			// it against the per-locale floor in `docs/engineering/CONTRIBUTING_MODEL_WORK.mdx`.
			// `data.required_validation_coverage` is where that check belongs.
			// It fails the CPU preflight rather than the run.
		},
	}
}

/**
 * The declared matchers for one country, with a bare array read as its region list.
 */
export function holdoutPolicyFor(holdout: CountryHoldout | undefined): HoldoutPolicy {
	if (!holdout) return {}

	return Array.isArray(holdout) ? { regions: holdout } : (holdout as HoldoutPolicy)
}

type SplitInputRow = Pick<CanonicalRow, "source_id" | "country" | "corpus_version" | "components">

/**
 * Pure per-row split decision.
 *
 * Used by both the in-memory `splitRows` and by the streaming `buildCorpus` align loop
 * (`build.ts`) to decide each row's split without retaining the row in heap.
 * Identical hash bucketing semantics to the array-based path so the decision is stable regardless of caller.
 */
export function splitForRow(
	row: Pick<SplitInputRow, "source_id" | "country" | "components">,
	holdouts: Record<string, CountryHoldout> = defaultHoldouts()
): SplitName {
	const policy = holdoutPolicyFor(holdouts[row.country])
	const { region, postcode, locality } = row.components

	const isHeldOut =
		(region !== undefined && (policy.regions?.includes(region) ?? false)) ||
		(postcode !== undefined && (policy.postcodePrefixes?.some((prefix) => postcode.startsWith(prefix)) ?? false)) ||
		(locality !== undefined && (policy.localities?.includes(locality) ?? false))

	if (!isHeldOut) return "train"

	// 50/50 deterministic by source_id hash.
	// Same input always lands in the same split.
	return hashBucket(row.source_id, 2) === 0 ? "val" : "test"
}

/**
 * Compute a `SplitManifest` from an iterable of labeled (or canonical) rows.
 *
 * Both shapes are accepted — only `source_id`, `country`, `corpus_version`,
 * and `components.region` are consulted.
 *
 * Retained for in-memory callers (tests. Small-scale fixture runs).
 * Real-data builds via `buildCorpus` use the streaming path
 * (`splitForRow` + `writeSplitManifestsFromLabeledFiles`) to avoid materializing
 * every aligned row's split membership in heap.
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

/**
 * Lightweight deterministic 0..(n-1) bucket from a string id.
 */
/**
 * Deterministic bucket for a stable id.
 *
 * Stays on raw `createHash` rather than `sha256Hex` from `@mailwoman/core/utils`:
 * it needs the digest bytes, and the shared helper returns hex.
 * Re-parsing hex back into bytes to reach the same four octets would cost more than the one line it saves.
 */
export function hashBucket(id: string, n: number): number {
	const digest = createHash("sha256").update(id).digest()
	// Read 4 bytes as uint32 to avoid bigint overhead.
	const u = digest[0]! * 0x01_00_00_00 + digest[1]! * 0x01_00_00 + digest[2]! * 0x01_00 + digest[3]!

	return u % n
}

/**
 * Write a `SplitManifest` to `<outputDir>/{train,val,test}.json`.
 *
 * The manifests are line-separated source_id lists (one id per line) so they diff cleanly in git.
 * Also writes `<outputDir>/manifest.json` with the full structured manifest
 * including holdouts + counts + corpus version.
 *
 * Reruns produce byte-identical files (the underlying `splitRows` is deterministic).
 */
export async function writeSplitManifests(manifest: SplitManifest, outputDir: PathBuilderLike): Promise<void> {
	await makeDirectories(outputDir)

	for (const name of ["train", "val", "test"] as const) {
		const sorted = [...manifest[name]].toSorted()

		await writeLocalTextFile(sorted, outputDir, `${name}.txt`)
	}

	const summary = {
		corpus_version: manifest.corpus_version,
		holdouts: manifest.holdouts,
		counts: manifest.counts,
	}

	await writeLocalJSONFile(summary, outputDir, "SPLIT_MANIFEST.json")
}

/**
 * Type re-export for callers that want to ingest LabeledRow specifically.
 */
export type SplitInputLabeledRow = Pick<LabeledRow, "source_id" | "country" | "corpus_version" | "components">

/**
 * Streaming variant of `writeSplitManifests`: derives the per-split source-id .txt manifests +
 * `SPLIT_MANIFEST.json` by streaming three per-split labeled-row jsonl files (one per split).
 *
 * Memory cost is O(1) — `sort(1)` from coreutils handles the deterministic sort
 * with disk spill for files that exceed in-memory thresholds.
 *
 * Used by `buildCorpus` after the align loop has already partitioned labeled rows
 * into `labeled-{train,val,test}.jsonl` via `splitForRow`.
 * Counts are pre-computed by the align loop and passed in (zero re-scan).
 */
export async function writeSplitManifestsFromLabeledFiles(opts: {
	labeledPaths: Record<SplitName, string>
	outputDir: PathBuilderLike
	corpusVersion: string
	counts: Record<SplitName, number>
	holdouts?: Record<string, CountryHoldout>
}): Promise<SplitManifest["counts"]> {
	await makeDirectories(opts.outputDir)
	const holdouts = opts.holdouts ?? defaultHoldouts()

	for (const split of ["train", "val", "test"] as const) {
		const labeledPath = opts.labeledPaths[split]
		const outPath = join(opts.outputDir, `${split}.txt`)
		await streamSortedSourceIDs(labeledPath, outPath)
	}

	const total = opts.counts.train + opts.counts.val + opts.counts.test

	const summary = {
		corpus_version: opts.corpusVersion,
		holdouts,
		counts: { ...opts.counts, total },
	}

	await writeLocalJSONFile(summary, opts.outputDir, "SPLIT_MANIFEST.json")

	return summary.counts
}

/**
 * Extract `source_id`s from a labeled jsonl file, write them sorted to `outPath`.
 *
 * Empty input → empty output file (not absent).
 * Uses `sort(1)` for disk-spilling external sort so peak memory stays O(1) regardless of labeled-row count.
 */
async function streamSortedSourceIDs(labeledJsonlPath: string, outPath: string): Promise<void> {
	const unsortedPath = `${outPath}.unsorted`
	const out = openWriteStream(unsortedPath, { encoding: "utf8" })

	const outClosed = new Promise<void>((resolve, reject) => {
		out.on("close", () => resolve())
		out.on("error", reject)
	})

	// JSONSpliterator parses each row (skipEmpty drops blank lines); a malformed row throws
	// SyntaxError out of the loop, matching the prior `reject(err)` fail-loud behavior.
	// `finally` always ends the write stream so `sort` reads a complete file even if the read throws.
	try {
		for await (const obj of JSONSpliterator.fromAsync<{ source_id?: string }>(delimitedSource(labeledJsonlPath))) {
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
		const proc = spawnProcess("sort", [unsortedPath, "-o", outPath], { env: childEnv({ LC_ALL: "C" }) })
		proc.on("error", reject)

		proc.on("exit", (code) => {
			if (code === 0) {
				resolve()
			} else {
				reject(new Error(`sort exited with code ${code}`))
			}
		})
	})

	await removePath(unsortedPath).catch(() => {})
}
