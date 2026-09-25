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
 * For example, mailing addresses often use post-office boxes, so mixing roles in
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
	 * The place where post is delivered, which is often a post-office box.
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
 * A template rendering of a real register record is `Composed`, and it is still a real address.
 */
export const SurfaceOrigin = {
	/**
	 * The publisher's own string, carried through unchanged.
	 */
	Attested: "attested",
	/**
	 * A template assembled the text from the published fields of one real record.
	 *
	 * The recipe chooses the order, punctuation and casing.
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
 * Provenance fields that every corpus row carries.
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
	 * SQLite-backed adapters use the primary key, and file-backed adapters usually hash the components.
	 */
	source_id: string

	/**
	 * The corpus version, which the runner stamps.
	 */
	corpus_version: string

	/**
	 * The license label or SPDX id for this row.
	 *
	 * It defaults to the adapter's `defaultLicense`, and sources with per-record terms override it.
	 */
	license: string
}

/**
 * The recipe that produced a row and the row it was derived from.
 */
export interface RecipeMarker {
	/**
	 * A stable recipe id, such as `"german"` or `"compose:case-perturb+typo"`.
	 */
	recipe: string

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
	 * The BCP-47 locale, which the runner derives from the country when absent.
	 */
	locale?: string

	/**
	 * The role of this address.
	 *
	 * The runner stamps the adapter's `addressRole` on rows that omit it.
	 * An adapter sets it per row only when one source carries several roles.
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
	 * The recipe that produced the row, when a recipe did.
	 */
	recipe?: RecipeMarker
}

/**
 * A row after alignment, with tokens, BIO labels and character spans.
 *
 * The span arrays are the source of truth, and token labels can be derived from them.
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
	 * `raw` must be NFC-normalized, and `alignRow` enforces both rules.
	 * Older corpora and some synthesis paths omit the spans.
	 */
	span_starts?: readonly number[]

	/**
	 * Exclusive end offsets, parallel to `span_starts`.
	 */
	span_ends?: readonly number[]

	/**
	 * Component tags, parallel to `span_starts`.
	 */
	span_tags?: readonly ComponentTag[]
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
	 * The adapter's input, which each adapter interprets as a file, a directory or a URL.
	 */
	inputPath: PathBuilderLike

	/**
	 * An output directory for adapters that keep side state.
	 */
	outputDir?: string

	/**
	 * An ISO 3166-1 alpha-2 country filter.
	 *
	 * Multi-country adapters must apply it, and single-country adapters should reject a mismatch.
	 */
	country?: string

	/**
	 * A soft cap on emitted rows.
	 */
	limit?: number

	/**
	 * The fraction of rows that carry an explicit `country` component.
	 *
	 * A source without country tokens teaches the model that country tokens are rare,
	 * which lowers `country` recall.
	 * A value of `0` or no value adds no country and consumes no random draw,
	 * so existing outputs stay identical.
	 */
	countryFraction?: number

	/**
	 * The seed for the {@linkcode AdapterOptions.countryFraction} draw, which has a fixed default.
	 */
	seed?: number

	/**
	 * A cancellation signal that adapters should check at each iteration.
	 */
	signal?: AbortSignal
}

/**
 * The interface that every data source implements.
 *
 * Adapters stream rows, because many sources hold tens of millions of rows.
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
	 * They must not set `corpus_version`, which the runner stamps, or mutate rows already yielded.
	 */
	rows(opts: AdapterOptions): AsyncIterable<CanonicalRow>
}
