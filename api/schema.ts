/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Zod wire schemas for the native `/v1` surface. Unlike the drop-ins (photon, nominatim,
 *   libpostal), nothing here is a vendor contract — this surface is ours to design, so request
 *   bodies are REQUIRED and validator-enforced (no legacy tolerance to preserve). A `defaultHook`
 *   on the app (wired in Task 3) maps validation failures through the shared `APIErrorSchema`
 *   envelope (`apiError(c, 400, "invalid request body", <zod summary>)`) — the documented pattern
 *   boundary from phase 2: where no legacy contract exists, the validator MAY speak, but only in
 *   our envelope.
 *
 *   `APIErrorSchema` itself is owned by `@mailwoman/api-kit` (plumbing shared by every native
 *   surface) — it's re-exported here so route modules can import every schema they need, request
 *   and error alike, from this one file.
 */

import { z } from "@hono/zod-openapi"

export { APIErrorSchema } from "@mailwoman/api-kit"

/** `POST /v1/parse` request body. */
export const ParseRequestSchema = z
	.object({
		address: z.string(),
		debug: z.boolean().optional(),
	})
	.openapi("ParseRequest")

/**
 * `POST /v1/parse` response — a loose mirror of {@linkcode ParseOutcome} (`engine.ts`). `solutions` entries aren't fully
 * modeled: `SerializedSolution` (`@mailwoman/core/solver`) carries the solver's internal match/classification detail,
 * which is the engine's contract, not this wire schema's — `score`/`penalty` are the two fields every solution always
 * carries (always-present numbers, cheap to pin accurately); `classifications`/`matches` stay loose passthrough.
 */
export const ParseOutcomeSchema = z
	.object({
		input: z.object({
			body: z.string(),
			start: z.number(),
			end: z.number(),
		}),
		solutions: z.array(z.looseObject({ score: z.number(), penalty: z.number() })),
		debug: z.string().optional(),
	})
	.openapi("ParseOutcome")

/** `POST /v1/geocode` request body. */
export const GeocodeRequestSchema = z
	.object({
		address: z.string(),
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
		lat: z.number().nullable(),
		lon: z.number().nullable(),
		resolution_tier: z.enum(["address_point", "interpolated", "street", "admin"]),
		uncertainty_m: z.number().nullable(),
		locality: z.string().nullable(),
		region: z.string().nullable(),
		postcode: z.string().nullable(),
		house_number: z.string().nullable(),
		street: z.string().nullable(),
		countryCode: z.string().nullable(),
		hierarchy: z.array(GeocodeHierarchyEntrySchema),
		candidates: z.array(GeocodeCandidateSchema),
	})
	.loose()
	.openapi("GeocodeOutcome")

/** `POST /v1/batch` request body. */
export const BatchRequestSchema = z
	.object({
		addresses: z.array(z.string()),
	})
	.openapi("BatchRequest")

/** `POST /v1/batch` response — one `GeocodeOutcome`, or an `{ input, error }` slot, per row (per-row isolation). */
export const BatchResponseSchema = z
	.object({
		results: z.array(z.union([GeocodeOutcomeSchema, z.object({ input: z.string(), error: z.string() })])),
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

/** `POST /v1/resolve` response — the same tree, decorated in place with gazetteer coords + attribution. */
export const ResolveResponseSchema = z
	.object({
		tree: z.looseObject({ roots: z.array(z.unknown()) }),
	})
	.openapi("ResolveResponse")

/**
 * `POST /v1/format` request body. `components` accepts `string | string[]` per key on the wire — a handler-side
 * concern, not this schema's: `@mailwoman/formatter`'s `ComponentDict` (`format.ts`) is `Partial<Record<ComponentTag,
 * string>>`, single-string only, so a route handler must join array values before calling
 * `formatAddress`/`canonicalKey`.
 */
export const FormatRequestSchema = z
	.object({
		components: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
		country: z.string(),
		options: z.looseObject({}).optional(),
	})
	.openapi("FormatRequest")

/** `POST /v1/format` response — the rendered string plus the deterministic canonical match key. */
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
