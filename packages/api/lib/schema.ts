/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Zod wire schemas for the native `/v1` surface. Unlike the drop-ins (photon, nominatim,
 *   libpostal), nothing here is a vendor contract — this surface is ours to design, so request
 *   bodies are REQUIRED and validator-enforced (no legacy tolerance to preserve). A `defaultHook`
 *   on the app maps validation failures through the shared `APIErrorSchema` envelope
 *   (`errorResponse(c, 400, "invalid request body", <zod summary>)`) — the pattern boundary every
 *   surface holds to: where no legacy contract exists, the validator MAY speak, but only in
 *   our envelope.
 *
 *   `APIErrorSchema` itself is owned by `@mailwoman/api-kit` (plumbing shared by every native
 *   surface) — it's re-exported here so route modules can import every schema they need, request
 *   and error alike, from this one file.
 */

import { z } from "@hono/zod-openapi"
import type { AddressNode } from "@mailwoman/core/decoder"
import type { DerivationProjection, Evidence } from "@mailwoman/evidence"

export { APIErrorSchema } from "@mailwoman/api-kit"

/**
 * `POST /v1/parse` request body.
 */
/**
 * One node of the decoded address tree. The decoder's `AddressNode` is a recursive union the OpenAPI generator cannot
 * derive a schema for on its own, so it is registered as an open object; the shape is documented by the type.
 */
export const AddressNodeSchema = z.custom<AddressNode>().openapi("AddressNode", {
	type: "object",
	additionalProperties: true,
	description:
		"A decoded address-tree node: a tag, its span, and its children. See `AddressNode` in `@mailwoman/core/decoder`.",
})

/**
 * The input register (Decision A / GTM B10): `fragmented` = the map-search register (evidence-bundle channels feed);
 * `formatted` = the validation/record register (channels off). Unset → the engine derives it from the input's shape.
 * `/v1/batch` defaults to `formatted` (batch rows are the record register by nature).
 */
export const InputModeSchema = z.enum(["fragmented", "formatted"]).openapi("InputMode")

/**
 * Longest accepted `address`, in characters.
 *
 * Sized against what the model can actually read, not against a guess at abuse. The classifier's window is 128
 * SentencePiece pieces — roughly 330 characters of address text — and everything past it is truncated before inference,
 * so input beyond this bound cannot influence a result. The margin over that window leaves room for scripts that
 * tokenize denser than Latin, and for the department-and-division prefixes web forms concatenate.
 *
 * The bound exists because preprocessing is linear but not free: a 1 MB body costs ~1.7 s across normalize, query-shape
 * and the phrase grouper, and Node runs them on the one thread every other request is waiting on. A cap here is cheaper
 * than fairness plumbing, and rejecting is more honest than accepting a body whose tail the parser will silently
 * discard.
 */
export const MAX_ADDRESS_LENGTH = 1024

/**
 * `POST /v1/parse` request body.
 */
export const ParseRequestSchema = z
	.object({
		address: z.string().max(MAX_ADDRESS_LENGTH),
		debug: z.boolean().optional(),
		input_mode: InputModeSchema.optional(),
	})
	.openapi("ParseRequest")

/**
 * One `ParseOutcome.components` entry — mirrors {@linkcode ParseComponent} (`engine.ts`).
 */
export const ParseComponentSchema = z.object({ tag: z.string(), value: z.string() }).openapi("ParseComponent")

/**
 * `POST /v1/parse` response — mirrors {@linkcode ParseOutcome} (`engine.ts`): the ordered components plus the full
 * decoded tree. `tree` is the same loose-tree idiom {@link ResolveResponseSchema} uses (`api/schema.ts:134-146`) — the
 * decoder's `AddressTree` is the engine's contract, not this wire schema's.
 */
export const ParseOutcomeSchema = z
	.object({
		input: z.string(),
		components: z.array(ParseComponentSchema),
		tree: z.looseObject({ raw: z.string(), roots: z.array(AddressNodeSchema) }),
		debug: z.string().optional(),
	})
	.openapi("ParseOutcome")

/**
 * `POST /v1/geocode` request body.
 */
export const GeocodeRequestSchema = z
	.object({
		address: z.string().max(MAX_ADDRESS_LENGTH),
		input_mode: InputModeSchema.optional(),
	})
	.openapi("GeocodeRequest")

/**
 * One `GeocodeOutcome.hierarchy` entry — locality → country, most specific first. `name` is the resolved gazetteer name
 * (proper-cased canonical); `value` is the raw parsed span. Mirrors `GeocodeResult["hierarchy"]` entries
 * (`mailwoman/geocode-core.ts`), hand-modeled — see {@link GeocodeOutcomeSchema} for the no-import rationale.
 */
const GeocodeHierarchyEntrySchema = z
	.object({
		tag: z.string(),
		value: z.string(),
		name: z.string(),
		lat: z.number().optional(),
		lon: z.number().optional(),
		placeID: z.string().optional(),
		// #1731 tri-state lineage provenance: true = the winner's ancestor chain vouches for this entry, false =
		// resolved independently OUTSIDE the winner's lineage, absent = unverifiable. Absence is not false.
		in_winner_lineage: z.boolean().optional(),
	})
	.openapi("GeocodeHierarchyEntry")

/**
 * One `GeocodeOutcome.candidates` entry — a ranked alternative place for the query's primary result (the winning place
 * first, then same-query runner-ups). Mirrors `GeocodeResult["candidates"]` entries.
 */
const GeocodeCandidateSchema = z
	.object({
		name: z.string(),
		tag: z.string(),
		lat: z.number(),
		lon: z.number(),
		countryCode: z.string().nullable(),
		placeID: z.string().optional(),
	})
	.openapi("GeocodeCandidate")

/**
 * The `ComponentTag` union at this engine-agnostic boundary, named once so every schema that speaks about a tag speaks
 * about the SAME list. Two hand-copied enums would agree on the day they were written and diverge on the day a tag is
 * added — the shape of defect `feedback-parity-needs-shared-function-not-shared-constants` describes.
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
])

/**
 * Canonical parsed-component map carried by `GeocodeResult.components`. Spelled out at this engine-agnostic API
 * boundary for the same reason the result schema is hand-modeled; the compile-time drift pin in
 * `mailwoman/test/api-schema-drift.test.ts` catches any mismatch with the real `ComponentTag`-keyed result type.
 */
const GeocodeComponentsSchema = z.partialRecord(ComponentTagSchema, z.string())

/**
 * One `GeocodeOutcome.intent_markers` entry — an advisory the ROAD_TO_V9 §4 intent vocabulary raised about the QUERY.
 * Mirrors `QueryIntentMarker` (`core/pipeline/types.ts`).
 *
 * `evidence` is deliberately open (`z.record`): each `code` carries its own measurement — a dominance margin, a pair of
 * interpretations, a taxonomy id — and flattening those into one closed shape would either lose the numbers or invent
 * fields that do not apply. `code` is the discriminator a client branches on.
 */
const QueryIntentMarkerSchema = z
	.object({
		// Spelled out rather than `z.string()` so `mailwoman/test/api-schema-drift.test.ts`'s schema-too-wide direction
		// keeps biting: a new `QueryKind` that never reaches this list is a documented contract that has quietly stopped
		// describing the real one.
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
		]),
		mechanism: z.string(),
		message: z.string(),
		evidence: z.record(z.string(), z.unknown()).optional(),
	})
	.openapi("QueryIntentMarker")

/**
 * One authoritative-provider match on the wire (#1901) — hoisted so the outcome schema below stays inside the
 * call-nesting bound. Field-for-field mirror of `mailwoman/authoritative.ts`'s `AuthoritativeAssertionMatch`.
 */
const AuthoritativeMatchSchema = z.object({
	provider_place_id: z.string(),
	object_ids: z.record(z.string(), z.string()).optional(),
	canonical_fields: z.record(z.string(), z.string()).optional(),
	lat: z.number().optional(),
	lon: z.number().optional(),
	precision: z.string().optional(),
	match_status: z.enum(["exact", "approximate"]),
	provider_score: z.number().optional(),
})

const EpistemicStatusSchema = z.enum(["designated", "observed", "derived", "inferred", "unresolved"])

const CoverageBasisSchema = z.enum(["designated", "surveyed", "source_present"])

/**
 * `@mailwoman/evidence`'s `Evidence` union, spelled for the wire. The `EvidencePin` below fails to compile the moment
 * either side gains, loses or retypes a field.
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
		score: z.number().optional(),
	}),
	z.object({ kind: z.literal("prior"), source: z.string(), label: z.string(), weight: z.number() }),
])

/**
 * The derivation behind a geocode answer, present only when the engine was asked to trace — `@mailwoman/evidence`'s
 * `DerivationProjection` on the wire.
 */
export const DerivationProjectionSchema = z.object({
	status: EpistemicStatusSchema,
	constraints: z.array(z.object({ label: z.string(), evidence: EvidenceSchema, contribution: z.string() })).readonly(),
	uncertaintyM: z.number().nullable(),
})

// Both directions: the schema's inferred type is exactly the evidence package's, or this does not compile.
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const evidencePin: Mutual<z.infer<typeof EvidenceSchema>, Evidence> = true
const derivationPin: Mutual<z.infer<typeof DerivationProjectionSchema>, DerivationProjection> = true

void evidencePin
void derivationPin

/**
 * `POST /v1/geocode` response — a hand-modeled mirror of `GeocodeResult`'s wire shape (`mailwoman/geocode-core.ts`),
 * `.loose()` so a field the engine adds that this schema doesn't yet know about still rides through undocumented rather
 * than being stripped or rejected. DOC-ACCURACY ONLY: the route passes `engine.geocode()`'s outcome through verbatim
 * (`GeocodeOutcome = Record<string, unknown>`, `api/engine.ts`) — nothing here validates a real response, so a
 * schema/engine mismatch can never reject or mutate a result at runtime. Deliberately carries NO import from
 * `mailwoman` (the engine-agnosticism boundary — `mailwoman` is the one workspace allowed to depend on
 * `@mailwoman/api`, never the reverse). `mailwoman/test/api-schema-drift.test.ts` is the compile-time regression check
 * that catches this shape drifting from the real `GeocodeResult` interface.
 */
export const GeocodeOutcomeLikeSchema = z.object({
	input: z.string(),
	components: GeocodeComponentsSchema,
	lat: z.number().nullable(),
	lon: z.number().nullable(),
	resolution_tier: z.enum(["address_point", "interpolated", "street", "admin", "venue", "plus_code"]),
	// What the evidence permits a consumer to claim about the coordinate, orthogonal to how it was produced; see
	// `@mailwoman/evidence`'s `EpistemicStatus`.
	epistemic_status: z.enum(["designated", "observed", "derived", "inferred", "unresolved"]),
	// The derivation behind the answer, present only when the engine was asked to trace. `DerivationProjectionSchema` is
	// pinned to `@mailwoman/evidence`'s types below, so the wire contract and the evidence union cannot drift apart.
	derivation: DerivationProjectionSchema.optional(),
	// The fork→entity probe's answer (#1585) — present only on the `venue` tier; see geocode-core's
	// GeocodeResult.entity.
	entity: z
		.object({
			name: z.string(),
			categoryID: z.string().nullable(),
			confidence: z.number(),
			country: z.string(),
		})
		.optional(),
	uncertainty_m: z.number().nullable(),
	locality: z.string().nullable(),
	region: z.string().nullable(),
	postcode: z.string().nullable(),
	house_number: z.string().nullable(),
	street: z.string().nullable(),
	// The parsed venue span (#1041 posture; surfaced 2026-08-01 for the hierarchy-evidence campaign R1).
	venue: z.string().nullable(),
	// The parsed dependent-locality span (parse view; `hierarchy` is the resolved view).
	dependent_locality: z.string().nullable(),
	// The parsed unit / sub-venue span (parse view) — "Terminal 5", "Suite 300".
	unit: z.string().nullable(),
	countryCode: z.string().nullable(),
	hierarchy: z.array(GeocodeHierarchyEntrySchema),
	candidates: z.array(GeocodeCandidateSchema),
	// The register row's OWN scope tags when the address_point tier answered and its extract carries
	// them (normalized locality key + postcode of the ROOFTOP) — see geocode-core's GeocodeResult.rooftop.
	rooftop: z
		.object({
			localityNorm: z.string().optional(),
			postcode: z.string().optional(),
		})
		.optional(),
	// #42: the country the postcode-country coherence pass scoped the walk to, or null. Non-null ONLY when it
	// OVERRODE the request's country prior — so a caller who asked for US and got an FR answer can see which
	// evidence bought the change instead of reading it as a bug.
	postcode_country_scope: z.string().nullable(),
	// #1880: the capital promotion's firing receipt — the promoted candidate's country, present only when the
	// promotion changed some node's leading candidate. Advisory, same posture as postcode_country_scope.
	capital_promotion: z.string().optional(),
	// #1893: the variant-alias exemption's firing receipt — present (true) only when the winning candidate reached
	// the top because the exemption spared it the cross-country alias penalty. Advisory, same posture again.
	variant_alias_exemption: z.literal(true).optional(),
	// ROAD_TO_V9 §4: query-intent advisories. Always present; empty means the vocabulary looked and had nothing to
	// say. Advisory ONLY — no marker changed which answer won, and a client is free to ignore the array entirely.
	intent_markers: z.array(QueryIntentMarkerSchema),
	// #1717 stage 1: flag-only admin-coherence verdicts — did the winning candidate's resolved ancestry confirm,
	// contradict, or fail to speak to the PARSED region/country qualifiers? Nothing ranks or filters on these; present
	// whenever a winner resolved (both members always populated — `unstated` is the explicit no-qualifier claim),
	// absent when nothing resolved to check against. See mailwoman's `admin-coherence.ts` for the verdict contract.
	admin_coherence: z
		.object({
			region: z.enum(["confirmed", "contradicted", "unstated", "unverifiable"]),
			country: z.enum(["confirmed", "contradicted", "unstated", "unverifiable"]),
		})
		.optional(),
	// #1901: a configured authoritative provider's answer, carried BESIDE the open result — every value inside is
	// the PROVIDER'S assertion, hand-modeled here to match `mailwoman/authoritative.ts`'s wire shape (the
	// engine-agnosticism boundary forbids importing it). Absent when no provider is configured; `refused` is the
	// provider declining (distinct from a parse failure or a gazetteer miss); `transport_error` is the provider
	// being unreachable, reported rather than silently dropped. An `ambiguous` status carries EVERY candidate.
	authoritative: z
		.object({
			provider: z.string(),
			status: z.enum(["matched", "ambiguous", "refused", "transport_error"]),
			matches: z.array(AuthoritativeMatchSchema).optional(),
			attribution: z.string().optional(),
			license: z.string().optional(),
			retrieved_at: z.string().optional(),
			dataset_version: z.string().optional(),
			error: z.string().optional(),
		})
		.optional(),
	// #1755: spans the flat `components` map could not represent. `components` holds one value per tag, so a second
	// `locality` span ceases to exist there — and without this line `region: null` means both "the input named no
	// region" and "it named one and we deleted it". Absent when nothing was dropped; never an empty array on the wire,
	// because the common case is nothing dropped and a client should not have to read a field to learn that.
	dropped_components: z
		.array(
			z.object({
				tag: ComponentTagSchema,
				value: z.string(),
				// The value that held the slot, so a reader sees which of the two survived without re-deriving it.
				kept: z.string(),
			})
		)
		.optional(),
})

export type GeocodeOutcomeLike = z.infer<typeof GeocodeOutcomeLikeSchema>

/**
 * `POST /v1/geocode` response — a hand-modeled mirror of `GeocodeResult`'s wire shape (`mailwoman/geocode-core.ts`),
 * `.loose()` so a field the engine adds that this schema doesn't yet know about still rides through undocumented rather
 * than being stripped or rejected. DOC-ACCURACY ONLY: the route passes `engine.geocode()`'s outcome through verbatim
 * (`GeocodeOutcome = Record<string, unknown>`, `api/engine.ts`) — nothing here validates a real response, so a
 * schema/engine mismatch can never reject or mutate a result at runtime. Deliberately carries NO import from
 * `mailwoman` (the engine-agnosticism boundary — `mailwoman` is the one workspace allowed to depend on
 * `@mailwoman/api`, never the reverse). `mailwoman/test/api-schema-drift.test.ts` is the compile-time regression check
 * that catches this shape drifting from the real `GeocodeResult` interface.
 */
export const GeocodeOutcomeSchema = GeocodeOutcomeLikeSchema.loose().openapi("GeocodeOutcome")

export type GeocodeOutcome = z.infer<typeof GeocodeOutcomeSchema>

/**
 * `POST /v1/batch` request body.
 */
export const BatchRequestSchema = z
	.object({
		// Per-ROW, not just per-request: the row cap (`batchMax`, default 500) bounds how many addresses arrive,
		// and this bounds how large each may be. Without both, one request is 500 unbounded bodies.
		addresses: z.array(z.string().max(MAX_ADDRESS_LENGTH)),
		/**
		 * Register override for every row. DEFAULT `"formatted"` — batch rows are the record register by nature.
		 */
		input_mode: InputModeSchema.optional(),
	})
	.openapi("BatchRequest")

/**
 * The failure slot for one batch row. A row that throws does not fail its neighbours.
 */
const BatchRowErrorSchema = z.object({ input: z.string(), error: z.string() })

/**
 * One batch row: the geocode outcome, or the failure slot that stands in for it.
 */
const BatchRowSchema = z.union([GeocodeOutcomeSchema, BatchRowErrorSchema])

/**
 * `POST /v1/batch` response — one `GeocodeOutcome`, or an `{ input, error }` slot, per row (per-row isolation).
 */
export const BatchResponseSchema = z
	.object({
		results: z.array(BatchRowSchema),
	})
	.openapi("BatchResponse")

/**
 * `POST /v1/resolve` request body — an already-decoded `AddressTree` (the parser's output) to resolve against the
 * gazetteer.
 */
export const ResolveRequestSchema = z
	.object({
		tree: z.looseObject({ raw: z.string(), roots: z.array(AddressNodeSchema) }),
		opts: z.looseObject({}).optional(),
	})
	.openapi("ResolveRequest")

/**
 * `POST /v1/resolve` response — the same tree, decorated in place with gazetteer coords + attribution.
 */
export const ResolveResponseSchema = z
	.object({
		tree: z.looseObject({ raw: z.string(), roots: z.array(AddressNodeSchema) }),
	})
	.openapi("ResolveResponse")

/**
 * One component's value. Repeatable tags (a street with two names, say) arrive as an array; the caller joins them
 * before handing the dict to `formatAddress`, which takes single strings only.
 */
const ComponentValueSchema = z.union([z.string(), z.array(z.string())])

/**
 * `POST /v1/format` request body. `components` accepts `string | string[]` per key on the wire — a handler-side
 * concern, not this schema's: `@mailwoman/formatter`'s `ComponentDict` (`format.ts`) is `Partial<Record<ComponentTag,
 * string>>`, single-string only, so a route handler must join array values before calling
 * `formatAddress`/`canonicalKey`.
 */
export const FormatRequestSchema = z
	.object({
		components: z.record(z.string(), ComponentValueSchema),
		country: z.string(),
		options: z.looseObject({}).optional(),
	})
	.openapi("FormatRequest")

/**
 * `POST /v1/format` response — the rendered string plus the deterministic canonical match key.
 */
export const FormatResponseSchema = z
	.object({
		formatted: z.string(),
		canonicalKey: z.string(),
	})
	.openapi("FormatResponse")

/**
 * `GET /health` response — `status`/`uptime_s` are stamped by the ROUTE itself, unconditionally, regardless of engine
 * (`api/routes.ts`'s `healthRoute` handler: `{ status: "ok", uptime_s, ...engine.health?.() }`), so those two are
 * cheap
 *
 * - Accurate to pin. Everything else is `HealthData` (`api/engine.ts`) — an engine-defined block (model card, data-root
 *   inventory for `mailwoman serve`; something else entirely for another engine) — stays loose.
 */
export const HealthResponseSchema = z
	.object({
		status: z.literal("ok"),
		uptime_s: z.number(),
	})
	.loose()
	.openapi("HealthResponse")
