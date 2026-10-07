/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { APIOperation, APIOperationSchema } from "@mailwoman/api-kit/operation"
import { z } from "zod"

import { GeocoderUnavailableErrorSchema } from "#operations/errors"
import { MetaTag } from "#operations/tags"

/**
 * The versioned data switchover result: the new per-extract version map.
 */
export const ReloadResponseSchema = z
	.object({ reloaded: z.boolean(), versions: z.unknown() })
	.meta({ id: "ReloadResponse", description: "The versioned data switchover result." })

export type ReloadResponse = z.infer<typeof ReloadResponseSchema>

const ReloadData = {
	operationId: "reloadData",
	summary: "Reload versioned data extracts (deploy-only; check at ingress)",
	tags: [MetaTag.name],
	response: { 200: ReloadResponseSchema, 503: GeocoderUnavailableErrorSchema },
} as const satisfies APIOperationSchema

/**
 * `POST /v1/reload`: switch to the newest versioned data extracts.
 */
export const ReloadDataOperation = {
	method: "POST",
	pathname: "/v1/reload",
	schema: ReloadData,
} as const satisfies APIOperation

export type ReloadDataOperation = typeof ReloadDataOperation
