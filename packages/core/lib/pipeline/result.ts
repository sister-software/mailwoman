/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @file Runtime pipeline result contract.
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
 * One stage crash the coordinator caught and degraded past.
 *
 * A fault is NOT an error return: `runPipeline` still resolves, and `tree` still carries whatever the remaining stages
 * could prove. What the fault buys the caller is the ability to tell "the model faulted and the rule-based stages
 * filled the tree back in" apart from "the model ran and found nothing" — which, before #40, was impossible from the
 * outside. See the `safeClassify` docstring for the measured failure this was written against.
 */
export interface PipelineFault {
	stage: PipelineFaultStage
	/**
	 * The thrown value's `name` (`TypeError`, `RangeError`, …), or `"Error"` when something that isn't an `Error` was
	 * thrown. Machine-stable enough to branch on; the `cause` carries the rest.
	 */
	name: string
	message: string
	/**
	 * The value the stage threw, verbatim — kept so a caller can rethrow it or read its stack. Not JSON-serializable in
	 * the useful sense; serialize `stage`/`name`/`message` when you need this on a wire.
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
	 * Stage 2.7 phrase proposals when a grouper was wired. Empty array when the coordinator ran with no grouper
	 * (pre-v0.5.0 callers) or when the fast-path skipped Stage 2.7. Stage 3 consumes this as conditioning; Stage 5
	 * consumes it as boundary candidates.
	 */
	phraseProposals: PhraseProposal[]
	tree: AddressTree
	/**
	 * Present only when the poi-intent stage produced an outcome (path === "poi").
	 */
	poiIntent?: POIIntentOutcome
	timing: PipelineTiming
	/**
	 * Every stage crash the coordinator caught and degraded past, in the order they happened. **Always present** — an
	 * empty array is the coordinator stating that no stage faulted, which is a different claim from a missing field.
	 * Non-empty means the tree you are holding was produced with at least one stage down; see {@link PipelineFault}.
	 */
	faults: PipelineFault[]
	/**
	 * Query-intent advisories (ROAD_TO_V9 §4), lifted from the kind classifier's verdict. **Always present** — an empty
	 * array is the coordinator stating that the intent vocabulary examined this query and had nothing to say, which is a
	 * different claim from a missing field (the {@link faults} discipline, same reasoning).
	 *
	 * Nothing here changed which answer won. The markers are advisory by construction: the two intent kinds that could
	 * have displaced a structural incumbent are scored below it, and the two that do win the top slot (`near_me`,
	 * `poi_category`) route exactly as their incumbents did.
	 */
	intentMarkers: QueryIntentMarker[]
	/**
	 * Which path the coordinator took. `"fast-path"` skipped stages 3-5; `"poi"` took the intent branch.
	 */
	path: "fast-path" | "full" | "poi"
}
