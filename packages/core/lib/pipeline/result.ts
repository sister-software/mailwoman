/**
 * @copyright Sister Software
 * @license AGPL-3.0
 */

import type { AddressTree } from "#decoder/types"
import type {
	LocaleHint,
	NormalizedInputLite,
	PhraseProposal,
	PipelineTiming,
	PipelineFaultStage,
	QueryIntentMarker,
	QueryKindResult,
	QueryShapeLite,
	POIIntentOutcome,
} from "#pipeline/types"

/**
 * One stage crash the coordinator caught and degraded past: `runPipeline` still resolves,
 * and `tree` still carries whatever the remaining stages could prove.
 */
export interface PipelineFault {
	stage: PipelineFaultStage
	/**
	 * The thrown value's `name`, or `"Error"` when something that isn't an `Error` was thrown;
	 * machine-stable enough to branch on, with the `cause` carrying the rest.
	 */
	name: string
	message: string
	/**
	 * The value the stage threw, verbatim: not JSON-serializable in the useful sense,
	 * so serialize `stage`/`name`/`message` when you need this on a wire.
	 */
	cause: unknown
}

/**
 * Result of one `runPipeline` call.
 */
export interface PipelineResult {
	input: string
	normalized: NormalizedInputLite
	queryShape: QueryShapeLite
	locale: LocaleHint
	kind: QueryKindResult
	/**
	 * Stage 2.7 phrase proposals when a grouper was wired, consumed by Stage 3 as conditioning
	 * and Stage 5 as boundary candidates; empty when no grouper ran or the fast path skipped Stage 2.7.
	 */
	phraseProposals: PhraseProposal[]
	tree: AddressTree
	/**
	 * Present only when the poi-intent stage produced an outcome.
	 */
	poiIntent?: POIIntentOutcome
	timing: PipelineTiming
	/**
	 * Every stage crash the coordinator caught and degraded past, in order; the array is always present,
	 * so an empty one states that no stage faulted, which is a different claim from a missing field.
	 */
	faults: PipelineFault[]
	/**
	 * Query-intent advisories lifted from the kind classifier's verdict, always present
	 * so an empty array states that the vocabulary examined this query and made no
	 * statement — a different claim from a missing field.
	 *
	 * They are advisory by construction and did not change which answer won.
	 */
	intentMarkers: QueryIntentMarker[]
	/**
	 * Which path the coordinator took: `"fast-path"` skipped stages 3-5, and `"poi"` took the intent branch.
	 */
	path: "fast-path" | "full" | "poi"
}
