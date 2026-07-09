/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `NeuralProposalClassifier` — adapter that exposes a `NeuralAddressClassifier` as a
 *   `ProposalClassifier` (the `@mailwoman/core/types` contract that the policy registry consumes).
 *
 *   Implementation: for each section, run the neural classifier on `section.body`, walk the resulting
 *   `AddressTree`, and emit one `ClassificationProposal` per node whose tag is in the `emits` list.
 *   Spans are rebased to the original input via `section.start + node.start` so downstream
 *   consumers see character offsets in the caller's coordinate space — same convention as
 *   `wrapLegacyClassifier`.
 *
 *   Per-section calls trade a small amount of context for the uniform `ProposalClassifier` shape.
 *   Addresses inside a section are typically short and the model handles them well; whole-input
 *   inference is a future optimization once the policy layer has a way to invoke a classifier "once
 *   per parse" instead of per section.
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import type { Span } from "@mailwoman/core/tokenization"
import type {
	ClassificationProposal,
	ClassifierContext,
	ComponentTag,
	ProposalClassifier,
	Section,
} from "@mailwoman/core/types"

import type { NeuralAddressClassifier } from "./classifier.ts"
import { STAGE2_TAGS } from "./labels.ts"

export interface NeuralProposalClassifierConfig {
	/** Stable id surfaced as `source_id` on every proposal (e.g. `neural-v0.2.0-en-us`). */
	id: string
	/** The underlying neural classifier instance. */
	classifier: NeuralAddressClassifier
	/**
	 * Component tags this classifier may emit. Defaults to the Stage 2 tag set (coarse + venue/street/house_number).
	 * v0.2.0 Stage 1 models never decode to the fine tags anyway, so the broader default is forwards-compat without
	 * back-compat risk.
	 */
	emits?: readonly ComponentTag[]
	/** Locales this classifier is active for. `["*"]` (locale-agnostic) by default. */
	locales?: readonly (string | "*")[]
	/** Default penalty applied to emitted proposals. Default 0. */
	penalty?: number
}

/** Build a `ProposalClassifier` backed by a `NeuralAddressClassifier`. */
export function createNeuralProposalClassifier(cfg: NeuralProposalClassifierConfig): ProposalClassifier {
	const emits = cfg.emits ?? STAGE2_TAGS
	const emitsSet = new Set<ComponentTag>(emits as readonly ComponentTag[])
	const penalty = cfg.penalty ?? 0

	async function classify(section: Section, _ctx: ClassifierContext): Promise<ClassificationProposal[]> {
		// Postcode regex repair on by default (v0.7 #35, operator-signed): +135/0 on the postcode
		// harness, model-independent. Fixes the SentencePiece-fragmentation misses (GB/CA/NL/…).
		const tree = await cfg.classifier.parse(section.body, { postcodeRepair: true })
		const proposals: ClassificationProposal[] = []
		const sectionOffset = section.start

		const visit = (node: AddressNode): void => {
			if (emitsSet.has(node.tag)) {
				// Emit a structurally-Span-shaped record. We intentionally avoid `Span.from(...)` here:
				// the tokenization module performs filesystem-bound module-init (libpostal data dir
				// scan) which we don't want to force on every consumer of the proposal-classifier. The
				// solver and policy registry read `start` / `end` / `body` only; if a downstream
				// consumer needs the full Span behavior (graph membership, classifications, …), it
				// should re-construct via Span.from(p.span.body, { start: p.span.start }).
				const span = {
					start: sectionOffset + node.start,
					end: sectionOffset + node.end,
					body: node.value,
				} as unknown as Span
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
