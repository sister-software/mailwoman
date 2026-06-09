/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   GuidedTour — interactive failure-mode walkthrough with 9 stops. Each stop has a pre-loaded
 *   example address, live parse button, diagnosis text, pipeline stage indicator, and status badge.
 *   Integrates into PipelineExplorer as a collapsible section and uses DemoEmbed context for live
 *   parses.
 *
 *   Usage in MDX (via PipelineExplorer):
 *
 *   ```mdx
 *   import { DemoEmbedProvider } from "@site/src/contexts/DemoEmbed"
 *   import { PipelineExplorer } from "@site/src/components/PipelineExplorer/PipelineExplorer"
 *
 *   <DemoEmbedProvider sqljsBaseUrl="/mailwoman/sqljs">
 *     <PipelineExplorer />
 *   </DemoEmbedProvider>
 * ```
 *
 *   The GuidedTour is rendered inside PipelineExplorer — no separate provider needed.
 */

import React, { useCallback, useEffect, useRef, useState } from "react"

import { useDemoEmbed } from "../../contexts/DemoEmbed.tsx"
import { flattenTree } from "../../shared/demo-helpers.ts"
import type { DemoResult } from "../../shared/resources.tsx"
import { SpanHighlight } from "../SpanHighlight/SpanHighlight.tsx"

import styles from "./styles.module.css"
import { TOUR_STOPS, type StatusBadge } from "./tour-stops.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusBadgeLabel(badge: StatusBadge): string {
	switch (badge) {
		case "expected":
			return "Expected"
		case "improved":
			return "Improved"
		case "resolved":
			return "Resolved"
		case "known-issue":
			return "Known issue"
	}
}

function statusBadgeClass(badge: StatusBadge): string {
	switch (badge) {
		case "expected":
			return styles.statusExpected
		case "improved":
			return styles.statusImproved
		case "resolved":
			return styles.statusResolved
		case "known-issue":
			return styles.statusKnownIssue
	}
}

function confTier(confidence?: number): "high" | "mid" | "low" {
	if (confidence == null) return "mid"
	return confidence >= 0.8 ? "high" : confidence >= 0.5 ? "mid" : "low"
}

const ConfidenceMini: React.FC<{ confidence?: number }> = ({ confidence }) => {
	if (confidence == null) return <span className={styles.tourConfValue}>—</span>
	const pct = Math.max(0, Math.min(1, confidence)) * 100
	const t = confTier(confidence)
	const cls = t === "high" ? styles.tourConfHigh : t === "low" ? styles.tourConfLow : styles.tourConfMid
	return (
		<div className={styles.tourConfCell}>
			<div className={`${styles.tourConfBar} ${cls}`} style={{ width: `${pct}%` }} />
			<span className={styles.tourConfValue}>{confidence.toFixed(2)}</span>
		</div>
	)
}

// ---------------------------------------------------------------------------
// State per stop
// ---------------------------------------------------------------------------

interface StopParseState {
	address: string
	result: DemoResult | null
	busy: boolean
	error: string | null
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const GuidedTour: React.FC = () => {
	const { classifier, ready, loadingProgress } = useDemoEmbed()

	const [expanded, setExpanded] = useState(false)
	const [currentIndex, setCurrentIndex] = useState(0)
	const [visited, setVisited] = useState<Set<number>>(new Set([0]))

	// Per-stop parse state. We store results per stop so navigating back shows the cached result.
	const [stopStates, setStopStates] = useState<Map<number, StopParseState>>(() => {
		const m = new Map<number, StopParseState>()
		for (const stop of TOUR_STOPS) {
			m.set(stop.id, { address: stop.address, result: null, busy: false, error: null })
		}
		return m
	})

	const currentStop = TOUR_STOPS[currentIndex]
	const currentState = stopStates.get(currentStop.id)!

	// Track whether we've auto-parsed the first stop.
	const autoParsedRef = useRef(false)

	// ---- Parse ----

	const parse = useCallback(
		async (stopId: number) => {
			if (!classifier) return

			const state = stopStates.get(stopId)
			if (!state) return

			setStopStates((prev) => {
				const next = new Map(prev)
				const existing = next.get(stopId)
				if (!existing) return prev
				next.set(stopId, { ...existing, busy: true, error: null, result: null })
				return next
			})

			try {
				const [{ computeQueryShape }, { classifyKindSync }, { runPipeline }, { groupPhrases }] = await Promise.all([
					import("@mailwoman/query-shape"),
					import("@mailwoman/kind-classifier"),
					import("@mailwoman/core/pipeline"),
					import("@mailwoman/phrase-grouper"),
				])

				const tStart = performance.now()
				const queryShape = computeQueryShape(state.address)
				const kindResult = classifyKindSync({ raw: state.address, normalized: state.address }, queryShape)
				const tShape = performance.now()

				const pipelineResult = await runPipeline(state.address, {
					computeQueryShape,
					groupPhrases,
					classifier: classifier as unknown as Parameters<typeof runPipeline>[1]["classifier"],
				})
				const tClassify = performance.now()

				const tree = pipelineResult.tree
				const nodes = flattenTree(tree)

				const result: DemoResult = {
					input: state.address,
					tree,
					nodes,
					resolved: null,
					candidates: [],
					kindResult,
					fstActive: false,
					timing: { shape: tShape - tStart, classify: tClassify - tShape },
				}

				setStopStates((prev) => {
					const next = new Map(prev)
					next.set(stopId, { ...next.get(stopId)!, result, busy: false, error: null })
					return next
				})
			} catch (err) {
				console.error("Tour parse error", err)
				const message = err instanceof Error ? err.message : String(err)
				setStopStates((prev) => {
					const next = new Map(prev)
					next.set(stopId, { ...next.get(stopId)!, result: null, busy: false, error: message })
					return next
				})
			}
		},
		[classifier, stopStates]
	)

	// ---- Auto-parse first stop ----

	useEffect(() => {
		if (!ready || autoParsedRef.current) return
		autoParsedRef.current = true
		const firstId = TOUR_STOPS[0].id
		void parse(firstId)
	}, [ready, parse])

	// When the tour is first expanded, trigger a re-check (in case ready became true between mount and expand).
	useEffect(() => {
		if (!expanded || !ready || autoParsedRef.current) return
		autoParsedRef.current = true
		const firstId = TOUR_STOPS[0].id
		if (!stopStates.get(firstId)?.result && !stopStates.get(firstId)?.busy) {
			void parse(firstId)
		}
	}, [expanded, ready, parse, stopStates])

	// ---- Navigation ----

	const goTo = useCallback((index: number) => {
		const clamped = Math.max(0, Math.min(index, TOUR_STOPS.length - 1))
		setCurrentIndex(clamped)
		setVisited((prev) => new Set(prev).add(clamped))
	}, [])

	const prev = useCallback(() => goTo(currentIndex - 1), [currentIndex, goTo])
	const next = useCallback(() => goTo(currentIndex + 1), [currentIndex, goTo])

	// ---- Handle input changes ----

	const onInputChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const value = e.target.value
			setStopStates((prev) => {
				const next = new Map(prev)
				const existing = next.get(currentStop.id)!
				next.set(currentStop.id, { ...existing, address: value, result: null, error: null })
				return next
			})
		},
		[currentStop.id]
	)

	const onSubmit = useCallback(
		(e: React.FormEvent) => {
			e.preventDefault()
			void parse(currentStop.id)
		},
		[currentStop.id, parse]
	)

	// ---- Render ----

	const isLoading = !ready && loadingProgress

	return (
		<div className={styles.guidedTour}>
			<div
				className={styles.tourToggle}
				onClick={() => setExpanded((v) => !v)}
				role="button"
				tabIndex={0}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault()
						setExpanded((v) => !v)
					}
				}}
			>
				<span className={styles.tourToggleIcon}>{expanded ? "▼" : "▶"}</span>
				<span>Guided tour: 9 failure-mode walkthroughs</span>
			</div>

			{expanded ? (
				<div className={styles.tourBody}>
					{isLoading ? (
						<p className={styles.tourParsePrompt}>{loadingProgress}</p>
					) : (
						<>
							{/* ---- Progress dots ---- */}
							<div className={styles.progress}>
								{TOUR_STOPS.map((stop, i) => (
									<button
										key={stop.id}
										className={`${styles.dot} ${i === currentIndex ? styles.dotActive : ""} ${
											visited.has(i) && i !== currentIndex ? styles.dotVisited : ""
										}`}
										onClick={() => goTo(i)}
										aria-label={`Stop ${stop.id}: ${stop.title}`}
										title={stop.title}
									/>
								))}
							</div>

							{/* ---- Navigation ---- */}
							<div className={styles.nav}>
								<button type="button" className={styles.navBtn} disabled={currentIndex === 0} onClick={prev}>
									← Previous
								</button>
								<span className={styles.stopCounter}>
									{currentIndex + 1} / {TOUR_STOPS.length}
								</span>
								<button
									type="button"
									className={styles.navBtn}
									disabled={currentIndex >= TOUR_STOPS.length - 1}
									onClick={next}
								>
									Next →
								</button>
							</div>

							{/* ---- Stop card ---- */}
							<div className={styles.stopCard}>
								<div className={styles.stopHeader}>
									<h3 className={styles.stopTitle}>
										{currentStop.id}. {currentStop.title}
									</h3>
									<div className={styles.badges}>
										<span className={`${styles.badge} ${styles.stageBadge}`}>{currentStop.pipelineStageLabel}</span>
										<span className={`${styles.badge} ${statusBadgeClass(currentStop.statusBadge)}`}>
											{statusBadgeLabel(currentStop.statusBadge)}
										</span>
									</div>
								</div>

								<p className={styles.stopDescription}>{currentStop.description}</p>
								<div className={styles.sourceCite}>Source: {currentStop.sourceDoc}</div>

								{/* ---- Address input + Parse button ---- */}
								<form onSubmit={onSubmit} className={styles.parseForm}>
									<input
										type="text"
										className={styles.parseInput}
										value={currentState.address}
										onChange={onInputChange}
										disabled={!ready || currentState.busy}
									/>
									<button
										type="submit"
										className={styles.parseBtn}
										disabled={!ready || currentState.busy || !currentState.address.trim()}
									>
										{currentState.busy ? "Parsing…" : "Parse"}
									</button>
								</form>

								{/* ---- Parse result ---- */}
								{currentState.result ? (
									<div className={styles.tourResult}>
										<div className={styles.tourSpanWrap}>
											<SpanHighlight input={currentState.result.input} nodes={currentState.result.nodes} />
										</div>
										<table className={styles.tourComponentTable}>
											<thead>
												<tr>
													<th>tag</th>
													<th>value</th>
													<th>conf</th>
												</tr>
											</thead>
											<tbody>
												{currentState.result.nodes.map((n, i) => (
													<tr key={i}>
														<td>{n.tag}</td>
														<td>{String(n.value ?? "")}</td>
														<td>
															<ConfidenceMini confidence={n.confidence} />
														</td>
													</tr>
												))}
											</tbody>
										</table>
										{currentState.result.timing ? (
											<p className={styles.sourceCite}>
												Timing: {(currentState.result.timing.classify ?? 0).toFixed(1)} ms classify
											</p>
										) : null}
									</div>
								) : currentState.error ? (
									<div className={styles.tourError}>{currentState.error}</div>
								) : currentState.busy ? null : (
									<p className={styles.tourParsePrompt}>
										{currentIndex === 0 && !ready
											? "Waiting for model to load…"
											: 'Click "Parse" to run the pipeline on this address.'}
									</p>
								)}

								{/* ---- Diagnosis panel ---- */}
								<div className={styles.diagnosis}>
									<div className={styles.diagnosisLabel}>Diagnosis</div>
									{currentStop.diagnosis}
								</div>
							</div>
						</>
					)}
				</div>
			) : null}
		</div>
	)
}
