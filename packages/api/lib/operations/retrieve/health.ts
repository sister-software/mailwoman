/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { APIOperation, APIOperationSchema } from "@mailwoman/api-kit/operation"
import { z } from "zod"

import { MetaTag } from "#operations/tags"

/**
 * The service health: `status` and `uptime_s` come from the route, the rest from the engine.
 */
export const HealthResponseSchema = z
	.looseObject({ status: z.literal("ok"), uptime_s: z.number() })
	.meta({ id: "HealthResponse", description: "Liveness and the engine's health block." })

export type HealthResponse = z.infer<typeof HealthResponseSchema>

const RetrieveHealth = {
	operationId: "retrieveHealth",
	summary: "Liveness + engine health",
	tags: [MetaTag.name],
	response: { 200: HealthResponseSchema },
} as const satisfies APIOperationSchema

/**
 * `GET /health`: report liveness and the engine's health.
 */
export const RetrieveHealthOperation = {
	method: "GET",
	pathname: "/health",
	schema: RetrieveHealth,
} as const satisfies APIOperation

export type RetrieveHealthOperation = typeof RetrieveHealthOperation
