/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Project the constraints, evidence and contributions behind an answer. This function performs no I/O or
 *   ranking and preserves the answer's epistemic status alongside its constraints.
 */

import { z } from "zod"

import { EvidenceSchema } from "#evidence"
import { type EpistemicStatus, EpistemicStatusSchema } from "#status"

/**
 * One constraint behind an answer.
 */
export const DerivationNodeSchema = z.object({
	/**
	 * Constraint target, such as a component, layer, or probe.
	 */
	label: z.string(),
	evidence: EvidenceSchema,
	/**
	 * Auditable description of the constraint's effect on the answer.
	 */
	contribution: z.string(),
})

export type DerivationNode = z.infer<typeof DerivationNodeSchema>

/**
 * The derivation behind an answer: its epistemic status, constraints and uncertainty.
 */
export const DerivationProjectionSchema = z
	.object({
		status: EpistemicStatusSchema,
		constraints: z.array(DerivationNodeSchema).readonly(),
		/**
		 * Uncertainty radius in meters, or `null` when unknown.
		 */
		uncertaintyM: z.number().nullable(),
	})
	.meta({ id: "DerivationProjection", description: "The derivation behind an answer." })

export type DerivationProjection = z.infer<typeof DerivationProjectionSchema>

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
