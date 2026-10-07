/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Zod wire schemas for the native `/v1` surface. We design this interface ourselves. Request
 *   bodies are required and validator-enforced. Validation failures use `@mailwoman/api-kit`'s
 *   `APIErrorSchema` envelope.
 */

import { z } from "@hono/zod-openapi"
import type { POIIntentOutcome } from "@mailwoman/core"
import { AddressNodeSchema, AddressTreeSchema } from "@mailwoman/core/decoder"
import { InputModeSchema } from "@mailwoman/core/pipeline"
import type { DerivationProjection, Evidence } from "@mailwoman/evidence"

import { MAX_ADDRESS_LENGTH } from "#input-limits"

export { MAX_ADDRESS_LENGTH } from "#input-limits"

/**
 * `post /v1/geocode` request body.
 */
export const GeocodeRequestSchema = z
	.object({
		address: z.string().max(MAX_ADDRESS_LENGTH),
		input_mode: InputModeSchema.optional(),
	})
	.openapi("GeocodeRequest")

/**
 * One `GeocodeOutcome.hierarchy` entry — locality → country, most specific first; `name` is the
 * resolved gazetteer name and `value` the raw parsed span, mirroring `GeocodeResult["hierarchy"]`.
 */
const GeocodeHierarchyEntrySchema = z
	.object({
		tag: z.string(),
		value: z.string(),
		name: z.string(),
		lat: z.number().nullable(),
		lon: z.number().nullable(),
		placeID: z.string().nullable(),
		// Tri-state: true = the winner's ancestor chain vouches for this entry, false = resolved
		// independently outside the winner's lineage, null = unverifiable (null is not false).
		in_winner_lineage: z.boolean().nullable(),
	})
	.openapi("GeocodeHierarchyEntry")

/**
 * One `GeocodeOutcome.candidates` entry — a ranked alternative place,
 * the winning place first and then same-query runner-ups.
 * It mirrors `GeocodeResult["candidates"]` entries.
 */
const GeocodeCandidateSchema = z
	.object({
		name: z.string(),
		tag: z.string(),
		lat: z.number(),
		lon: z.number(),
		countryCode: z.string().nullable(),
		placeID: z.string().nullable(),
	})
	.openapi("GeocodeCandidate")

/**
 * The `ComponentTag` union at this engine-agnostic boundary, declared once so every schema
 * that speaks about a tag speaks about the same list rather than a hand-copied twin.
 */
const ComponentTagSchema = z.enum([
	"country",
	"region",
	"locality",
	"dependent_locality",
	"postcode",
	"subregion",
	"house_number",
	"street",
	"street_prefix",
	"street_prefix_particle",
	"street_suffix",
	"intersection_a",
	"intersection_b",
	"unit",
	"venue",
	"attention",
	"po_box",
	"cedex",
	"prefecture",
	"municipality",
	"district",
	"block",
	"sub_block",
	"building_number",
	"building_name",
	"locality_unit",
])

/**
 * Canonical parsed-component map stored in `GeocodeResult.components`,
 * spelled out at this engine-agnostic boundary.
 *
 * The compile-time drift test catches any mismatch with the real type.
 */
const GeocodeComponentsSchema = z.partialRecord(ComponentTagSchema, z.string())

/**
 * One `GeocodeOutcome.intent_markers` entry, mirroring `QueryIntentMarker`.
 *
 * `evidence` stays open because each `code` has its own measurement.
 * A client branches on `code`.
 */
const QueryIntentMarkerSchema = z
	.object({
		// Spelled out rather than `z.string()` so `mailwoman/test/api-schema-drift.test.ts`'s
		// schema-too-wide direction keeps biting: a new `QueryKind` absent from this list
		// leaves a documented interface no longer describing the real one.
		kind: z.enum([
			"postcode_only",
			"locality_only",
			"structured_address",
			"intersection",
			"po_box",
			"landmark",
			"poi_query",
			"vague",
			"bare_toponym",
			"route_pair",
			"near_me",
			"poi_category",
		]),
		code: z.enum([
			"declared_ambiguity",
			"declared_fork",
			"focus_point_required",
			"poi_category",
			"coverage_qualified_absence",
			"authority_designation",
			"declared_coarser_answer",
		]),
		mechanism: z.string(),
		message: z.string(),
		evidence: z.record(z.string(), z.unknown()).optional(),
	})
	.openapi("QueryIntentMarker")

/**
 * One authoritative-provider match on the wire, hoisted so the outcome schema
 * below stays inside the call-nesting bound.
 *
 * It is a field-for-field mirror of `mailwoman/authoritative.ts`'s `AuthoritativeAssertionMatch`.
 */
const AuthoritativeMatchSchema = z.object({
	provider_place_id: z.string(),
	object_ids: z.record(z.string(), z.string()).nullable(),
	canonical_fields: z.record(z.string(), z.string()).nullable(),
	lat: z.number().nullable(),
	lon: z.number().nullable(),
	precision: z.string().nullable(),
	match_status: z.enum(["exact", "approximate"]),
	provider_score: z.number().nullable(),
})

const EpistemicStatusSchema = z.enum(["designated", "observed", "derived", "inferred", "unresolved"])

const CoverageBasisSchema = z.enum(["designated", "surveyed", "source_present"])

/**
 * `@mailwoman/evidence`'s `Evidence` union, spelled for the wire.
 *
 * The `EvidencePin` below fails to compile the moment either side gains, loses or retypes a field.
 */
const EvidenceSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("observation"), source: z.string(), vintage: z.string().nullable(), value: z.unknown() }),
	z.object({
		kind: z.literal("exclusion"),
		source: z.string(),
		vintage: z.string(),
		scope: z.object({ layer: z.string(), h3Cell: z.number(), basis: CoverageBasisSchema, fold: z.string() }),
	}),
	z.object({
		kind: z.literal("relation"),
		source: z.string(),
		vintage: z.string(),
		relationship: z.string(),
		assertion: z.enum(["authoritative", "inferred"]),
		score: z.number().nullable(),
	}),
	z.object({ kind: z.literal("prior"), source: z.string(), label: z.string(), weight: z.number() }),
])

/**
 * The derivation behind a geocode answer, present only when the engine was asked to trace;
 * `@mailwoman/evidence`'s `DerivationProjection` on the wire.
 */
export const DerivationProjectionSchema = z.object({
	status: EpistemicStatusSchema,
	constraints: z.array(z.object({ label: z.string(), evidence: EvidenceSchema, contribution: z.string() })).readonly(),
	uncertaintyM: z.number().nullable(),
})

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const evidencePin: Mutual<z.infer<typeof EvidenceSchema>, Evidence> = true
const derivationPin: Mutual<z.infer<typeof DerivationProjectionSchema>, DerivationProjection> = true

void evidencePin
void derivationPin

const POICategorySubjectSchema = z.object({
	kind: z.literal("category"),
	categoryIDs: z.array(z.string()),
	matched: z.string(),
	countryBinding: z
		.object({ anchorCountry: z.string().nullable(), excludedCategoryIDs: z.array(z.string()) })
		.optional(),
})

const POIBrandSubjectSchema = z.object({
	kind: z.literal("brand"),
	name: z.string(),
	wikidata: z.string().optional(),
	matched: z.string(),
})

const POIAnchorSchema = z.object({
	text: z.string().optional(),
	tree: AddressTreeSchema.optional(),
	biasPoint: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
	radiusM: z.number().optional(),
})

// TODO: Unify with kind classifier
const POIIntentSchema = z.object({
	subject: z.discriminatedUnion("kind", [
		POICategorySubjectSchema,
		POIBrandSubjectSchema,
		z.object({ kind: z.literal("name"), text: z.string() }),
	]),
	relation: z.enum(["comma", "near", "in", "at", "around", "to"]).optional(),
	anchor: POIAnchorSchema.optional(),
	limit: z.number().optional(),
})

const POIResultSchema = z.object({
	name: z.string().nullable(),
	categoryID: z.string().nullable(),
	brandWikidata: z.string().nullable(),
	latitude: z.number(),
	longitude: z.number(),
	country: z.string(),
	confidence: z.number(),
	gersID: z.string().nullable(),
	ancestry: z
		.array(z.object({ placetype: z.string(), name: z.string(), wofID: z.number() }))
		.readonly()
		.optional(),
	distanceM: z.number().optional(),
})

/**
 * The response returned when the pipeline evaluates a point-of-interest query.
 */
export const POIIntentOutcomeSchema = z
	.discriminatedUnion("type", [
		z.object({ type: z.literal("intent"), intent: POIIntentSchema, results: z.array(POIResultSchema).optional() }),
		z.object({ type: z.literal("abstain"), reason: z.string() }),
	])
	.openapi("POIIntentOutcome")

const poiIntentOutcomePin: Mutual<z.infer<typeof POIIntentOutcomeSchema>, POIIntentOutcome> = true

void poiIntentOutcomePin

/**
 * `post /v1/geocode` response schema, passed through from the engine verbatim
 * and kept independent of the `mailwoman` package at the engine-agnostic boundary.
 */
export const GeocodeOutcomeLikeSchema = z.object({
	input: z.string(),
	components: GeocodeComponentsSchema,
	lat: z.number().nullable(),
	lon: z.number().nullable(),
	resolution_tier: z.enum(["address_point", "interpolated", "street", "admin", "venue", "plus_code"]),
	// What the evidence permits a consumer to claim about the coordinate, orthogonal to how it was produced.
	// See `@mailwoman/evidence`'s `EpistemicStatus`.
	epistemic_status: z.enum(["designated", "observed", "derived", "inferred", "unresolved"]),
	// The derivation behind the answer, null unless the engine was asked to trace.
	derivation: DerivationProjectionSchema.nullable(),
	// The fork→entity probe's answer, null except on the `venue` tier.
	entity: z
		.object({
			name: z.string(),
			categoryID: z.string().nullable(),
			confidence: z.number(),
			country: z.string(),
		})
		.nullable(),
	uncertainty_m: z.number().nullable(),
	locality: z.string().nullable(),
	region: z.string().nullable(),
	postcode: z.string().nullable(),
	house_number: z.string().nullable(),
	street: z.string().nullable(),
	venue: z.string().nullable(),
	// The parsed dependent-locality span (parse view; `hierarchy` is the resolved view).
	dependent_locality: z.string().nullable(),
	// The parsed unit / sub-venue span (parse view).
	unit: z.string().nullable(),
	countryCode: z.string().nullable(),
	hierarchy: z.array(GeocodeHierarchyEntrySchema),
	candidates: z.array(GeocodeCandidateSchema),
	// The register row's own scope tags when the address_point tier answered and its
	// extract includes them (normalized locality key + postcode of the rooftop).
	rooftop: z
		.object({
			localityNorm: z.string().nullable(),
			postcode: z.string().nullable(),
		})
		.nullable(),
	// The country the postcode-country coherence pass scoped the walk to, non-null only
	// when it overrode the request's country prior.
	postcode_country_scope: z.string().nullable(),
	// The capital promotion's firing receipt: the promoted candidate's country.
	// It is null unless the promotion changed some node's leading candidate.
	capital_promotion: z.string().nullable(),
	// The variant-alias exemption's firing receipt.
	// It is true when the exemption spared the winner the cross-country alias penalty, else null.
	variant_alias_exemption: z.literal(true).nullable(),
	// Query-intent advisories, always present.
	// Empty means the vocabulary found no marker.
	// Clients can ignore the array.
	intent_markers: z.array(QueryIntentMarkerSchema),
	// Flag-only admin-coherence verdicts: no code ranks or filters on them.
	// Present whenever a winner resolved (both members always populated; `unstated` is the
	// explicit no-qualifier claim), null when no winner resolved to check against.
	admin_coherence: z
		.object({
			region: z.enum(["confirmed", "contradicted", "unstated", "unverifiable"]),
			country: z.enum(["confirmed", "contradicted", "unstated", "unverifiable"]),
		})
		.nullable(),
	// A configured authoritative provider's answer, hand-modeled to match `mailwoman/authoritative.ts`'s
	// wire shape (the engine-agnosticism boundary forbids importing it).
	// Null when no provider is configured; `refused` is the provider declining
	// (distinct from a parse failure or a gazetteer miss) and `transport_error` is the
	// provider being unreachable, reported rather than silently dropped.
	authoritative: z
		.object({
			provider: z.string(),
			status: z.enum(["matched", "ambiguous", "refused", "transport_error"]),
			matches: z.array(AuthoritativeMatchSchema).nullable(),
			attribution: z.string().nullable(),
			license: z.string().nullable(),
			retrieved_at: z.string().nullable(),
			dataset_version: z.string().nullable(),
			error: z.string().nullable(),
		})
		.nullable(),
	// Spans the flat `components` map could not represent: it holds one value per tag, so a second
	// `locality` span ceases to exist there and a null field cannot be told from a deleted one.
	// Null rather than empty when no component was dropped.
	dropped_components: z
		.array(
			z.object({
				tag: ComponentTagSchema,
				value: z.string(),
				kept: z.string(),
			})
		)
		.nullable(),
	// The parse kept this component, but the answer did not follow it.
	// Its value in `components` looks honored.
	// No other field indicates that it points at a place far from the rest.
	// Null when the answer followed everything it parsed.
	unfollowed_components: z
		.array(
			z.object({
				tag: ComponentTagSchema,
				value: z.string(),
				reason: z.literal("postcode_move_refused"),
				distance_km: z.number(),
			})
		)
		.nullable(),
})

export type GeocodeOutcomeLike = z.infer<typeof GeocodeOutcomeLikeSchema>

/**
 * Loose OpenAPI variant of {@link GeocodeOutcomeLikeSchema}.
 */
export const GeocodeOutcomeSchema = GeocodeOutcomeLikeSchema.loose().openapi("GeocodeOutcome")

export type GeocodeOutcome = z.infer<typeof GeocodeOutcomeSchema>

/**
 * `post /v1/batch` request body.
 */
export const BatchRequestSchema = z
	.object({
		// The per-request `batchMax` cap bounds how many rows arrive.
		// This bounds how large each may be, or one request is 500 unbounded bodies.
		addresses: z.array(z.string().max(MAX_ADDRESS_LENGTH)),
		/**
		 * Register override for every row, defaulting to `"formatted"`:
		 * batch rows are the record register by nature.
		 */
		input_mode: InputModeSchema.optional(),
	})
	.openapi("BatchRequest")

/**
 * The failure slot for one batch row.
 * A row that throws does not fail its neighbors.
 */
const BatchRowErrorSchema = z.object({ input: z.string(), error: z.string() })

const BatchRowSchema = z.union([GeocodeOutcomeSchema, BatchRowErrorSchema])

/**
 * `post /v1/batch` response — one `GeocodeOutcome`, or an `{ input, error }` slot, per row.
 */
export const BatchResponseSchema = z
	.object({
		results: z.array(BatchRowSchema),
	})
	.openapi("BatchResponse")

/**
 * `post /v1/resolve` request body: an already-decoded `AddressTree` (the parser's output)
 * to resolve against the gazetteer.
 */
export const ResolveRequestSchema = z
	.object({
		tree: z.looseObject({ raw: z.string(), roots: z.array(AddressNodeSchema) }),
		opts: z.looseObject({}).optional(),
	})
	.openapi("ResolveRequest")

/**
 * `post /v1/resolve` response — the same tree, decorated in place with gazetteer coords + attribution.
 */
export const ResolveResponseSchema = z
	.object({
		tree: z.looseObject({ raw: z.string(), roots: z.array(AddressNodeSchema) }),
	})
	.openapi("ResolveResponse")

/**
 * One component's value.
 *
 * Repeatable tags (a street with two names, say) arrive as an array.
 */
const ComponentValueSchema = z.union([z.string(), z.array(z.string())])

/**
 * `post /v1/format` request body.
 *
 * Each `components` key accepts `string | string[]`.
 * A handler joins array values because `formatAddress` and `canonicalKey` take single strings.
 */
export const FormatRequestSchema = z
	.object({
		components: z.record(z.string(), ComponentValueSchema),
		country: z.string(),
		options: z.looseObject({}).optional(),
	})
	.openapi("FormatRequest")

/**
 * `post /v1/format` response — the rendered string plus the deterministic canonical match key.
 */
export const FormatResponseSchema = z
	.object({
		formatted: z.string(),
		canonicalKey: z.string(),
	})
	.openapi("FormatResponse")
