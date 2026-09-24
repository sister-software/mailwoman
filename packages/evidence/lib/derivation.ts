/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Project the constraints, evidence, and contributions behind an answer. This function performs no I/O or
 *   ranking and preserves the answer's epistemic status alongside its constraints.
 */

import type { Evidence } from "#evidence"
import type { EpistemicStatus } from "#status"

export interface DerivationNode {
	/**
	 * Constraint target, such as a component, layer, or probe.
	 */
	label: string
	evidence: Evidence
	/**
	 * Auditable description of the constraint's effect on the answer.
	 */
	contribution: string
}

export interface DerivationProjection {
	status: EpistemicStatus
	constraints: readonly DerivationNode[]
	/**
	 * Uncertainty radius in meters, or `null` when unknown.
	 */
	uncertaintyM: number | null
}

export interface DerivationInput {
	status: EpistemicStatus
	nodes: readonly DerivationNode[]
	uncertaintyM: number | null
}

/**
 * Freeze a derivation projection and copies of its constraint nodes.
 */
export function projectDerivation(input: DerivationInput): DerivationProjection {
	const constraints = Object.freeze(input.nodes.map((node) => Object.freeze({ ...node })))

	return Object.freeze({ status: input.status, constraints, uncertaintyM: input.uncertaintyM })
}
