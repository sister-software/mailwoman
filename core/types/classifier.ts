/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Classifier-side contracts for the neural integration (per #6).
 *
 *   These interfaces are deliberately distinct from the existing `Classifier` shape in
 *   `../classification/BaseClassifier.ts`. The legacy shape is mutation-based —
 *   `classifyTokens(context): void` — and runs synchronously over the span graph. The shape
 *   declared here is pull-based and async: a classifier returns a list of `ClassificationProposal`
 *   objects keyed by the canonical `ComponentTag` union.
 *
 *   Both shapes co-exist during the Ship-of-Theseus rollout. Rule classifiers are wrapped via
 *   `wrapLegacyClassifier` (see `@mailwoman/classifiers`); the neural classifier (Phase 3)
 *   implements this interface natively. The solver consumes one normalized shape.
 */

import type { Span } from "../tokenization/index.ts"
import type { ComponentTag } from "./component.ts"

/**
 * Sections in Mailwoman are sub-Spans of the tokenized input (split by boundary characters: commas, line breaks, etc.).
 * They are surfaced as `Span` instances in `TokenContext.sections`; this alias documents the call-site intent.
 */
export type Section = Span

/**
 * Source of a `ClassificationProposal`. Drives policy decisions and downstream telemetry.
 *
 * - `rule`: emitted by a legacy rule classifier through the adapter.
 * - `neural`: emitted by an ONNX-backed sequence classifier.
 * - `merged`: synthetic source for a merger that fused proposals from multiple classifiers (rare; mostly for telemetry on
 *   `merged` ids).
 */
export type ClassificationProposalSource = "rule" | "neural" | "merged"

/**
 * A typed classification candidate produced by any classifier.
 *
 * Mirrors Mailwoman's pre-refactor per-component output shape with the addition of `source` and `source_id` so
 * downstream code can identify the origin of each proposal without consulting external state.
 */
export interface ClassificationProposal {
	/** Span this proposal applies to. */
	span: Span

	/** Component type the classifier thinks this span is. */
	component: ComponentTag

	/** Classifier confidence in [0, 1]. */
	confidence: number

	/** Provenance — which classifier family produced this proposal. */
	source: ClassificationProposalSource

	/**
	 * Identifier of the specific classifier instance. Rule wrappers use the legacy classifier's stable id (e.g.
	 * `house_number`, `postcode`, `whos_on_first`). Neural classifiers use a versioned model id like
	 * `neural-v0.3.1-en-us`.
	 */
	source_id: string

	/**
	 * Solver penalty applied to this proposal. Higher penalty makes the proposal less likely to appear in the winning
	 * solution.
	 */
	penalty: number

	/**
	 * Opaque metadata for debugging and telemetry. Never consulted by the solver. Common keys: `languages`, `flags`,
	 * `legacyClassification`.
	 */
	metadata?: Record<string, unknown>
}

/**
 * Per-request context handed to a classifier.
 */
export interface ClassifierContext {
	/** Locale for this classification request, if known. */
	locale?: string

	/** Proposals already produced for this request (for composites). */
	prior?: readonly ClassificationProposal[]

	/** Cancellation signal. */
	signal?: AbortSignal
}

/**
 * Plug-in contract every classifier implements.
 *
 * Construction must be cheap; per-classification work runs in {@link classify}. Pre-flight work (loading dictionaries,
 * warming up an ONNX session) belongs in the optional `ready()` step.
 */
export interface ProposalClassifier {
	/** Stable identifier. Used as `source_id` on emitted proposals. */
	readonly id: string

	/**
	 * Components this classifier may emit. Enforced — proposals for tags outside this list are dropped by the adapter
	 * with a warning.
	 */
	readonly emits: readonly ComponentTag[]

	/**
	 * Locales this classifier serves. `"*"` means locale-agnostic.
	 *
	 * The policy layer uses this to skip classifiers that aren't relevant to the requested locale.
	 */
	readonly locales: readonly (string | "*")[]

	/** Optional async pre-flight. */
	ready?(): Promise<void>

	/**
	 * Classify a section. Implementations MUST NOT throw — return an empty array on failure and log via the project
	 * logger.
	 */
	classify(section: Section, context: ClassifierContext): Promise<ClassificationProposal[]>
}

/**
 * Convenience: synchronous classifier (legacy rule wrappers usually fit here). The adapter wraps these into the async
 * `ProposalClassifier` interface so the solver path stays uniform.
 */
export interface SyncProposalClassifier {
	readonly id: string
	readonly emits: readonly ComponentTag[]
	readonly locales: readonly (string | "*")[]
	classifySync(section: Section, context: ClassifierContext): ClassificationProposal[]
}
