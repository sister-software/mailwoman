/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Row, adapter and provenance types for the corpus pipeline.
 */

import type { BIOLabel, ComponentTag } from "@mailwoman/codex/component"
import { stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"

/**
 * The role that an address plays for the entity that the source describes.
 * The values are wire values.
 *
 * Roles have different grammars.
 * For example, some mailing addresses use post-office boxes, so mixing roles in
 * a corpus shifts what the premise parser learns.
 */
export const AddressRole = {
	/**
	 * The location of the addressable object, as in a national address register.
	 */
	Premise: "premise",
	/**
	 * The seat that an entity files with a registrar, such as a siège social.
	 */
	RegisteredOffice: "registered-office",
	/**
	 * The address a third party records for a transacting party on its own transaction record,
	 * such as the supplier on a government contract notice.
	 *
	 * The party supplied the address to the recording body rather than to a registrar.
	 * No registrar filed it as a seat, and no address register confirmed it as a premise.
	 * A sole trader's entry can hold a home address.
	 */
	Counterparty: "counterparty",
	/**
	 * The place where post is delivered.
	 * This can be a post-office box.
	 */
	Mailing: "mailing",
	/**
	 * The place where a licensed person or organization practices.
	 */
	Practice: "practice",
	/**
	 * A site that an entity operates, such as a clinic, a school or a plant.
	 */
	Facility: "facility",
	/**
	 * The address of a property's owner, recorded against the property.
	 */
	Owner: "owner",
	/**
	 * The place where a service is delivered or an obligation is discharged.
	 */
	Service: "service",
	/**
	 * The address for service of legal process.
	 */
	LegalNotice: "legal-notice",
	/**
	 * A role that this vocabulary does not cover.
	 *
	 * Add a new constant when a second uncovered role appears.
	 */
	Other: "other",
} as const

/**
 * One of the {@link AddressRole} values.
 */
export type AddressRole = (typeof AddressRole)[keyof typeof AddressRole]

/**
 * The role of a row without an `addressRole` field.
 *
 * Corpora written before the field existed came from premise sources.
 */
export const DEFAULT_ADDRESS_ROLE: AddressRole = AddressRole.Premise

/**
 * Returns the row's address role, or {@link DEFAULT_ADDRESS_ROLE} when the field is absent.
 */
export function addressRoleOf(row: Pick<CanonicalRow, "addressRole">): AddressRole {
	return row.addressRole ?? DEFAULT_ADDRESS_ROLE
}

/**
 * How a row's `raw` text was produced.
 * The values are wire values.
 *
 * This is separate from {@link CanonicalRow.register}, which records where the underlying record came from.
 * A rendering of a real register record is `Rendered` or `Composed`, and it is still a real address.
 */
export const SurfaceOrigin = {
	/**
	 * The publisher's own string, preserved unchanged.
	 *
	 * No adapter in the tree emits this today: each one builds its line from the source's fields.
	 * The value is reserved for a source that publishes the written line itself,
	 * such as a register storing `address1` as a person typed it.
	 */
	Attested: "attested",
	/**
	 * An adapter assembled the line from one record's fields, in that locale's canonical order.
	 *
	 * The order comes from the codex layout or the adapter's own template rather than from the
	 * publisher, so the components are the source's and the written form is this repository's.
	 * Distinct from {@link SurfaceOrigin.Composed} because an adapter renders one canonical
	 * form per record while a recipe varies the form deliberately.
	 *
	 * A source id beginning `rendered-` does not take this value.
	 * `SourceOperation.Rendered` in `#recipes/sources` names a recipe operation with the same word,
	 * and those recipes record {@link SurfaceOrigin.Composed} because they vary the form.
	 *
	 * Read the row's `surface` rather than its source name to learn which of the two produced it.
	 */
	Rendered: "rendered",
	/**
	 * A recipe assembled the text from the published fields of one real record.
	 *
	 * The recipe chooses the order, punctuation and casing.
	 * It varies them to teach a surface.
	 */
	Composed: "composed",
	/**
	 * A synthetic row, such as a post-office box or an intersection, that corresponds to no published record.
	 */
	Invented: "invented",
} as const

/**
 * One of the {@link SurfaceOrigin} values.
 */
export type SurfaceOrigin = (typeof SurfaceOrigin)[keyof typeof SurfaceOrigin]

const SURFACE_ORIGINS = new Set<string>(Object.values(SurfaceOrigin))

/**
 * Returns the `surface` that a JSONL row declares.
 *
 * @throws When the row lacks a valid `surface`.
 * Older files must be regenerated instead of read with a default.
 */
export function requireSurface(raw: Record<string, unknown>, producer: string): SurfaceOrigin {
	const value = raw["surface"]

	if (typeof value === "string" && SURFACE_ORIGINS.has(value)) return value as SurfaceOrigin

	throw new Error(
		`${producer}: row ${stringifyJSON(raw["source_id"])} declares no surface. ` +
			`Every row carries one of ${[...SURFACE_ORIGINS].join(", ")}. ` +
			`A jsonl written before the field existed has to be regenerated rather than read with a default.`
	)
}

/**
 * Provenance fields present on every corpus row.
 *
 * Two related facts are recorded per source rather than per row.
 * `createIneligibilityReader` in `build/eligibility.ts` joins `source` against the
 * address-source register and refuses the row at build time, so a release-profile corpus
 * holds eligible rows by construction and `TRAINING_SOURCES.json` records each refusal.
 *
 * A per-row eligibility field would copy a per-source decision onto every row
 * and would disagree with the register after a review changed a license's state.
 * Whether a row reached a checkpoint is a property of a run rather than of the corpus.
 *
 * And the sampler draws a different sample per epoch, so `deriveEffectiveTrainingManifest`
 * records it per source from a config and an `audit_epoch_mixture` output.
 */
export interface SourceProvenance {
	/**
	 * The id of the adapter or recipe that emitted the row, such as `"ban"` or `"openaddresses"`.
	 */
	source: string

	/**
	 * An id that is unique within the source and stable across reruns,
	 * so that deduplication and holdouts reproduce.
	 *
	 * SQLite-backed adapters use the primary key.
	 * File-backed adapters hash the components.
	 */
	source_id: string

	/**
	 * The producer's statement of the terms its rows are under, such as an adapter's `defaultLicense`.
	 *
	 * The parquet `license` column holds a different value.
	 * A parquet writer writes the SPDX or `LicenseRef-*` id of the source's register inputs there.
	 *
	 * The id comes from `#source-register/row-license`.
	 * The writer records this statement in the file's `RECORD.json` under `licenseStatements`.
	 *
	 * @defaultValue the adapter's `defaultLicense`, and sources with per-record terms override it.
	 */
	license: string
}

/**
 * The augmentation that derived a row from a base row, and that base row.
 */
export interface AugmentationMarker {
	/**
	 * A stable augmentation name, such as `"case-lower"` or `"compose:case-perturb+typo"`.
	 */
	name: string

	/**
	 * The `source_id` of the row that this row was derived from.
	 */
	base_source_id: string
}

/**
 * One address row before tokenization and labeling.
 *
 * Each value in `components` must appear in `raw`, within the alignment edit-distance
 * threshold, or alignment quarantines the row.
 */
export interface CanonicalRow extends SourceProvenance {
	/**
	 * The address text as it might appear in source data, possibly spanning lines.
	 */
	raw: string

	/**
	 * The ground-truth text of each component, as it appears in `raw`.
	 */
	components: Partial<Record<ComponentTag, string>>

	/**
	 * The ISO 3166-1 alpha-2 country code.
	 */
	country: string

	/**
	 * The BCP-47 locale.
	 * The runner derives it from the country when absent.
	 */
	locale?: string | null

	/**
	 * The role of this address.
	 *
	 * The runner stamps the adapter's `addressRole` on rows that omit it.
	 * An adapter sets it per row only when one source has several roles.
	 * Read it with {@link addressRoleOf}.
	 */
	addressRole?: AddressRole

	/**
	 * The stable id of the publication that the row's record came from, such as `"us-census-tiger"`.
	 *
	 * `null` means that the row corresponds to no published record.
	 * The runner stamps {@link CorpusAdapter.register} on rows that leave it unset.
	 * Rights records and supply counts read this field.
	 */
	register?: string | null

	/**
	 * How the row's `raw` text was produced.
	 *
	 * The runner stamps {@link CorpusAdapter.surface} on rows that omit it.
	 */
	surface?: SurfaceOrigin

	/**
	 * The augmentation that derived the row from a base row, when one did.
	 *
	 * The row's producer is its `source`.
	 */
	augmentation?: AugmentationMarker | null
}

/**
 * A row after alignment, with tokens, BIO labels and character spans.
 *
 * The span arrays are authoritative when they disagree with any other field.
 * Consumers can derive token labels from them.
 */
export interface LabeledRow extends CanonicalRow {
	/**
	 * Subword tokens for `raw`.
	 */
	tokens: readonly string[]

	/**
	 * BIO labels, one per token.
	 */
	labels: readonly BIOLabel[]

	/**
	 * Inclusive start offsets of the label spans over `raw`, in UTF-16 code units.
	 *
	 * The three span arrays are parallel.
	 * Spans are sorted by start and never overlap.
	 *
	 * `raw` must be NFC-normalized.
	 * `alignRow` enforces both rules.
	 * Older corpora and some synthesis paths omit the spans.
	 */
	span_starts?: readonly number[] | null

	/**
	 * Exclusive end offsets, parallel to `span_starts`.
	 */
	span_ends?: readonly number[] | null

	/**
	 * Component tags, parallel to `span_starts`.
	 */
	span_tags?: readonly ComponentTag[] | null
}

/**
 * A row that alignment refused to label, with a reason such as `"component-not-found:<tag>"`.
 */
export interface QuarantinedRow {
	row: CanonicalRow
	reason: string
}

/**
 * Per-run options that the runner passes to an adapter.
 */
export interface AdapterOptions {
	/**
	 * The adapter's input.
	 * Each adapter interprets it as a file, directory or URL.
	 */
	inputPath: PathBuilderLike

	/**
	 * An output directory for adapters that keep side state.
	 */
	outputDir?: string

	/**
	 * An ISO 3166-1 alpha-2 country filter.
	 *
	 * Multi-country adapters must apply it.
	 * Single-country adapters should reject a mismatch.
	 */
	country?: string

	/**
	 * A soft cap on emitted rows.
	 */
	limit?: number | null

	/**
	 * The fraction of rows that include an explicit `country` component.
	 *
	 * A source without country tokens teaches the model that country tokens are rare.
	 * That lowers `country` recall.
	 *
	 * A value of `0` or no value adds no country and consumes no random draw,
	 * so existing outputs stay identical.
	 */
	countryFraction?: number | null

	/**
	 * The seed for the {@linkcode AdapterOptions.countryFraction} draw.
	 * The draw has a fixed default.
	 */
	seed?: number | null

	/**
	 * Rows to keep, chosen by structure cell before rendering, for an adapter
	 * that can enumerate its rows twice.
	 *
	 * The WOF adapters read it.
	 * Every other adapter renders all of its rows.
	 */
	sample?: RowSample | null

	/**
	 * A cancellation signal that adapters should check at each iteration.
	 */
	signal?: AbortSignal

	/**
	 * Counts of input records the adapter refused or trimmed, keyed by reason.
	 *
	 * An adapter that drops a record increments a `row:<reason>` key, and one that keeps the row
	 * but discards a component increments a `component:<tag>:<reason>` key.
	 * A `kept:<condition>` key counts records kept under a condition the reader should see,
	 * such as a country the record does not state.
	 *
	 * The runner writes the map into `MANIFEST.json` as `dropped`, so the gap between a
	 * source's record count and the rows written has a counted reason.
	 * An adapter that does not count leaves the map empty.
	 *
	 * The manifest records that as an empty object rather than as zero drops of a specific kind.
	 */
	dropped?: Map<string, number>
}

/**
 * The rows an adapter keeps out of everything it could render.
 *
 * A row is kept when its hash is among the `cellFloor` lowest of its structure cell
 * or of its language cell, or among the `rowsPerCountry` lowest of its country.
 * The adapter defines the cells.
 */
export interface RowSample {
	/**
	 * Rows each cell keeps.
	 * A cell with fewer rows keeps them all.
	 */
	cellFloor: number
	/**
	 * Rows each country keeps in hash order, beside its floor rows.
	 */
	rowsPerCountry: number
	/**
	 * The hash seed.
	 *
	 * Two builds with the same seed and inputs keep the same rows.
	 */
	seed?: number
	/**
	 * A JSON file to write every cell's renderable row count to, keyed by the adapter's cell key.
	 *
	 * The coverage of a sample is read against these counts, so the full set of rows never has to be built.
	 * Relative paths resolve against the data root.
	 */
	countsFile?: string
}

/**
 * Adds one to `reason` in an adapter's {@link AdapterOptions.dropped} map, when the caller supplied one.
 */
export function countDropped(opts: Pick<AdapterOptions, "dropped">, reason: string): void {
	opts.dropped?.set(reason, (opts.dropped.get(reason) ?? 0) + 1)
}

/**
 * The interface that every data source implements.
 *
 * Adapters stream rows, because some sources hold tens of millions of rows.
 */
export interface CorpusAdapter {
	/**
	 * A stable id used in paths and CLI arguments, such as `"wof-admin"`.
	 */
	readonly id: string

	/**
	 * The license label stamped on rows that do not set their own.
	 */
	readonly defaultLicense: string

	/**
	 * The dominant role of the source's addresses.
	 *
	 * The field has no default because only the adapter's author knows the source.
	 * The runner stamps it on rows that leave `addressRole` unset.
	 */
	readonly addressRole: AddressRole

	/**
	 * The publication that this adapter reads, or `null` for an adapter that invents rows.
	 *
	 * The field has no default because only the adapter's author knows the source.
	 * The runner stamps it on rows that leave `register` unset.
	 */
	readonly register: string | null

	/**
	 * The dominant way the adapter produces `raw` text.
	 *
	 * The runner stamps it on rows that leave `surface` unset.
	 */
	readonly surface: SurfaceOrigin

	/**
	 * The one-sentence description that `mailwoman corpus list` shows.
	 */
	readonly description: string

	/**
	 * Streams canonical rows.
	 *
	 * Implementations must apply `opts.country` and `opts.limit`, check `opts.signal` at each
	 * iteration, set `source` to `this.id`, and set `license` unless a row overrides it.
	 * They must not mutate rows already yielded.
	 */
	rows(opts: AdapterOptions): AsyncIterable<CanonicalRow>
}
