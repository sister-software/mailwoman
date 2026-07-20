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
	/**
	 * Whether {@link runLiveSearch} can serve BRAND subjects (fetch by QID). Default false: a brand subject shows the
	 * intent + QID chip but no live block. The docs' httpvfs probe leaves this off (brand-wide byte-range hydration is
	 * pathological — measured); a server-side backend can enable it.
	 */
	brandLiveSearch?: boolean
}

interface POIExplorerInnerProps extends POIExplorerProps {
	defaultText: string
	presets: ReadonlyArray<Preset>
}

function POIExplorerInner({
	defaultText,
	presets,
	loadRuntime,
	runLiveSearch,
	brandLiveSearch,
}: POIExplorerInnerProps): ReactNode {
	const [text, setText] = useState(defaultText)
	const { result, liveSearch, searchLive } = usePOISearch({
		text,
		loadRuntime,
		runLiveSearch,
		brandLiveSearch,
	})

	const subject = result?.subject
	// The live block appears whenever the subject COULD be live-searched with an anchor — i.e. capable minus the
	// anchor-present requirement (`canSearchLive` also requires an anchor; the block itself renders the "add an anchor"
	// hint, so it must show one step earlier). Category: not build-local. Brand: brand-capable probe + a QID.
	const showLiveBlock = Boolean(
		runLiveSearch &&
		subject &&
		(subject.kind === "brand" ? brandLiveSearch && subject.wikidata !== undefined : !subject.buildLocal)
	)

	return (
		<div className="mw-poi-explorer">
			<QueryInput id="mw-poi-input" label="Query" value={text} onChange={setText} placeholder={POI_DEFAULT_TEXT} />
			<PresetChips presets={presets} onPick={setText} />

			{result ? (
				<div className="mw-result">
					<KindBadge kindResult={result.kindResult} />

					{subject ? (
						<>
							<SubjectPanel subject={subject} />
							{subject.kind === "category" ? (
								<OverpassBlock overpassQL={result.overpassQL} overpassError={result.overpassError} />
							) : null}

							{showLiveBlock ? (
								<LiveResultsBlock
									subjectLabel={subject.kind === "brand" ? subject.name : subject.category.label}
									anchor={subject.remainder}
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
	brandLiveSearch,
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
					brandLiveSearch={brandLiveSearch}
				/>
			)}
		</ClientOnly>
	)
}
