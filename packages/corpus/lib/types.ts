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
 *   `CorpusAdapter` is the interface every data source implements; `AdapterOptions` is the
 *   per-invocation knob set (input path, optional country filter, row cap, abort signal).
 */

import type { BIOLabel, ComponentTag } from "@mailwoman/codex/component"
import { stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"

/**
 * What an address is the address OF.
 * The role it plays for the thing the source is describing.
 *
 * Two strings with the same components can be different addresses.
 * A company's registered office is the address it files with a registrar, its premise is
 * where the building stands, and its mailing address may be a box at a post office it never visits.
 *
 * Each carries its own grammar, and a corpus that mixes them teaches the premise parser
 * the grammar of the others: a register whose addresses are half post-office boxes shifts
 * the prior on a leading designator for every row the model later reads.
 *
 * The constants are the wire values.
 */
export const AddressRole = {
	/**
	 * Where the addressable object is.
	 *
	 * A national address register, an address point, a street-level extract.
	 */
	Premise: "premise",
	/**
	 * The address an entity files with a registrar as its seat.
	 *
	 * A company register's 公司地址, 国内所在地, siège social.
	 */
	RegisteredOffice: "registered-office",
	/**
	 * Where post is delivered, which need not be where anything stands.
	 *
	 * Post-office boxes concentrate here.
	 */
	Mailing: "mailing",
	/**
	 * Where a licensed person or organization practices.
	 *
	 * A provider's practice location, a notary's place of business.
	 */
	Practice: "practice",
	/**
	 * A site an entity operates — a clinic, a school, a library outlet, a plant.
	 */
	Facility: "facility",
	/**
	 * The address of a property's owner, recorded against the property rather than about it.
	 */
	Owner: "owner",
	/**
	 * Where a service is delivered or an obligation is discharged, which a project
	 * record names without the place being anybody's seat.
	 */
	Service: "service",
	/**
	 * The address for service of legal process.
	 */
	LegalNotice: "legal-notice",
	/**
	 * A role the source names and this vocabulary does not cover.
	 *
	 * Add a constant rather than letting a second role accumulate here.
	 */
	Other: "other",
} as const

export type AddressRole = (typeof AddressRole)[keyof typeof AddressRole]

/**
 * The role a row carries when it does not say.
 *
 * Frozen corpora written before the field existed read as premise, which is
 * what the sources that produced them emit.
 * An adapter written after it declares its own role and never relies on this.
 */
export const DEFAULT_ADDRESS_ROLE: AddressRole = AddressRole.Premise

/**
 * The role a row asserts, reading an absent field as {@link DEFAULT_ADDRESS_ROLE}.
 *
 * Use this rather than spelling the default at each call site, so the one place
 * that decides what an absent field means stays one place.
 */
export function addressRoleOf(row: Pick<CanonicalRow, "addressRole">): AddressRole {
	return row.addressRole ?? DEFAULT_ADDRESS_ROLE
}

/**
 * How the text a tokenizer reads was produced.
 *
 * This answers what a row's surface is, and {@link CanonicalRow.register} answers
 * where its underlying record came from.
 * Those are separate questions: a surface composed by a template from a national
 * land register is not an invented address, and a value that answered both at
 * once reported Land Registry records as fabricated.
 *
 * The constants are the wire values.
 */
export const SurfaceOrigin = {
	/**
	 * The publisher's own string, carried through.
	 *
	 * A TIGER street name or a Who's On First place name reaches the corpus as the register wrote it.
	 */
	Attested: "attested",
	/**
	 * A template assembled the surface from fields of one real record.
	 *
	 * Every component is a value the register published.
	 * The order, punctuation and casing are the recipe's, because the register
	 * publishes columns rather than an address line.
	 */
	Composed: "composed",
	/**
	 * The row names no published record.
	 *
	 * A post-office box, an intersection or a boundary-stress row exists to teach a shape,
	 * and no register asserts that this address is anywhere.
	 */
	Invented: "invented",
} as const

export type SurfaceOrigin = (typeof SurfaceOrigin)[keyof typeof SurfaceOrigin]

const SURFACE_ORIGINS = new Set<string>(Object.values(SurfaceOrigin))

/**
 * The surface a jsonl row declares, refusing a row that declares none.
 *
 * A row written before this field existed carries no `surface`, and a default would
 * record it as whichever value the reader happened to pick.
 * Refusing names the file so the row is rewritten by the tool that produced it.
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
 * Provenance + augmentation metadata that travels with every corpus row.
 *
 * `synth` is `undefined` for natural (un-augmented) rows.
 * Present only when a row was produced by the synthesis pipeline (see `synthesize.ts`).
 */
export interface SourceProvenance {
	/**
	 * Adapter id that emitted this row, e.g. `"wof-admin"`, `"ban"`, `"openaddresses"`.
	 */
	source: string

	/**
	 * Stable id within the adapter's source.
	 *
	 * For SQLite-backed adapters this is the row's primary key.
	 * For CSV/GeoJSON, a hash of the canonical components.
	 *
	 * Must be stable across reruns so that dedup and holdout manifests are reproducible.
	 */
	source_id: string

	/**
	 * Corpus version string.
	 *
	 * Stamped by the runner rather than the adapter.
	 * Locked together with the tokenizer version: `corpus-v0.1.0` ships with `tokenizer-v0.1.0`.
	 */
	corpus_version: string

	/**
	 * Short license label or spdx id for _this_ row.
	 *
	 * Defaults to the adapter's `defaultLicense`, but per-row sources (OpenAddresses) override.
	 */
	license: string
}

/**
 * Which recipe produced a row, and which row it was derived from.
 *
 * Naming the recipe says what code ran.
 * It makes no claim about whether the address is real, which {@link CanonicalRow.surface}
 * and {@link CanonicalRow.register} answer.
 */
export interface RecipeMarker {
	/**
	 * Recipe id describing what produced this row.
	 *
	 * Free-form but stable — e.g. `"german"`, `"intersection"`, `"affix"`,
	 * `"boundary-stress:tight"`, `"compose:case-perturb+typo"`.
	 */
	recipe: string

	/**
	 * `source_id` of the row this was derived from.
	 *
	 * Allows tracing a derived row back to the row it was built from.
	 */
	base_source_id: string
}

/**
 * One address row, before tokenization + BIO labeling.
 *
 * `raw` is what a parser would see in the wild — possibly multi-line, with arbitrary whitespace.
 * `components` is the ground-truth tagging: every `ComponentTag` present in the source data,
 * mapped to its surface form _as it appears in `raw`_.
 *
 * Alignment uses this to assign BIO labels.
 *
 * Country is ISO 3166-1 alpha-2 (`"US"`, `"FR"`).
 * Locale is BCP-47 (`"en-US"`, `"fr-FR"`) and is optional.
 *
 * Adapters that can't be sure leave it empty and let the runner default by country.
 */
export interface CanonicalRow extends SourceProvenance {
	/**
	 * Address string as it might appear in source data.
	 */
	raw: string

	/**
	 * Component-by-tag ground truth.
	 *
	 * Surface forms must occur in `raw` (within the alignment edit distance threshold)
	 * or the row will land in the quarantine pile.
	 */
	components: Partial<Record<ComponentTag, string>>

	/**
	 * ISO 3166-1 alpha-2 country code.
	 */
	country: string

	/**
	 * Optional BCP-47 locale.
	 *
	 * Defaulted by country if absent.
	 */
	locale?: string

	/**
	 * What this address is the address of.
	 *
	 * The runner stamps the adapter's `addressRole` on every row that omits it,
	 * so an adapter sets this per row only when one source carries more than one role.
	 * Taiwan's company register holds the registered address and the tax office's
	 * business address in separate columns of the same row.
	 *
	 * Absent means {@link DEFAULT_ADDRESS_ROLE}; read it with {@link addressRoleOf} rather than by hand.
	 */
	addressRole?: AddressRole

	/**
	 * The published register this row's underlying record came from.
	 *
	 * A stable id for the publication rather than for the adapter that read it, so two adapters
	 * over one register agree: `"hm-land-registry-ppd"`, `"us-census-tiger"`, `"openaddresses-nl"`.
	 *
	 * `null` states that the row names no published record, which is what a
	 * post-office box or an intersection row is.
	 * An adapter that reads a register and leaves this unset gets the adapter's
	 * {@link CorpusAdapter.register} stamped by the runner.
	 *
	 * This is what a rights record and a supply census read.
	 * `source` names the code that emitted the row and cannot answer whose terms govern it.
	 */
	register?: string | null

	/**
	 * How this row's `raw` string was produced.
	 *
	 * The runner stamps the adapter's {@link CorpusAdapter.surface} on every row that omits it.
	 * A recipe that renders one register through more than one path sets it per row.
	 */
	surface?: SurfaceOrigin

	/**
	 * Which recipe produced this row, present when a recipe rather than an adapter did.
	 */
	recipe?: RecipeMarker
}

/**
 * Output of `align.ts`.
 *
 * Carries everything `CanonicalRow` does, plus parallel `tokens` and `labels` arrays of
 * identical length (`labels[i]` is the BIO tag for `tokens[i]`) and — as of the v0.5.0
 * char-offset migration (#519) — parallel char-span arrays addressing `raw` directly.
 *
 * The span triple is the v0.5.0 source of truth; `tokens`/`labels` remain emitted during
 * the transition (and stay derivable afterwards: whitespace split + span lookup).
 * The reverse derivation — today's token labels — is the lossy direction (punctuation-mute).
 */
export interface LabeledRow extends CanonicalRow {
	/**
	 * SentencePiece subword tokens for `raw`.
	 */
	tokens: readonly string[]

	/**
	 * BIO labels, one per token.
	 *
	 * Same length as `tokens`.
	 */
	labels: readonly BIOLabel[]

	/**
	 * Char-offset label spans over `raw` (parallel arrays, per the #519 ruling):
	 * `span_starts[i]` is the inclusive start offset (UTF-16 code units) of span `i`,
	 * `span_ends[i]` its exclusive end, `span_tags[i]` its component tag.
	 *
	 * Invariants — enforced loudly by `alignRow`, documented for every other producer:
	 * sorted ascending by start, non-overlapping.
	 * `raw` must be NFC-normalized or the offsets are ambiguous (also enforced by `alignRow`).
	 *
	 * Optional during the v0.4.x → v0.5.0 transition only: alignment always emits the triple.
	 * Frozen historical corpora and not-yet-migrated synthesis paths may lack it.
	 * Required once v0.5.0 lands and the token path is deleted.
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
 * A row that alignment refused to label.
 *
 * Lands in `/data/corpus/quarantine/` for human review.
 *
 * The `reason` is human-readable.
 * Common values are `"component-not-found:<tag>"`, `"edit-distance-exceeded:<tag>"`, `"raw-empty"`.
 *
 * Re-running alignment after a fix should re-emit the quarantined rows.
 * The runner keys them by `source_id`.
 */
export interface QuarantinedRow {
	row: CanonicalRow
	reason: string
}

/**
 * Per-invocation knobs handed to an adapter by the runner.
 *
 * `inputPath` is interpreted by the adapter.
 * It might be a single file path, a directory of files, or even an https URL.
 *
 * Each adapter documents its own expected shape in its readme.
 *
 * `country` filters to a single ISO 3166-1 alpha-2 country _at the adapter level_.
 * Adapters that hold multi-country data (OSM PBF, OpenAddresses) must honor this.
 *
 * Single-country adapters (BAN) may ignore it but should reject mismatches.
 *
 * `limit` is a soft cap on rows emitted.
 * Useful for fixture-driven tests and smoke runs.
 *
 * `signal` allows the runner to cancel a long-running scan cleanly.
 */
export interface AdapterOptions {
	/**
	 * Path to the adapter's input data (file, directory, or URL — adapter-specific).
	 */
	inputPath: PathBuilderLike

	/**
	 * Optional output directory, available to adapters that maintain side state (rare).
	 */
	outputDir?: string

	/**
	 * ISO 3166-1 alpha-2 country filter.
	 */
	country?: string

	/**
	 * Soft row cap.
	 *
	 * Adapters should stop iterating once this is reached.
	 */
	limit?: number

	/**
	 * Fraction of emitted rows that carry an explicit `country` component and its surface form.
	 *
	 * A source whose rows name no country teaches the model that a country token is normally absent.
	 * Measured on 2026-07-18: a 456,230-row Overture CA and MX extract at source weight
	 * 6.0 moved golden `country` recall −1.6pp, and adding Brazil to make 666,000
	 * rows moved it −5.3pp, which failed the release check.
	 *
	 * The deficit scales with the country-less mass rather than with any property of those countries.
	 *
	 * `0` or absent emits no country component and consumes no random draw,
	 * so a source that already ships stays byte-identical.
	 */
	countryFraction?: number

	/**
	 * Seed for {@linkcode AdapterOptions.countryFraction}'s draw.
	 *
	 * Fixed by default so two runs over one input emit the same rows.
	 */
	seed?: number

	/**
	 * Cancellation hook.
	 *
	 * Adapters should respect this on every iteration boundary.
	 */
	signal?: AbortSignal
}

/**
 * The interface every data source implements.
 *
 * Adapters are async generators: they yield `CanonicalRow`s one at a time, the runner
 * consumes them (writing jsonl + maintaining checksums + driving alignment).
 * Streaming is mandatory — many sources are tens of millions of rows and cannot be buffered.
 *
 * `defaultLicense` is stamped onto every emitted row's `license` field unless the adapter
 * sets `license` explicitly (e.g. OpenAddresses, which carries per-source licenses).
 */
export interface CorpusAdapter {
	/**
	 * Stable, machine-friendly id used in paths and CLI args.
	 *
	 * E.g.
	 * `"wof-admin"`.
	 */
	readonly id: string

	/**
	 * Default spdx-ish license label for rows from this adapter.
	 *
	 * Per-row overrides allowed.
	 */
	readonly defaultLicense: string

	/**
	 * What the addresses from this source are addresses of.
	 *
	 * Required, and with no default, because the answer is a property of the source
	 * that only the adapter's author has read: a health-provider registry carries
	 * practice locations, a tax-exempt-organization file carries mailing addresses,
	 * and a national address register carries premises.
	 * A field that defaulted would record premise for all three.
	 *
	 * The runner stamps this onto every row the adapter leaves unset.
	 * An adapter over a source with more than one address column sets the row field per row
	 * and declares the dominant role here.
	 */
	readonly addressRole: AddressRole

	/**
	 * The published register this adapter reads.
	 *
	 * Required, and with no default, for the reason {@link CorpusAdapter.addressRole} is:
	 * only the adapter's author has read the publication.
	 * `null` states that the adapter emits rows naming no published record, which a fabricating recipe does.
	 *
	 * The runner stamps this onto every row the adapter leaves unset.
	 */
	readonly register: string | null

	/**
	 * How this adapter's rows reach their `raw` string.
	 *
	 * The runner stamps this onto every row the adapter leaves unset.
	 * An adapter whose rows take more than one path sets the row field per row
	 * and declares the dominant one here.
	 */
	readonly surface: SurfaceOrigin

	/**
	 * One-sentence description shown by `npx mailwoman corpus list`.
	 */
	readonly description: string

	/**
	 * Async iterable of canonical rows.
	 *
	 * Implementations must:
	 *
	 * - Honor `opts.country` (filter or reject mismatches).
	 * - Honor `opts.limit` (stop after N rows).
	 * - Respect `opts.signal` on every iteration.
	 * - Set `source` to `this.id` on every emitted row.
	 * - Set `license` to `this.defaultLicense` unless overriding per-row.
	 *
	 * Implementations must not:
	 *
	 * - Set `corpus_version` (the runner stamps it).
	 * - Mutate previously-yielded rows.
	 */
	rows(opts: AdapterOptions): AsyncIterable<CanonicalRow>
}
