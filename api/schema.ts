/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Zod wire schemas for the native `/v1` surface. Unlike the drop-ins (photon, nominatim,
 *   libpostal), nothing here is a vendor contract — this surface is ours to design, so request
 *   bodies are REQUIRED and validator-enforced (no legacy tolerance to preserve). A `defaultHook`
 *   on the app maps validation failures through the shared `APIErrorSchema` envelope
 *   (`apiError(c, 400, "invalid request body", <zod summary>)`) — the pattern boundary every
 *   surface holds to: where no legacy contract exists, the validator MAY speak, but only in
 *   our envelope.
 *
 *   `APIErrorSchema` itself is owned by `@mailwoman/api-kit` (plumbing shared by every native
 *   surface) — it's re-exported here so route modules can import every schema they need, request
 *   and error alike, from this one file.
 */

import { z } from "@hono/zod-openapi"

export { APIErrorSchema } from "@mailwoman/api-kit"

/**
 * `POST /v1/parse` request body.
 */
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
		tree: z.looseObject({ roots: z.array(z.unknown()) }),
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
 * Canonical parsed-component map carried by `GeocodeResult.components`. Spelled out at this engine-agnostic API
 * boundary for the same reason the result schema is hand-modeled; the compile-time drift pin in
 * `mailwoman/test/api-schema-drift.test.ts` catches any mismatch with the real `ComponentTag`-keyed result type.
 */
const GeocodeComponentsSchema = z.partialRecord(
	z.enum([
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
	]),
	z.string()
)

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
		code: z.enum(["declared_ambiguity", "declared_fork", "focus_point_required", "poi_category"]),
		mechanism: z.string(),
		message: z.string(),
		evidence: z.record(z.string(), z.unknown()).optional(),
	})
	.openapi("QueryIntentMarker")

/**
 * `POST /v1/geocode` response — a hand-modeled mirror of `GeocodeResult`'s wire shape (`mailwoman/geocode-core.ts`),
 * `.loose()` so a field the engine adds that this schema doesn't yet know about still rides through undocumented rather
 * than being stripped or rejected. DOC-ACCURACY ONLY: the route passes `engine.geocode()`'s outcome through verbatim
 * (`GeocodeOutcome = Record<string, unknown>`, `api/engine.ts`) — nothing here validates a real response, so a
 * schema/engine mismatch can never reject or mutate a result at runtime. Deliberately carries NO import from
 * `mailwoman` (the engine-agnosticism boundary — `mailwoman` is the one workspace allowed to depend on
 * `@mailwoman/api`, never the reverse). `mailwoman/test/api-schema-drift.test.ts` is the compile-time tripwire that
 * catches this shape drifting from the real `GeocodeResult` interface.
 */
export const GeocodeOutcomeSchema = z
	.object({
		input: z.string(),
		components: GeocodeComponentsSchema,
		lat: z.number().nullable(),
		lon: z.number().nullable(),
		resolution_tier: z.enum(["address_point", "interpolated", "street", "admin"]),
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
		// #42: the country the postcode-country coherence pass scoped the walk to, or null. Non-null ONLY when it
		// OVERRODE the request's country prior — so a caller who asked for US and got an FR answer can see which
		// evidence bought the change instead of reading it as a bug.
		postcode_country_scope: z.string().nullable(),
		// ROAD_TO_V9 §4: query-intent advisories. Always present; empty means the vocabulary looked and had nothing to
		// say. Advisory ONLY — no marker changed which answer won, and a client is free to ignore the array entirely.
		intent_markers: z.array(QueryIntentMarkerSchema),
	})
	.loose()
	.openapi("GeocodeOutcome")

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
		tree: z.looseObject({ roots: z.array(z.unknown()) }),
		opts: z.looseObject({}).optional(),
	})
	.openapi("ResolveRequest")

/**
 * `POST /v1/resolve` response — the same tree, decorated in place with gazetteer coords + attribution.
 */
export const ResolveResponseSchema = z
	.object({
		tree: z.looseObject({ roots: z.array(z.unknown()) }),
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
 * (`api/routes.ts`'s `healthRoute` handler: `{ status: "ok", uptime_s, ...engine.health?.() }`), so those two are cheap
 * + accurate to pin. Everything else is `HealthData` (`api/engine.ts`) — an engine-defined block (model card, data-root
 * inventory for `mailwoman serve`; something else entirely for another engine) — stays loose.
 */
export const HealthResponseSchema = z
	.object({
		status: z.literal("ok"),
		uptime_s: z.number(),
	})
	.loose()
	.openapi("HealthResponse")
