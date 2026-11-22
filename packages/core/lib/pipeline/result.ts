// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { AddressTree } from "#decoder/types"
import type { PipelineFault } from "#pipeline/stage"
import type {
	LocaleHint,
	NormalizedInputLite,
	PhraseProposal,
	PipelineTiming,
	QueryIntentMarker,
	QueryKindResult,
	QueryShapeLite,
	POIQueryResult,
} from "#pipeline/types"

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
	 * Stage 2.7 phrase proposals when a grouper was wired, consumed by Stage 3 as
	 * conditioning and Stage 5 as boundary candidates.
	 *
	 * Empty when no grouper ran or the fast path skipped Stage 2.7.
	 */
	phraseProposals: PhraseProposal[]
	tree: AddressTree
	/**
	 * The poi-intent stage's result, or `null` when it produced none.
	 */
	poiIntent: POIQueryResult | null
	timing: PipelineTiming
	/**
	 * Every stage crash the coordinator caught and degraded past, in order.
	 *
	 * The array is always present.
	 * An empty array states that no stage faulted.
	 * A missing field would make a different claim.
	 */
	faults: PipelineFault[]
	/**
	 * Query-intent advisories lifted from the kind classifier's verdict, always present
	 * so an empty array states that the vocabulary examined this query and made no
	 * statement — a different claim from a missing field.
	 *
	 * They're advisory by construction and didn't change which answer won.
	 */
	intentMarkers: QueryIntentMarker[]
	/**
	 * The path the coordinator took.
	 *
	 * `"fast-path"` skipped stages 3-5.
	 * `"poi"` took the intent branch.
	 */
	path: "fast-path" | "full" | "poi"
}
