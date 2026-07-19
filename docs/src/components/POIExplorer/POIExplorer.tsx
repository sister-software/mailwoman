/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   POIExplorer — a self-contained, embeddable POI-intent tester for Docusaurus MDX pages. Unlike
 *   PipelineExplorer, this needs NO weights, NO network, and NO DemoEmbed context: subject detection
 *   is `@mailwoman/kind-classifier`'s pure `matchPOISubject` + `createKindClassifier` over the
 *   `@mailwoman/poi-taxonomy` lexicon (bundled as a JSON data file, injected into the browser-safe
 *   `./table` entry), and the OverpassQL block comes from the relocated `@mailwoman/poi-taxonomy/overpass`
 *   emitter. Live poi.db results are a separate, later concern (need the R2-published build-local layer).
 *
 *   Wraps BrowserOnly (SSR-safe) per the PipelineExplorer convention, though every module used here is
 *   pure/side-effect-free and would be safe to evaluate under SSR too — the wrapper keeps the debounce
 *   timers and clipboard access off the server render regardless.
 *
 *   Live poi.db results (category queries only) are wired via `../../shared/poi-httpvfs.ts`, a SECOND
 *   sql.js-httpvfs worker over the published layer — dynamically imported on the first "Search live"
 *   click, not eagerly, so the intent-only path (the common case) never pays for it. Deliberately
 *   skips `DemoEmbedProvider`: that context loads the full model/classifier/FST bundle this tester
 *   doesn't need, just to hand down a `sqljsBaseURL` string this component can compute itself the same
 *   way `/trace` and `/demo` do (`useSiteConfig().baseURL + "mailwoman/sqljs"`).
 *
 *   Usage in MDX:
 *
 *   ```mdx
 *   import { POIExplorer } from "@site/src/components/POIExplorer/POIExplorer"
 *
 *   <POIExplorer />
 *   ```
 */

import BrowserOnly from "@docusaurus/BrowserOnly"
import { createKindClassifier, matchPOISubject } from "@mailwoman/kind-classifier"
import type { POIPhraseLookup, QueryKindResult } from "@mailwoman/kind-classifier"
// The .json extension is required on the specifier — `resolveJsonModule` resolves it to the parsed
// object's inferred shape, which is why the cast below is needed to satisfy `POITaxonomyTable`'s
// branded `POICategoryID` fields.
import taxonomyTableJSON from "@mailwoman/poi-taxonomy/data/taxonomy.json"
import { emitOverpassQL } from "@mailwoman/poi-taxonomy/overpass"
import type { OverpassIntentLike } from "@mailwoman/poi-taxonomy/overpass"
import { createPOITaxonomyLookup } from "@mailwoman/poi-taxonomy/table"
import { computeQueryShape } from "@mailwoman/query-shape"
import React, { useCallback, useEffect, useState } from "react"

import { useSiteConfig } from "../../hooks/site.ts"
import type { POISearchHit } from "../../shared/poi-httpvfs.ts"
import { KindBadge } from "../KindBadge/KindBadge.tsx"

import styles from "./styles.module.css"

// ---------------------------------------------------------------------------
// Module-level setup — pure, runs once when the chunk loads.
// ---------------------------------------------------------------------------

const taxonomyLookup = createPOITaxonomyLookup(
	taxonomyTableJSON as unknown as Parameters<typeof createPOITaxonomyLookup>[0]
)

type CategoryRecord = NonNullable<ReturnType<typeof taxonomyLookup.getPOICategory>>

/**
 * Adapts `POITaxonomyLookup.lookupPOICategory` to the `POIPhraseLookup` shape `matchPOISubject`/`createKindClassifier`
 * expect.
 */
const poiLexicon: POIPhraseLookup = (phrase, locale) =>
	taxonomyLookup.lookupPOICategory(phrase, locale).map((match) => ({
		kind: "category",
		categoryID: match.category.id,
		matchedPhrase: match.matchedPhrase,
		confidence: match.confidence,
	}))

const classifyPOIKind = createKindClassifier({ poiLexicon })

const PRESETS: ReadonlyArray<{ label: string; text: string }> = [
	{ label: "Drinking fountain", text: "drinking fountain near Springfield" },
	{ label: "Fire hydrant", text: "fire hydrant" },
	{ label: "Hospital + address", text: "hospital, 350 5th Ave, New York" },
	{ label: "Biking trails", text: "biking trails near Portland" },
]

const DEFAULT_TEXT = PRESETS[0]!.text

/** `742 m` under 1 km, `1.9 km` past it — matches the demo's distance captions. */
function formatDistance(distanceM: number): string {
	if (distanceM < 1000) return `${Math.round(distanceM)} m`

	return `${(distanceM / 1000).toFixed(1)} km`
}

interface POIExplorerSubject {
	category: CategoryRecord
	matchedPhrase: string
	confidence: number
	remainder: string
}

interface POIExplorerResult {
	kindResult: QueryKindResult
	subject?: POIExplorerSubject
	overpassQL?: string
	overpassError?: string
}

/**
 * "Search live" state machine. `error` distinguishes the two failure modes the button can hit: the anchor text not
 * resolving against the candidate gazetteer ("couldn't place '<anchor>'") vs the published poi.db being unreachable
 * (network/404 — the layer upload can lag a release). Both keep the intent/OverpassQL panel above fully intact.
 */
type LiveSearchState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "success"; hits: POISearchHit[]; centerName: string }

// ---------------------------------------------------------------------------
// POIExplorer props
// ---------------------------------------------------------------------------

export interface POIExplorerProps {
	/** Query to pre-fill in the input. */
	defaultText?: string
}

// ---------------------------------------------------------------------------
// Inner component (below the BrowserOnly boundary)
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 250

const POIExplorerInner: React.FC<{ defaultText: string }> = ({ defaultText }) => {
	const { baseURL } = useSiteConfig()
	const sqljsBaseURL = `${baseURL}mailwoman/sqljs`

	const [text, setText] = useState(defaultText)
	const [debouncedText, setDebouncedText] = useState(defaultText)
	const [result, setResult] = useState<POIExplorerResult | null>(null)
	const [copied, setCopied] = useState(false)
	const [liveSearch, setLiveSearch] = useState<LiveSearchState>({ status: "idle" })

	// Debounce the input before classifying — avoids re-running the (cheap, but still per-keystroke)
	// classifier on every character.
	useEffect(() => {
		const id = window.setTimeout(() => setDebouncedText(text), DEBOUNCE_MS)

		return () => window.clearTimeout(id)
	}, [text])

	useEffect(() => {
		let cancelled = false
		const trimmed = debouncedText.trim()

		// A new query invalidates any live results from the PREVIOUS query — otherwise a stale results
		// list would sit under a freshly-typed, unrelated category.
		setLiveSearch({ status: "idle" })

		if (!trimmed) {
			setResult(null)

			return
		}

		const input = { raw: trimmed, normalized: trimmed }
		const shape = computeQueryShape(trimmed)

		classifyPOIKind(input, shape).then((kindResult) => {
			if (cancelled) return

			const matched = kindResult.kind === "poi_query" ? matchPOISubject(trimmed, undefined, poiLexicon) : null
			const category = matched ? taxonomyLookup.getPOICategory(matched.match.categoryID) : undefined

			if (!matched || !category) {
				setResult({ kindResult })

				return
			}

			const intent: OverpassIntentLike = {
				subject: { kind: "category", categoryID: matched.match.categoryID, matched: matched.match.matchedPhrase },
				...(matched.remainder ? { anchor: { text: matched.remainder } } : {}),
			}

			let overpassQL: string | undefined
			let overpassError: string | undefined

			try {
				overpassQL = emitOverpassQL(intent, category.osmTag ? { osmTag: category.osmTag } : {})
			} catch (err) {
				overpassError = err instanceof Error ? err.message : String(err)
			}

			setResult({
				kindResult,
				subject: {
					category,
					matchedPhrase: matched.match.matchedPhrase,
					confidence: matched.match.confidence,
					remainder: matched.remainder,
				},
				overpassQL,
				overpassError,
			})
		})

		return () => {
			cancelled = true
		}
	}, [debouncedText])

	const onCopy = useCallback(async () => {
		const overpassQL = result?.overpassQL

		if (!overpassQL) return

		try {
			await navigator.clipboard.writeText(overpassQL)
		} catch {
			const ta = document.createElement("textarea")
			ta.value = overpassQL
			ta.style.position = "fixed"
			ta.style.opacity = "0"
			document.body.appendChild(ta)
			ta.select()

			try {
				document.execCommand("copy")
			} catch {
				/* fall through */
			}
			document.body.removeChild(ta)
		}
		setCopied(true)
		window.setTimeout(() => setCopied(false), 1500)
	}, [result])

	const onSearchLive = useCallback(async () => {
		const subject = result?.subject

		if (!subject || !subject.remainder.trim()) return

		setLiveSearch({ status: "loading" })

		try {
			const { loadPOIWorker, resolveAnchorCenter, searchPOICategory } = await import("../../shared/poi-httpvfs.ts")

			const center = await resolveAnchorCenter(sqljsBaseURL, subject.remainder)

			if (!center) {
				setLiveSearch({ status: "error", message: `couldn't place "${subject.remainder}"` })

				return
			}

			const worker = await loadPOIWorker(sqljsBaseURL)
			const hits = await searchPOICategory(worker, {
				categoryID: subject.category.id,
				center: { lat: center.lat, lon: center.lon },
			})

			setLiveSearch({ status: "success", hits, centerName: center.name })
		} catch {
			// Any failure past anchor resolution (byte-range fetch, worker init, a still-propagating R2
			// upload) reads as the layer being unreachable — never a silent zero-result list.
			setLiveSearch({ status: "error", message: "the published POI layer isn't reachable" })
		}
	}, [result, sqljsBaseURL])

	return (
		<div className={styles.poiExplorer}>
			<div className={styles.form}>
				<label htmlFor="poi-explorer-input">Query</label>
				<input
					id="poi-explorer-input"
					type="text"
					value={text}
					onChange={(e) => setText(e.target.value)}
					placeholder={DEFAULT_TEXT}
				/>
			</div>

			<div className={styles.examples}>
				<span className={styles.examplesLabel}>Try:</span>
				{PRESETS.map((preset) => (
					<button
						key={preset.label}
						type="button"
						className={styles.exampleBtn}
						onClick={() => setText(preset.text)}
						title={preset.text}
					>
						{preset.label}
					</button>
				))}
			</div>

			{result ? (
				<div className={styles.resultPanel}>
					<KindBadge kindResult={result.kindResult} />

					{result.subject ? (
						<>
							<div className={styles.subjectRow}>
								<span className={styles.categoryChip}>{result.subject.category.label}</span>
								{taxonomyLookup.requiresBuildLocalLayer(result.subject.category) ? (
									<span className={styles.buildLocalBadge}>build-local</span>
								) : null}
							</div>

							<dl className={styles.subjectDetail}>
								<dt>matched phrase</dt>
								<dd>
									<code>{result.subject.matchedPhrase}</code>
								</dd>
								<dt>confidence</dt>
								<dd>{Math.round(result.subject.confidence * 100)}%</dd>
								<dt>anchor</dt>
								<dd>{result.subject.remainder ? result.subject.remainder : <em>none — global query</em>}</dd>
							</dl>

							{taxonomyLookup.requiresBuildLocalLayer(result.subject.category) ? (
								<p className={styles.buildLocalNote}>
									Requires the locally-built OSM layer (ODbL) — mailwoman ships the builder, not the data.
								</p>
							) : null}

							{result.overpassQL ? (
								<div className={styles.overpassBlock}>
									<div className={styles.overpassHeader}>
										<h3>OverpassQL export</h3>
										<button type="button" className={styles.debugBtn} onClick={onCopy}>
											{copied ? "✓ Copied" : "Copy"}
										</button>
									</div>
									<pre className={styles.overpassCode}>
										<code>{result.overpassQL}</code>
									</pre>
								</div>
							) : result.overpassError ? (
								<p className={styles.error}>{result.overpassError}</p>
							) : null}

							{taxonomyLookup.requiresBuildLocalLayer(result.subject.category) ? null : (
								<div className={styles.liveSearchBlock}>
									<div className={styles.overpassHeader}>
										<h3>Live results</h3>
										<button
											type="button"
											className={styles.debugBtn}
											onClick={onSearchLive}
											disabled={!result.subject.remainder.trim() || liveSearch.status === "loading"}
											title={
												result.subject.remainder.trim()
													? "Search the published poi.db layer"
													: 'Needs a location anchor (e.g. "near Springfield")'
											}
										>
											{liveSearch.status === "loading" ? "Searching…" : "Search live"}
										</button>
									</div>

									{!result.subject.remainder.trim() ? (
										<p className={styles.noIntent}>Add a location anchor (e.g. "near Springfield") to search live.</p>
									) : liveSearch.status === "error" ? (
										<p className={styles.error}>{liveSearch.message}</p>
									) : liveSearch.status === "success" ? (
										liveSearch.hits.length === 0 ? (
											<p className={styles.noIntent}>
												No {result.subject.category.label.toLowerCase()} results near {liveSearch.centerName}.
											</p>
										) : (
											<>
												<p className={styles.liveSearchCaption}>Near {liveSearch.centerName}, ranked by distance:</p>
												<ul className={styles.liveSearchResults}>
													{liveSearch.hits.map((hit, i) => (
														<li key={`${hit.name}-${i}`}>
															<span className={styles.liveSearchName}>{hit.name}</span>
															<span className={styles.liveSearchMeta}>
																{formatDistance(hit.distanceM)} · {hit.country}
															</span>
														</li>
													))}
												</ul>
											</>
										)
									) : null}
								</div>
							)}
						</>
					) : (
						<p className={styles.noIntent}>
							No POI intent detected — parses as an address (kind <code>{result.kindResult.kind}</code>).
						</p>
					)}
				</div>
			) : null}
		</div>
	)
}

// ---------------------------------------------------------------------------
// Public component (with BrowserOnly SSR boundary)
// ---------------------------------------------------------------------------

export const POIExplorer: React.FC<POIExplorerProps> = ({ defaultText = DEFAULT_TEXT }) => {
	return (
		<BrowserOnly
			fallback={
				<div className={styles.poiExplorer}>
					<p>Loading POI tester…</p>
				</div>
			}
		>
			{() => <POIExplorerInner defaultText={defaultText} />}
		</BrowserOnly>
	)
}
