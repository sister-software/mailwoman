/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `POIExplorer` — the composed POI-intent tester. Detects a POI subject in free text, shows the
 *   category + OverpassQL export, and (when a live-search probe is injected) searches the published
 *   poi.db layer. The intent path is self-contained — no weights, no network. All runtime concerns are
 *   in {@link usePOISearch}; this file is composition + a `ClientOnly` SSR boundary.
 */

import { type ReactNode, useState } from "react"

import { ClientOnly } from "../common/ClientOnly.tsx"
import { KindBadge } from "../common/KindBadge.tsx"
import { PresetChips, type Preset } from "../common/PresetChips.tsx"
import { AbstainPanel } from "./AbstainPanel.tsx"
import { LiveResultsBlock } from "./LiveResultsBlock.tsx"
import { OverpassBlock } from "./OverpassBlock.tsx"
import { QueryInput } from "./QueryInput.tsx"
import { POI_DEFAULT_TEXT, POI_PRESETS } from "./runtime.ts"
import { SubjectPanel } from "./SubjectPanel.tsx"
import type { LoadPOIRuntime, POILiveSearch } from "./types.ts"
import { usePOISearch } from "./usePOISearch.ts"

export interface POIExplorerProps {
	/** Query to pre-fill in the input. */
	defaultText?: string
	/** Example chips. @default the built-in POI presets */
	presets?: ReadonlyArray<Preset>
	/** Override the taxonomy-runtime loader (stories/tests inject a mock). */
	loadRuntime?: LoadPOIRuntime
	/** Live poi.db probe. Absent ⇒ intent-only (no live-results affordance). */
	runLiveSearch?: POILiveSearch
}

interface POIExplorerInnerProps extends POIExplorerProps {
	defaultText: string
	presets: ReadonlyArray<Preset>
}

function POIExplorerInner({ defaultText, presets, loadRuntime, runLiveSearch }: POIExplorerInnerProps): ReactNode {
	const [text, setText] = useState(defaultText)
	const { result, liveSearch, searchLive } = usePOISearch({ text, loadRuntime, runLiveSearch })

	return (
		<div className="mw-poi-explorer">
			<QueryInput id="mw-poi-input" label="Query" value={text} onChange={setText} placeholder={POI_DEFAULT_TEXT} />
			<PresetChips presets={presets} onPick={setText} />

			{result ? (
				<div className="mw-result">
					<KindBadge kindResult={result.kindResult} />

					{result.subject ? (
						<>
							<SubjectPanel subject={result.subject} />
							<OverpassBlock overpassQL={result.overpassQL} overpassError={result.overpassError} />

							{runLiveSearch && !result.subject.buildLocal ? (
								<LiveResultsBlock
									categoryLabel={result.subject.category.label}
									anchor={result.subject.remainder}
									state={liveSearch}
									onSearch={searchLive}
								/>
							) : null}
						</>
					) : (
						<AbstainPanel kind={result.kindResult.kind} />
					)}
				</div>
			) : null}
		</div>
	)
}

export function POIExplorer({
	defaultText = POI_DEFAULT_TEXT,
	presets = POI_PRESETS,
	loadRuntime,
	runLiveSearch,
}: POIExplorerProps): ReactNode {
	return (
		<ClientOnly
			fallback={
				<div className="mw-poi-explorer">
					<p>Loading POI tester…</p>
				</div>
			}
		>
			{() => (
				<POIExplorerInner
					defaultText={defaultText}
					presets={presets}
					loadRuntime={loadRuntime}
					runLiveSearch={runLiveSearch}
				/>
			)}
		</ClientOnly>
	)
}
