/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `createNeuralProposalClassifier` builds the adapter that exposes a `NeuralAddressClassifier` as a
 *   `ProposalClassifier`, the `@mailwoman/core/types` interface that the policy registry consumes.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import type { AddressNode } from "@mailwoman/core/decoder"
import type { Span } from "@mailwoman/core/tokenization"
import type { ClassificationProposal, ClassifierContext, ProposalClassifier, Section } from "@mailwoman/core/types"

import type { NeuralAddressClassifier } from "#classifier/index"
import { STAGE2_TAGS } from "#labels"

export interface NeuralProposalClassifierConfig {
	/**
	 * Stable id surfaced as `source_id` on every proposal (e.g. `neural-v0.2.0-en-us`).
	 */
	id: string
	/**
	 * The underlying neural classifier, typed by the one method the adapter calls
	 * so a caller may supply anything that parses.
	 */
	classifier: Pick<NeuralAddressClassifier, "parse">
	/**
	 * Component tags this classifier may emit.
	 *
	 * Defaults to the Stage 2 tag set.
	 *
	 * A v0.2.0 Stage 1 model never decodes to a fine tag, so the broader default
	 * creates no backward-compatibility risk.
	 */
	emits?: readonly ComponentTag[]
	/**
	 * Locales this classifier is active for.
	 *
	 * `["*"]` by default.
	 */
	locales?: readonly (string | "*")[]
	/**
	 * Default penalty applied to emitted proposals, 0 by default.
	 */
	penalty?: number
}

/**
 * Build a `ProposalClassifier` backed by a `NeuralAddressClassifier`.
 */
export function createNeuralProposalClassifier(cfg: NeuralProposalClassifierConfig): ProposalClassifier {
	const emits = cfg.emits ?? STAGE2_TAGS
	const emitsSet = new Set<ComponentTag>(emits as readonly ComponentTag[])
	const penalty = cfg.penalty ?? 0

	async function classify(section: Section, _ctx: ClassifierContext): Promise<ClassificationProposal[]> {
		// Postcode regex repair is on by default.
		// It fixes SentencePiece fragmentation misses.
		const tree = await cfg.classifier.parse(section.body, { postcodeRepair: true })
		const proposals: ClassificationProposal[] = []
		const sectionOffset = section.start

		const visit = (node: AddressNode): void => {
			if (emitsSet.has(node.tag)) {
				// Avoid `Span.from(...)`, where the tokenization module would run a filesystem-bound
				// module-init (libpostal data dir scan) on every consumer of this module.
				// The solver and policy registry read only `start`, `end` and `body`.
				// A consumer needing full Span behavior reconstructs it through `Span.from`.
				const span = {
					start: sectionOffset + node.start,
					end: sectionOffset + node.end,
					body: node.value,
				} as Span

				proposals.push({
					span,
					component: node.tag,
					confidence: node.confidence,
					source: "neural",
					source_id: cfg.id,
					penalty,
				})
			}

			for (const child of node.children) {
				visit(child)
			}
		}

		for (const root of tree.roots) {
			visit(root)
		}

		return proposals
	}

	return {
		id: cfg.id,
		emits,
		locales: cfg.locales ?? ["*"],
		classify,
	}
}
