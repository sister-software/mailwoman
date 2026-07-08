/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared scaffolding for the synthetic-corpus SHARD RECIPES — the common bits the 16
 *   `build-*-shard.mjs` scripts each re-implemented: the seeded LCG PRNG, the tuple reader, and the
 *   canonical → `alignRow` → `LabeledRow` JSONL emit step. A recipe ({@link ShardRecipe}) supplies
 *   only its synthesis + filter; the `mailwoman corpus shard <recipe>` command supplies the I/O.
 */

import { stableSourceID } from "../adapter.js"
import { alignRow } from "../align.js"

/**
 * {@link stableSourceID}, but accepting arbitrary disambiguator keys (e.g. a variant index `v`) that aren't
 * `ComponentTag`s. `stableSourceID` sorts + hashes EVERY key it's given, so passing extra keys is how the legacy
 * builders kept per-variant ids unique — the strict typing is just too narrow for that. Centralizes the one cast.
 */
export function shardSourceID(adapterID: string, parts: Record<string, string | undefined>): string {
	return stableSourceID(adapterID, parts as unknown as Parameters<typeof stableSourceID>[1])
}

/** A (locality, region, postcode, country) source tuple — the input to tuples-mode recipes. */
export interface ShardTuple {
	locality?: string
	region?: string
	postcode?: string
	country?: string
	[k: string]: unknown
}

/**
 * The deterministic LCG (`s = s*1664525 + 1013904223 mod 2^32`) the street/po-box/anchor builders used. A recipe whose
 * legacy `.mjs` seeded this must create it here so `--seed N` is byte-reproducible.
 */
export function makeLcg(seed: number): () => number {
	let s = seed >>> 0

	return () => {
		s = (s * 1664525 + 1013904223) % 4294967296

		return s / 4294967296
	}
}

/** Back-compat alias for {@link makeLcg}. */
export const makeRandom = makeLcg

/**
 * Mulberry32 — the PRNG the MAJORITY of the legacy `build-*-shard` scripts used (german, locale, boundary-stress, unit,
 * fr-order, country-balanced, intersection, fr-admin-split, street-affix, street-bare, po-box-cedex). A recipe must
 * seed it EXACTLY as its `.mjs` did (usually `seed`, but some derive a per-stream seed) to stay byte-reproducible.
 */
export function makeMulberry32(seed: number): () => number {
	let a = seed >>> 0

	return () => {
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/** Stream-parse a tuples JSONL file, yielding each parsed object (blank/invalid lines skipped). */
export async function* readTuples(input: string): AsyncGenerator<ShardTuple> {
	// TextSpliterator (not JSONSpliterator) so a malformed line is SKIPPED, not thrown — the
	// per-line try/catch below is the tolerance this reader has always had.
	const { TextSpliterator } = await import("spliterator")

	for await (const line of TextSpliterator.fromAsync(input)) {
		const trimmed = line.trim()

		if (!trimmed) continue

		try {
			yield JSON.parse(trimmed) as ShardTuple
		} catch {
			// skip malformed line
		}
	}
}

/** A canonical row as the recipes assemble it, before `alignRow` turns it into a `LabeledRow`. */
export interface CanonicalShardRow {
	raw: string
	components: Record<string, string>
	country: string
	locale?: string
	source: string
	source_id: string
	corpus_version?: string
	license?: string
}

/**
 * Run a canonical row through `alignRow` and, on success, write the `LabeledRow` (+ `synth_method` / `synth_base_id`)
 * as one JSONL line. Returns true if emitted, false if alignment quarantined it.
 */
export function alignAndWrite(
	write: (line: string) => void,
	canonical: CanonicalShardRow,
	synthMethod: string,
	synthBaseID: string | null = null
): boolean {
	const aligned = alignRow(canonical as Parameters<typeof alignRow>[0])

	if (!aligned.row) return false
	write(JSON.stringify({ ...aligned.row, synth_method: synthMethod, synth_base_id: synthBaseID }) + "\n")

	return true
}

/** Parsed options a recipe's `run` receives. Common fields + the union of recipe-specific flags. */
export interface ShardRecipeOpts {
	output: string
	seed: number
	variants: number
	input?: string
	count?: number
	golden?: boolean
	sourceName?: string
	// recipe-specific (each recipe reads only what it needs):
	houseNumberProb?: number
	pmbRatio?: number
	militaryRatio?: number
	reversedFraction?: number
	edgesDir?: string
	country?: string
	intlFraction?: number
	bareProb?: number
	hnProb?: number
	communes?: string
	multilocaleCount?: number
}

/** Tally a recipe returns. */
export interface ShardStats {
	read?: number
	emitted: number
	skipped: number
}

/** A single declared recipe-specific option flag (for the command's --help). */
export interface ShardRecipeOption {
	flag: string
	description: string
}

/** A shard recipe: its identity, input mode, and its synthesis `run`. */
export interface ShardRecipe {
	/** Recipe id, e.g. "street", "po-box" — the `<recipe>` positional. */
	name: string
	/** One-line description for `--list` / help. */
	description: string
	/** `tuples` reads `--input` JSONL; `generate` self-generates `--count` rows. */
	mode: "tuples" | "generate"
	/** Recipe-specific flags this recipe honors (documentation only). */
	options?: ShardRecipeOption[]
	/**
	 * Do the build: create the recipe's PRNG from `opts.seed` (its LEGACY generator — `makeLcg` or `makeMulberry32` — for
	 * byte-reproducibility), synthesize, and emit each row via `write`.
	 */
	run(opts: ShardRecipeOpts, write: (line: string) => void): Promise<ShardStats>
}
