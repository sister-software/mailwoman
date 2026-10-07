/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { MetricsSnapshotSchema } from "@mailwoman/api-kit"
import type { APIOperation, APIOperationSchema } from "@mailwoman/api-kit/operation"

import { MetaTag } from "#operations/tags"

const RetrieveMetrics = {
	operationId: "retrieveMetrics",
	summary: "In-process timing metrics snapshot",
	tags: [MetaTag.name],
	response: { 200: MetricsSnapshotSchema },
} as const satisfies APIOperationSchema

/**
 * `GET /metrics`: report latency percentiles and per-tier counts.
 */
export const RetrieveMetricsOperation = {
	method: "GET",
	pathname: "/metrics",
	schema: RetrieveMetrics,
} as const satisfies APIOperation

export type RetrieveMetricsOperation = typeof RetrieveMetricsOperation
