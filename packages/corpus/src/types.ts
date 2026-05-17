/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Canonical row schemas for the corpus pipeline (per #6 / Phase 1 plan).
 *
 *   The corpus pipeline produces two row shapes:
 *
 *   1. `CanonicalRow`: an adapter's raw output. Carries a free-form `raw` string, a per-component
 *        ground-truth dict, provenance, and an optional augmentation marker. Adapters emit these.
 *   2. `LabeledRow`: alignment's output. Adds a SentencePiece token list and a parallel BIO label list,
 *        suitable for direct ingestion by the neural training loop.
 *
 *   `CorpusAdapter` is the contract every data source implements; `AdapterOptions` is the
 *   per-invocation knob set (input path, optional country filter, row cap, abort signal).
 */

import type { BioLabel, ComponentTag } from "@mailwoman/core/types"

/**
 * Provenance + augmentation metadata that travels with every corpus row.
 *
 * `synth` is `undefined` for natural (un-augmented) rows; present only when a row was produced by
 * the synthesis pipeline (see `synthesize.ts`).
 */
export interface SourceProvenance {
	/** Adapter id that emitted this row, e.g. `"wof-admin"`, `"ban"`, `"openaddresses"`. */
	source: string

	/**
	 * Stable id within the adapter's source. For SQLite-backed adapters this is the row's primary
	 * key; for CSV/GeoJSON, a hash of the canonical components. Must be stable across reruns so that
	 * dedup and holdout manifests are reproducible.
	 */
	source_id: string

	/**
	 * Corpus version string. Stamped by the runner, not the adapter. Locked together with the
	 * tokenizer version: `corpus-v0.1.0` ships with `tokenizer-v0.1.0`.
	 */
	corpus_version: string

	/**
	 * Short license label or SPDX id for _this_ row. Defaults to the adapter's `defaultLicense`, but
	 * per-row sources (OpenAddresses) override.
	 */
	license: string
}

/**
 * Marker placed on rows produced by `synthesize.ts`. Allows downstream code to weight, stratify, or
 * exclude augmentations.
 */
export interface SynthMarker {
	/**
	 * Pipeline id describing what augmentation produced this row. Free-form but stable — e.g.
	 * `"case-perturb"`, `"accent-strip"`, `"abbrev-swap"`, `"compose:case-perturb+typo"`.
	 */
	method: string

	/**
	 * `source_id` of the un-augmented row this was derived from. Allows tracing every synthetic row
	 * back to its natural ancestor.
	 */
	base_source_id: string
}

/**
 * One address row, before tokenization + BIO labeling.
 *
 * `raw` is what a parser would see in the wild — possibly multi-line, with arbitrary whitespace.
 * `components` is the ground-truth tagging: every `ComponentTag` present in the source data, mapped
 * to its surface form _as it appears in `raw`_. Alignment uses this to assign BIO labels.
 *
 * Country is ISO 3166-1 alpha-2 (`"US"`, `"FR"`). Locale is BCP-47 (`"en-US"`, `"fr-FR"`) and is
 * optional; adapters that can't be sure leave it empty and let the runner default by country.
 */
export interface CanonicalRow extends SourceProvenance {
	/** Address string as it might appear in source data. */
	raw: string

	/**
	 * Component-by-tag ground truth. Surface forms must occur in `raw` (within the alignment edit
	 * distance threshold) or the row will land in the quarantine pile.
	 */
	components: Partial<Record<ComponentTag, string>>

	/** ISO 3166-1 alpha-2 country code. */
	country: string

	/** Optional BCP-47 locale. Defaulted by country if absent. */
	locale?: string

	/** Present only on synthetic rows. */
	synth?: SynthMarker
}

/**
 * Output of `align.ts`. Carries everything `CanonicalRow` does, plus parallel `tokens` and `labels`
 * arrays of identical length. `labels[i]` is the BIO tag for `tokens[i]`.
 */
export interface LabeledRow extends CanonicalRow {
	/** SentencePiece subword tokens for `raw`. */
	tokens: readonly string[]

	/** BIO labels, one per token. Same length as `tokens`. */
	labels: readonly BioLabel[]
}

/**
 * A row that alignment refused to label. Lands in `/data/corpus/quarantine/` for human review.
 *
 * The `reason` is human-readable; common values are `"component-not-found:<tag>"`,
 * `"edit-distance-exceeded:<tag>"`, `"raw-empty"`. Re-running alignment after a fix should re-emit
 * the quarantined rows; the runner keys them by `source_id`.
 */
export interface QuarantinedRow {
	row: CanonicalRow
	reason: string
}

/**
 * Per-invocation knobs handed to an adapter by the runner.
 *
 * `inputPath` is interpreted by the adapter — it might be a single file path, a directory of
 * shards, or even an HTTPS URL. Each adapter documents its own expected shape in its README.
 *
 * `country` filters to a single ISO 3166-1 alpha-2 country _at the adapter level_. Adapters that
 * hold multi-country data (OSM PBF, OpenAddresses) MUST honor this; single-country adapters (BAN)
 * may ignore it but should reject mismatches.
 *
 * `limit` is a soft cap on rows emitted; useful for fixture-driven tests and smoke runs.
 *
 * `signal` allows the runner to cancel a long-running scan cleanly.
 */
export interface AdapterOptions {
	/** Path to the adapter's input data (file, directory, or URL — adapter-specific). */
	inputPath: string

	/** Optional output directory, available to adapters that maintain side state (rare). */
	outputDir?: string

	/** ISO 3166-1 alpha-2 country filter. */
	country?: string

	/** Soft row cap. Adapters should stop iterating once this is reached. */
	limit?: number

	/** Cancellation hook. Adapters should respect this on every iteration boundary. */
	signal?: AbortSignal
}

/**
 * The contract every data source implements.
 *
 * Adapters are async generators: they yield `CanonicalRow`s one at a time, the runner consumes them
 * (writing JSONL + maintaining checksums + driving alignment). Streaming is mandatory — many
 * sources are tens of millions of rows and cannot be buffered.
 *
 * `defaultLicense` is stamped onto every emitted row's `license` field unless the adapter sets
 * `license` explicitly (e.g. OpenAddresses, which carries per-source licenses).
 */
export interface CorpusAdapter {
	/** Stable, machine-friendly id used in paths and CLI args. E.g. `"wof-admin"`. */
	readonly id: string

	/** Default SPDX-ish license label for rows from this adapter. Per-row overrides allowed. */
	readonly defaultLicense: string

	/** One-sentence description shown by `npx mailwoman corpus list`. */
	readonly description: string

	/**
	 * Async iterable of canonical rows.
	 *
	 * Implementations MUST:
	 *
	 * - Honor `opts.country` (filter or reject mismatches).
	 * - Honor `opts.limit` (stop after N rows).
	 * - Respect `opts.signal` on every iteration.
	 * - Set `source` to `this.id` on every emitted row.
	 * - Set `license` to `this.defaultLicense` unless overriding per-row.
	 *
	 * Implementations MUST NOT:
	 *
	 * - Set `corpus_version` (the runner stamps it).
	 * - Mutate previously-yielded rows.
	 */
	rows(opts: AdapterOptions): AsyncIterable<CanonicalRow>
}
