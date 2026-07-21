/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<ResultPanel>` — the demo's parse+resolve result block, assembled from the SHARED pipeline
 *   presentational units (it does not re-implement any of them): `KindBadge`, `ComponentTable`,
 *   `ResolvedPlace`, `CandidatePicker`, plus the `CopyButton` + `buildParsePayload` copy affordance. This
 *   is the standalone, story-testable unit the demo's floating panel renders (the map analogue of the
 *   result block PipelineExplorer inlines), so `GeocoderDemo` composes ONE panel instead of duplicating
 *   the marker/table/candidate glue. Heavy host visualizers (span highlight, tree, timing) slot in via
 *   `extras`; the no-resolve diagnostic via `failure`.
 *
 *   NODE-SAFE: pure React + the shared units, no maplibre.
 */

import type { ReactNode } from "react"

import { CopyButton } from "../common/CopyButton.tsx"
import { KindBadge } from "../common/KindBadge.tsx"
import { CandidatePicker } from "../pipeline/CandidatePicker.tsx"
import { ComponentTable } from "../pipeline/ComponentTable.tsx"
import { buildParsePayload } from "../pipeline/copy.ts"
import { ResolvedPlace } from "../pipeline/ResolvedPlace.tsx"
import type { ParseResult, ResolvedPlaceView } from "../pipeline/types.ts"

export interface ResultPanelProps {
	/** The parse+resolve result to render. */
	result: ParseResult
	/** The selected candidate (falls back to the first), used for the resolved-place detail + copy payload. */
	selectedCandidate: ResolvedPlaceView | null
	/** The selected candidate index, for the picker's active state. */
	selectedCandidateIndex: number
	/** Fired when a candidate in the picker is chosen. */
	onSelectCandidate: (index: number) => void
	/** Host-injected heavy visualizers (span highlight, tree, timing, …), rendered from the result. */
	extras?: (result: ParseResult) => ReactNode
	/** Host-injected no-resolve diagnostic, rendered when nothing resolved. */
	failure?: (result: ParseResult) => ReactNode
}

/** The composed result block for the geocoder demo. */
export function ResultPanel({
	result,
	selectedCandidate,
	selectedCandidateIndex,
	onSelectCandidate,
	extras,
	failure,
}: ResultPanelProps): ReactNode {
	return (
		<div className="mw-result">
			<div className="mw-result__header">
				<h2>Parsed components</h2>
				<CopyButton
					value={() => buildParsePayload(result, selectedCandidate)}
					label="Copy JSON"
					copiedLabel="✓ Copied"
				/>
			</div>

			{result.kindResult ? <KindBadge kindResult={result.kindResult} /> : null}

			{extras ? extras(result) : null}

			<ComponentTable nodes={result.nodes} />

			{selectedCandidate ? (
				<>
					<ResolvedPlace place={selectedCandidate} dualRoles={result.dualRoles} />
					{result.candidates.length > 1 ? (
						<CandidatePicker
							candidates={result.candidates}
							selectedIndex={selectedCandidateIndex}
							onSelect={onSelectCandidate}
						/>
					) : null}
				</>
			) : failure ? (
				failure(result)
			) : null}
		</div>
	)
}
