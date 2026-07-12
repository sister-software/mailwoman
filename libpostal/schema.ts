/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Zod wire schemas for the libpostal-compatible surface. Key names and error bodies are the
 *   vendor contract — immutable. Presence of `query`/`address` is enforced in the handlers (not
 *   the schemas) so validation failures keep libpostal's exact `{ error: "…" }` shape.
 */

import { z } from "@hono/zod-openapi"

/** `POST /parse` JSON body — `address` is accepted as an alias for `query`. */
export const ParseRequestSchema = z
	.object({
		query: z.string().optional(),
		address: z.string().optional(),
	})
	.openapi("ParseRequest")

/** `POST /expand` JSON body. */
export const ExpandRequestSchema = z
	.object({
		address: z.string().optional(),
	})
	.openapi("ExpandRequest")

/** A libpostal `parse_address` component — label + covered text, in order. */
export const LibpostalComponentSchema = z
	.object({
		label: z.string(),
		value: z.string(),
	})
	.openapi("LibpostalComponent")

export const ParseResponseSchema = z.array(LibpostalComponentSchema)

export const ExpandResponseSchema = z
	.object({
		expansions: z.array(z.string()),
	})
	.openapi("ExpandResponse")

/** Mirrors libpostal's JSON error envelope. */
export const ErrorSchema = z
	.object({
		error: z.string(),
	})
	.openapi("Error")
