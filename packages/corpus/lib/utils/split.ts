/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Splits corpus rows into train, val and test by holding out whole places: a random row split leaks by
 * neighborhood, because the model can memorize a street it saw in train. Rows inside a held-out place
 * go to val or test 50/50 by a hash of `source_id`; every other row goes to train.
 *
 * A holdout change takes effect at the next corpus rebuild, and each versioned corpus keeps the
 * `SPLIT_MANIFEST.json` it was built with, because adding a holdout to a built corpus would leak rows
 * the model already trained on.
 */

import { delimitedSource, preferCompressed } from "@mailwoman/core/fs/delimited"
import { openWriteStream } from "@mailwoman/core/fs/streams"
import { writeLocalJSONFile, writeLocalTextFile, makeDirectories, removePath } from "@mailwoman/core/fs/writers"
import { createHash } from "@mailwoman/core/hash"
import { spawnProcess } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { type PathBuilderLike, resolvePathBuilder } from "path-ts"
import { JSONSpliterator } from "spliterator"

import type { CanonicalRow, LabeledRow } from "#types"

/**
 * The name of one corpus split.
 */
export type SplitName = "train" | "val" | "test"

/**
 * The component values that identify the places one country holds out.
 *
 * Sources carry a place in different components: `usgov-nad` and `tiger` emit `region`,
 * but BAN emits none, so a French holdout must also match on postcode.
 * A row is held out when any declared matcher fires; a policy with no matchers holds out no entry.
 */
export interface HoldoutPolicy {
	regions?: readonly string[]
	/**
	 * Prefixes matched against `row.components.postcode`; use one only where it identifies
	 * a single place by itself, such as the first two digits of a French postcode.
	 */
	postcodePrefixes?: readonly string[]
	localities?: readonly string[]
}

/**
 * One country's holdout, as a bare region list or as a {@link HoldoutPolicy}; the bare array means
 * a list of region values, which is the form older committed `SPLIT_MANIFEST.json` files use.
 */
export type CountryHoldout = readonly string[] | HoldoutPolicy

/**
 * Options for {@link splitRows}.
 */
export interface SplitOptions {
	/**
	 * The holdout policy keyed by ISO 3166-1 alpha-2 country code.
	 */
	holdouts?: Record<string, CountryHoldout>
}

/**
 * The `source_id` lists for each split.
 */
export interface SplitManifest {
	train: string[]
	val: string[]
	test: string[]
	holdouts: Record<string, CountryHoldout>
	/**
	 * The corpus version, read from the first row that has one.
	 */
	corpus_version: string
	counts: { train: number; val: number; test: number; total: number }
}

/**
 * Returns the default holdouts — small, peripheral places in each country;
 * a change here takes effect at the next base corpus rebuild.
 */
export function defaultHoldouts(): Record<string, CountryHoldout> {
	return {
		US: ["Vermont", "VT", "Wyoming", "WY", "North Dakota", "ND"],
		FR: {
			regions: ["Corse", "Lozère", "Lozere", "Creuse"],
			// BAN street rows carry no region, so these postcode departments hold out the
			// same three places: Corse 20, Creuse 23 and Lozère 48.
			postcodePrefixes: ["20", "23", "48"],
		},
		DE: {
			// Only `wof-admin` carries a DE region, so these Länder hold out admin rows alone.
			regions: ["Saarland", "SL", "Mecklenburg-Vorpommern", "MV"],
			// DE street rows come from two OpenAddresses members, Berlin and Sachsen, so the regions
			// above match no street row; postcode area `02` (Upper Lusatia in eastern Sachsen) is
			// the street-level holdout, and a five-digit German postcode means it cannot collide.
			postcodePrefixes: ["02"],
		},
		GB: {
			// GB street rows carry no region, so the holdout matches postcode areas — Truro,
			// Llandudno and Halifax; each prefix has two letters and none is a prefix of
			// another (`L` for Liverpool would also match `LL`).
			postcodePrefixes: ["TR", "LL", "HX"],
			// Cornwall matches the admin rows for the same place `TR` covers.
			regions: ["Cornwall"],
		},
	}
}

/**
 * Returns the matchers for one country, reading a bare array as a region list.
 */
export function holdoutPolicyFor(holdout: CountryHoldout | undefined): HoldoutPolicy {
	if (!holdout) return {}

	return Array.isArray(holdout) ? { regions: holdout } : (holdout as HoldoutPolicy)
}

type SplitInputRow = Pick<CanonicalRow, "source_id" | "country" | "corpus_version" | "components">

/**
 * Returns the split for one row; both `splitRows` and the streaming `buildCorpus`
 * loop call this, so every caller assigns a row to the same split.
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

	return hashBucket(row.source_id, 2) === 0 ? "val" : "test"
}

/**
 * Builds a `SplitManifest` in memory from labeled or canonical rows; tests and small fixtures
 * use this, while `buildCorpus` uses `splitForRow` and `writeSplitManifestsFromLabeledFiles`
 * so it never holds every row's split in memory.
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
 * Returns a deterministic bucket in `0..n-1` for an id, from the first four bytes
 * of the SHA-256 digest read as a big-endian uint32.
 */
export function hashBucket(id: string, n: number): number {
	const digest = createHash("sha256").update(id).digest()
	const u = digest[0]! * 0x01_00_00_00 + digest[1]! * 0x01_00_00 + digest[2]! * 0x01_00 + digest[3]!

	return u % n
}

/**
 * Writes a `SplitManifest` to `<outputDir>/{train,val,test}.txt` (sorted `source_id` values, one per line)
 * and `SPLIT_MANIFEST.json` (the corpus version, holdouts and counts).
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
 * The `LabeledRow` fields that the split functions read.
 */
export type SplitInputLabeledRow = Pick<LabeledRow, "source_id" | "country" | "corpus_version" | "components">

/**
 * Writes the same files as `writeSplitManifests` by streaming one labeled JSONL file
 * per split; `buildCorpus` calls this after its align loop has partitioned rows
 * with `splitForRow`, the caller passes the counts so the files are not rescanned,
 * and `sort(1)` spills to disk so memory stays constant.
 */
export async function writeSplitManifestsFromLabeledFiles(opts: {
	labeledPaths: Record<SplitName, PathBuilderLike>
	outputDir: PathBuilderLike
	corpusVersion: string
	counts: Record<SplitName, number>
	holdouts?: Record<string, CountryHoldout>
}): Promise<SplitManifest["counts"]> {
	await makeDirectories(opts.outputDir)
	const holdouts = opts.holdouts ?? defaultHoldouts()

	for (const split of ["train", "val", "test"] as const) {
		const labeledPath = opts.labeledPaths[split]
		const outPath = resolvePathBuilder(opts.outputDir, `${split}.txt`)
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
 * Writes the sorted `source_id` values from a labeled JSONL file to `outPath`;
 * an empty input still produces an empty output file.
 */
async function streamSortedSourceIDs(labeledJsonlPath: PathBuilderLike, outPath: PathBuilderLike): Promise<void> {
	const unsortedPath = `${outPath}.unsorted`
	const out = openWriteStream(unsortedPath, { encoding: "utf8" })

	const outClosed = new Promise<void>((resolve, reject) => {
		out.on("close", () => resolve())
		out.on("error", reject)
	})

	// A malformed row throws out of the loop; the `finally` block still closes the write stream.
	try {
		for await (const obj of JSONSpliterator.fromAsync<{ source_id?: string }>(
			delimitedSource(await preferCompressed(labeledJsonlPath))
		)) {
			if (typeof obj.source_id === "string") {
				out.write(`${obj.source_id}\n`)
			}
		}
	} finally {
		out.end()
	}

	await outClosed

	await new Promise<void>((resolve, reject) => {
		// `LC_ALL=C` sorts by byte, so the order is the same on every host.
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
