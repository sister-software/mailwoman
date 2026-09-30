/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Interfaces between a classifier and the policy layer.
 *
 *   A classifier is pull-based and async: given a section of the input, it returns a list of
 *   `ClassificationProposal` objects keyed by the canonical `ComponentTag` union. The policy registry
 *   filters those proposals by component and locale. The decoder converts the survivors into an
 *   `AddressTree`. `@mailwoman/neural` provides the one classifier implementation.
 */

import type { ComponentTag } from "@mailwoman/codex/component"

import type { Span } from "#tokenization"

/**
 * A section is a sub-span of the input that a classifier receives as one unit.
 *
 * A caller may split the input at boundary characters such as commas and line breaks.
 * A caller may also pass the whole input as a single section.
 * The alias documents the call-site intent.
 */
export type Section = Span

/**
 * Source of a `ClassificationProposal`.
 *
 * The policy registry selects proposals by source.
 * Telemetry groups them by source.
 *
 * - `neural`: emitted by an ONNX-backed sequence classifier.
 * - `merged`: synthetic source for a merger that fused proposals from multiple classifiers.
 */
export type ClassificationProposalSource = "neural" | "merged"

/**
 * A typed classification candidate produced by a classifier.
 *
 * `source` and `source_id` identify the origin of each proposal without external state.
 */
export interface ClassificationProposal {
	/**
	 * Span this proposal applies to.
	 */
	span: Span

	/**
	 * Component type the classifier thinks this span is.
	 */
	component: ComponentTag

	/**
	 * Classifier confidence in [0, 1].
	 */
	confidence: number

	/**
	 * The classifier family that produced this proposal.
	 */
	source: ClassificationProposalSource

	/**
	 * Identifier of the specific classifier instance.
	 *
	 * A neural classifier uses a versioned model id such as `neural-v0.3.1-en-us`.
	 */
	source_id: string

	/**
	 * Solver penalty applied to this proposal.
	 *
	 * Higher penalty makes the proposal less likely to appear in the winning solution.
	 */
	penalty: number

	/**
	 * Opaque metadata for debugging and telemetry.
	 *
	 * Never consulted by the solver.
	 */
	metadata?: Record<string, unknown>
}

/**
 * Per-request context handed to a classifier.
 */
export interface ClassifierContext {
	/**
	 * Locale for this classification request, if known.
	 */
	locale?: string

	/**
	 * Proposals already produced for this request (for composites).
	 */
	prior?: readonly ClassificationProposal[]

	/**
	 * Cancellation signal.
	 */
	signal?: AbortSignal
}

/**
 * Plug-in interface every classifier implements.
 *
 * Construction must be cheap.
 * Per-classification work runs in {@link classify}.
 *
 * Pre-flight work (loading dictionaries, warming up an ONNX session) belongs in the optional `ready()` step.
 */
export interface ProposalClassifier {
	/**
	 * Stable identifier.
	 *
	 * Used as `source_id` on emitted proposals.
	 */
	readonly id: string

	/**
	 * Components this classifier may emit.
	 *
	 * An implementation restricts its own output to this list.
	 */
	readonly emits: readonly ComponentTag[]

	/**
	 * Locales this classifier serves.
	 *
	 * `"*"` means locale-agnostic.
	 *
	 * The policy layer uses this to skip classifiers that aren't relevant to the requested locale.
	 */
	readonly locales: readonly (string | "*")[]

	/**
	 * Optional async pre-flight.
	 */
	ready?(): Promise<void>

	/**
	 * Classify a section.
	 *
	 * Implementations must not throw.
	 * They return an empty array on failure and log via the project logger.
	 */
	classify(section: Section, context: ClassifierContext): Promise<ClassificationProposal[]>
}
