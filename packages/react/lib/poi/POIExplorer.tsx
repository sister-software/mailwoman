/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type ReactNode, useState } from "react"

import { POI_DEFAULT_TEXT, POI_PRESETS } from "#poi/runtime"
import type { LoadPOIRuntime, POILiveSearch } from "#poi/types"
import { usePOISearch } from "#poi/usePOISearch"

import { ClientOnly } from "../common/ClientOnly.tsx"
import { KindBadge } from "../common/KindBadge.tsx"
import { PresetChips, type Preset } from "../common/PresetChips.tsx"
import { AbstainPanel } from "./AbstainPanel.tsx"
import { LiveResultsBlock } from "./LiveResultsBlock.tsx"
import { OverpassBlock } from "./OverpassBlock.tsx"
import { QueryInput } from "./QueryInput.tsx"
import { SubjectPanel } from "./SubjectPanel.tsx"

/**
 * Props for {@linkcode POIExplorer}.
 */
export interface POIExplorerProps {
	/**
	 * The query that pre-fills the input.
	 */
	defaultText?: string
	/**
	 * The example chips.
	 *
	 * @default POI_PRESETS
	 */
	presets?: ReadonlyArray<Preset>
	/**
	 * A replacement loader for the taxonomy runtime, such as a mock in stories and tests.
	 */
	loadRuntime?: LoadPOIRuntime
	/**
	 * The live poi.db search.
	 * Without it, the explorer shows only the detected intent.
	 */
	runLiveSearch?: POILiveSearch
	/**
	 * Whether {@link runLiveSearch} can search brand subjects by Wikidata QID.
	 *
	 * When it is false, a brand subject shows its intent and QID chip without a live block.
	 * A byte-range probe over httpvfs should leave it off because a brand-wide
	 * lookup reads too much of the database.
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

	// A category is searchable unless it is build-local.
	// A brand needs a QID and a brand-capable probe.
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

/**
 * Renders a POI-intent tester that detects a POI subject in free text.
 *
 * It shows the matched category or brand and, for categories, an OverpassQL export.
 * When `runLiveSearch` is set, it can also search the published poi.db.
 * It renders only on the client.
 */
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
