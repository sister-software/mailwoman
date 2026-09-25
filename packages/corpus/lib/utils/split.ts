/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Splits corpus rows into train, val and test by holding out whole places.
 *
 *   A random row split leaks by neighborhood, because the model can memorize a street it saw in
 *   train. Rows inside a held-out place go to val or test, split 50/50 by a hash of `source_id`.
 *   Every other row goes to train.
 *
 *   A holdout change takes effect at the next corpus rebuild. Each versioned corpus keeps the
 *   `SPLIT_MANIFEST.json` it was built with, because adding a holdout to a built corpus would
 *   leak rows the model already trained on.
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
 * Sources carry a place in different components.
 * `usgov-nad` and `tiger` emit `region`, but BAN emits no `region`,
 * so a French holdout must also match on postcode.
 *
 * A row is held out when any declared matcher fires.
 * A policy with no matchers holds out nothing.
 */
export interface HoldoutPolicy {
	/**
	 * Exact values matched against `row.components.region`.
	 */
	regions?: readonly string[]
	/**
	 * Prefixes matched against `row.components.postcode`.
	 *
	 * Use a prefix only where it identifies one place by itself.
	 * For example, the first two digits of a French postcode are its department.
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
 * The bare array means a list of region values.
 * Older committed `SPLIT_MANIFEST.json` files use that form.
 */
export type CountryHoldout = readonly string[] | HoldoutPolicy

/**
 * Options for {@link splitRows}.
 */
export interface SplitOptions {
	/**
	 * The holdout policy keyed by ISO 3166-1 alpha-2 country code.
	 *
	 * Defaults to `defaultHoldouts()`.
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
	/**
	 * The holdouts used to build this manifest.
	 */
	holdouts: Record<string, CountryHoldout>
	/**
	 * The corpus version, read from the first row that has one.
	 */
	corpus_version: string
	/**
	 * The row count of each split and their total.
	 */
	counts: { train: number; val: number; test: number; total: number }
}

/**
 * Returns the default holdouts: small, peripheral places in each country.
 *
 * A change here takes effect at the next base corpus rebuild.
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
			// DE street rows come from two OpenAddresses members, Berlin and Sachsen,
			// so the regions above match no street row.
			// Postcode area `02` is Upper Lusatia in eastern Sachsen and supplies the street-level holdout.
			// A German postcode has five digits, so `02` cannot collide with another area.
			postcodePrefixes: ["02"],
		},
		GB: {
			// GB street rows carry no region, so the holdout matches postcode areas:
			// Truro, Llandudno and Halifax.
			// Each prefix has two letters and none is a prefix of another.
			// A one-letter prefix such as `L` (Liverpool) would also match `LL`.
			postcodePrefixes: ["TR", "LL", "HX"],
			// Cornwall matches the admin rows for the same place that `TR` covers.
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
 * Returns the split for one row.
 *
 * Both `splitRows` and the streaming `buildCorpus` loop call this, so every
 * caller assigns a row to the same split.
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
 * Builds a `SplitManifest` in memory from labeled or canonical rows.
 *
 * Tests and small fixtures use this.
 * `buildCorpus` uses `splitForRow` and `writeSplitManifestsFromLabeledFiles`
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
 * Returns a deterministic bucket in `0..n-1` for an id.
 *
 * The bucket comes from the first four bytes of the SHA-256 digest, read as a big-endian uint32.
 */
export function hashBucket(id: string, n: number): number {
	const digest = createHash("sha256").update(id).digest()
	const u = digest[0]! * 0x01_00_00_00 + digest[1]! * 0x01_00_00 + digest[2]! * 0x01_00 + digest[3]!

	return u % n
}

/**
 * Writes a `SplitManifest` to `<outputDir>/{train,val,test}.txt` and `SPLIT_MANIFEST.json`.
 *
 * Each `.txt` file holds sorted `source_id` values, one per line.
 * `SPLIT_MANIFEST.json` holds the corpus version, holdouts and counts.
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
 * Writes the same files as `writeSplitManifests` by streaming one labeled JSONL file per split.
 *
 * `buildCorpus` calls this after its align loop has partitioned rows with `splitForRow`.
 * The caller passes the counts, so this function does not rescan the files.
 * `sort(1)` spills to disk, so memory stays constant.
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
 * Writes the sorted `source_id` values from a labeled JSONL file to `outPath`.
 *
 * An empty input still produces an empty output file.
 */
async function streamSortedSourceIDs(labeledJsonlPath: PathBuilderLike, outPath: PathBuilderLike): Promise<void> {
	const unsortedPath = `${outPath}.unsorted`
	const out = openWriteStream(unsortedPath, { encoding: "utf8" })

	const outClosed = new Promise<void>((resolve, reject) => {
		out.on("close", () => resolve())
		out.on("error", reject)
	})

	// A malformed row throws out of the loop.
	// The `finally` block still closes the write stream.
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
