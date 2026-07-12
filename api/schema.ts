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
 * modeled: `SerializedSolution` carries the solver's internal match/classification detail, which is the engine's
 * contract, not this wire schema's.
 */
export const ParseOutcomeSchema = z
	.object({
		input: z.object({
			body: z.string(),
			start: z.number(),
			end: z.number(),
		}),
		solutions: z.array(z.looseObject({})),
		debug: z.string().optional(),
	})
	.openapi("ParseOutcome")

/** `POST /v1/geocode` request body. */
export const GeocodeRequestSchema = z
	.object({
		address: z.string(),
	})
	.openapi("GeocodeRequest")

/** `POST /v1/geocode` response — the geocode-core `GeocodeResult` shape passed through verbatim. */
export const GeocodeOutcomeSchema = z.looseObject({}).openapi("GeocodeOutcome")

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

/** `GET /health` response — loose: the engine's `HealthData` block (model card, data-root inventory) is engine-defined. */
export const HealthResponseSchema = z.looseObject({}).openapi("HealthResponse")
