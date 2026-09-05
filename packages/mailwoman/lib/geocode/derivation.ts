/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The resolver-interior trace, projected into the derivation a result can carry. Each lookup record becomes one
 *   constraint: what was looked up, what the gazetteer answered, and how the pick was made. The trace already records
 *   the candidates, the per-stage ranks and every check, with no sink meaning no bookkeeping — so this is a projection
 *   of a record that exists, never a second record.
 */

import type { ResolveNodeTrace, ResolveOpts } from "@mailwoman/core/resolver"
import { type DerivationNode, type DerivationProjection, observation, projectDerivation } from "@mailwoman/evidence"

/**
 * The source name the trace's observations carry. The trace does not record the gazetteer extract's vintage, so the
 * observation carries `null` there; the answer's provenance names the artifact.
 */
export const TRACE_SOURCE = "gazetteer"

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

export interface TraceCollector {
	/**
	 * The sink to hand the resolver: the caller's own, wrapped so the records also feed the projection.
	 */
	traceSink: ResolveOpts["traceSink"]
	/**
	 * Attach the projected derivation to a finished result when a sink was supplied; otherwise return the result
	 * unchanged, without a field. The one branch lives here so the geocode core carries none.
	 */
	attach<T extends { epistemic_status: DerivationProjection["status"]; uncertainty_m: number | null }>(
		result: T
	): T & { derivation?: DerivationProjection }
}

/**
 * Wrap a caller's trace sink so the same records also feed the derivation projection. No sink means no wrapper, no
 * records and no `derivation` field: the walk does zero bookkeeping and stays byte-identical, and the opt-in cost is
 * never made unconditional here.
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
			if (!traceSink) return result

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
