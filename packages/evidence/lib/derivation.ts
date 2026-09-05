/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The derivation behind an answer, as a projection: which constraints took part, what evidence each rested on,
 *   and what it contributed. A pure shaping function over records something else kept — no I/O, no ranking, no
 *   weights. Its one guarantee is that an answer's status is carried WITH the constraints that produced it, so an
 *   inferred value cannot be reported as a retrieved one without the record disagreeing.
 */

import type { Evidence } from "#evidence"
import type { EpistemicStatus } from "#status"

export interface DerivationNode {
	/**
	 * What the constraint was about, in the caller's vocabulary — a component tag and its value, a layer, a probe.
	 */
	label: string
	evidence: Evidence
	/**
	 * What this constraint did to the answer, as a sentence fragment a reader can audit.
	 */
	contribution: string
}

export interface DerivationProjection {
	status: EpistemicStatus
	constraints: readonly DerivationNode[]
	/**
	 * The answer's uncertainty radius in meters; `null` when the answer carries none, never a fabricated one.
	 */
	uncertaintyM: number | null
}

export interface DerivationInput {
	status: EpistemicStatus
	nodes: readonly DerivationNode[]
	uncertaintyM: number | null
}

/**
 * Shape a derivation for a reader. The result is frozen and holds copies of the nodes, so a caller that keeps mutating
 * its own record cannot change what was reported.
 */
export function projectDerivation(input: DerivationInput): DerivationProjection {
	const constraints = Object.freeze(input.nodes.map((node) => Object.freeze({ ...node })))

	return Object.freeze({ status: input.status, constraints, uncertaintyM: input.uncertaintyM })
}
