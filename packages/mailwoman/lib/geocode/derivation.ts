/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { ResolveNodeTrace, ResolveOpts } from "@mailwoman/core/resolver"
import { type DerivationNode, type DerivationProjection, observation, projectDerivation } from "@mailwoman/evidence"

/**
 * The source name on observations built from a resolve trace.
 *
 * Its vintage is `null` because the trace does not record the gazetteer extract's version.
 */
export const TRACE_SOURCE = "gazetteer"

/**
 * Convert one resolve-trace record into a derivation node stating which place
 * was picked, or why no place was.
 */
export function traceToDerivationNode(record: ResolveNodeTrace): DerivationNode {
	const label = `${record.tag}=${record.value}`

	if (record.picked) {
		return {
			label,
			evidence: observation(TRACE_SOURCE, null, {
				id: record.picked.id,
				name: record.picked.name,
				placetype: record.placetype,
				candidates: record.candidates.length,
			}),
			contribution: `picked ${record.picked.name} (${record.placetype}) by ${record.picked.source}`,
		}
	}

	return {
		label,
		evidence: observation(TRACE_SOURCE, null, {
			placetype: record.placetype,
			candidates: record.candidates.length,
			checks: record.checks,
		}),
		contribution: record.candidates.length
			? `resolved nothing: ${record.candidates.length} candidates, none passed ${record.checks.join(", ") || "the checks"}`
			: `resolved nothing: the register holds no ${record.placetype} for this value`,
	}
}

/**
 * A trace sink to pass to the resolver, paired with `attach`.
 *
 * That function adds the derivation built from its records to a result.
 */
export interface TraceCollector {
	/**
	 * The sink to pass to the resolver.
	 *
	 * It forwards each record to the caller's sink and keeps it for the derivation.
	 */
	traceSink: ResolveOpts["traceSink"]

	/**
	 * Adds the derivation built from the collected records to `result`.
	 * The derivation is null when the caller supplied no sink.
	 */
	attach<T extends { epistemic_status: DerivationProjection["status"]; uncertainty_m: number | null }>(
		result: T
	): T & { derivation: DerivationProjection | null }
}

/**
 * Wraps a caller's trace sink so its records also build the result's `derivation`.
 *
 * Without a caller sink it keeps no records, and `attach` sets a null derivation.
 * A caller opts in to tracing by passing a sink.
 */
export function traceCollector(callerSink: ResolveOpts["traceSink"]): TraceCollector {
	const records: ResolveNodeTrace[] = []

	const traceSink = callerSink
		? (record: ResolveNodeTrace) => {
				records.push(record)
				callerSink(record)
			}
		: undefined

	return {
		traceSink,
		attach(result) {
			if (!traceSink) return { ...result, derivation: null }

			return {
				...result,
				derivation: projectDerivation({
					status: result.epistemic_status,
					uncertaintyM: result.uncertainty_m,
					nodes: records.map(traceToDerivationNode),
				}),
			}
		},
	}
}
