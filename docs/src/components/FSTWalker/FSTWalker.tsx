/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   FSTWalker — interactive FST gazetteer trie walker that shows how tokens match WOF places. Walks
 *   the FST token-by-token for a given input, displaying matched places with
 *   id/name/placetype/importance at each accepting state, plus valid continuations. Handles FST not
 *   loaded with a graceful fallback. BrowserOnly-safe.
 *
 *   Usage in MDX:
 *
 *   ```mdx
 *   import { DemoEmbedProvider } from "@site/src/contexts/DemoEmbed"
 *   import { FSTWalker } from "@site/src/components/FSTWalker/FSTWalker"
 *
 *   <DemoEmbedProvider sqljsBaseUrl="/mailwoman/sqljs">
 *     <FSTWalker input="New York, NY 10001" />
 *   </DemoEmbedProvider>
 * ```
 */

import BrowserOnly from "@docusaurus/BrowserOnly"
import React, { useMemo } from "react"

import { useDemoEmbed } from "../../contexts/DemoEmbed.tsx"

import styles from "./styles.module.css"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single step in the FST walk — one token consumed, one state transition. */
interface WalkStep {
	/** The normalized token consumed at this step. */
	token: string
	/** The state after consuming this token (null = path broken). */
	result: { stateId: number; accepted: boolean; depth: number } | null
	/** Whether this is the first token in the walk. */
	isFirst: boolean
}

/** A place entry surfaced from an accepting FST state. */
interface PlaceEntryLike {
	wofID: number
	placetype: string
	importance: number
	name?: string
}

/** A continuation — one token that extends from the current state. */
interface ContinuationLike {
	token: string
	targetState: number
	acceptingCount: number
}

export interface FSTWalkerProps {
	/** The raw text to walk through the FST. */
	input: string
}

// ---------------------------------------------------------------------------
// Token normalization (matches FstMatcher.normalizeTokens)
// ---------------------------------------------------------------------------

/**
 * Normalize text into FST tokens: lowercase, NFKC, strip punctuation, split on whitespace. Mirrors
 * `normalizeTokens` in resolver-wof-sqlite/fst-matcher.ts.
 */
function normalizeTokens(text: string): string[] {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\p{P}\p{S}]/gu, "")
		.split(/\s+/)
		.filter((t) => t.length > 0)
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Format a WOF ID as a compact 8-digit string. */
function fmtWofID(id: number): string {
	return String(id).padStart(8, "0").slice(-8)
}

/** Format importance as a 1-3 digit percentage. */
function fmtImportance(imp: number): string {
	return `${(imp * 100).toFixed(0)}%`
}

/** Importance tier for color coding. */
function importanceTier(imp: number): "high" | "mid" | "low" {
	if (imp >= 0.7) return "high"
	if (imp >= 0.3) return "mid"
	return "low"
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const PlaceRow: React.FC<{ place: PlaceEntryLike }> = ({ place }) => {
	const tier = importanceTier(place.importance)
	return (
		<div className={`${styles.placeRow} ${styles[`importance_${tier}`]}`}>
			<span className={styles.placeName} title={place.name ?? `WOF ${place.wofID}`}>
				{place.name ?? `WOF ${place.wofID}`}
			</span>
			<span className={styles.placeType}>{place.placetype}</span>
			<span className={styles.placeImp}>
				<span className={`${styles.impDot} ${styles[`impDot_${tier}`]}`} />
				{fmtImportance(place.importance)}
			</span>
			<code className={styles.placeId}>{fmtWofID(place.wofID)}</code>
		</div>
	)
}

const ContinuationChip: React.FC<{ cont: ContinuationLike }> = ({ cont }) => (
	<span
		className={styles.contChip}
		title={
			cont.acceptingCount > 0
				? `${cont.acceptingCount} place${cont.acceptingCount !== 1 ? "s" : ""} at target state`
				: `State ${cont.targetState} (non-accepting)`
		}
	>
		<span className={styles.contToken}>{cont.token}</span>
		{cont.acceptingCount > 0 ? <span className={styles.contCount}>{cont.acceptingCount}</span> : null}
	</span>
)

// ---------------------------------------------------------------------------
// Inner component (below BrowserOnly boundary)
// ---------------------------------------------------------------------------

const FSTWalkerInner: React.FC<FSTWalkerProps> = ({ input }) => {
	const { fstMatcher, fstProvenance, ready } = useDemoEmbed()

	// Tokenize the input for walking
	const tokens = useMemo(() => normalizeTokens(input), [input])

	// Walk the FST token by token, collecting step results
	const walkSteps = useMemo((): WalkStep[] => {
		if (!fstMatcher || tokens.length === 0) return []

		const steps: WalkStep[] = []

		// First token: walk([token0])
		const firstResult = fstMatcher.walk([tokens[0]!])
		steps.push({ token: tokens[0]!, result: firstResult, isFirst: true })

		// Subsequent tokens: walkFrom(prev, token)
		for (let i = 1; i < tokens.length; i++) {
			const prev = steps[i - 1]!.result
			if (!prev) {
				// Previous token already broke the path — all subsequent steps are null
				steps.push({ token: tokens[i]!, result: null, isFirst: false })
				continue
			}
			const nextResult = fstMatcher.walkFrom(prev, tokens[i]!)
			steps.push({ token: tokens[i]!, result: nextResult, isFirst: false })
		}

		return steps
	}, [fstMatcher, tokens])

	// Places at each accepting step
	const stepPlaces = useMemo((): (PlaceEntryLike[] | null)[] => {
		if (!fstMatcher) return []
		return walkSteps.map((step) => {
			if (!step.result || !step.result.accepted) return null
			return fstMatcher.accepting(step.result.stateId) as PlaceEntryLike[]
		})
	}, [fstMatcher, walkSteps])

	// Continuations from the last valid state
	const continuations = useMemo((): ContinuationLike[] | null => {
		if (!fstMatcher) return null

		// Walk from the last valid step
		let lastValidStep: WalkStep | null = null
		for (let i = walkSteps.length - 1; i >= 0; i--) {
			if (walkSteps[i]!.result) {
				lastValidStep = walkSteps[i]!
				break
			}
		}
		if (!lastValidStep?.result) return null

		// Try to use continuations() if available (runtime duck check — the deserialized
		// matcher is a full FstMatcher instance with this method).
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const matcher = fstMatcher as any
		if (typeof matcher.continuations === "function") {
			return matcher.continuations(lastValidStep.result.stateId) as ContinuationLike[]
		}

		return null
	}, [fstMatcher, walkSteps])

	// -------------------------------------------------------------------
	// Render: FST not loaded
	// -------------------------------------------------------------------

	if (!ready || !fstMatcher) {
		return (
			<div className={styles.fstWalker}>
				<div className={styles.fallback}>
					<span className={styles.fallbackIcon}>📡</span>
					<p>
						FST gazetteer not loaded for the selected version. The walker requires an FST binary ({" "}
						<code>fst-en-US.bin</code>) — try a version with <code>hasFst: true</code> in the releases manifest.
					</p>
				</div>
			</div>
		)
	}

	// -------------------------------------------------------------------
	// Render: no tokens
	// -------------------------------------------------------------------

	if (tokens.length === 0) {
		return (
			<div className={styles.fstWalker}>
				<div className={styles.header}>
					<h4 className={styles.title}>FST Gazetteer Walker</h4>
					{fstProvenance ? (
						<span className={styles.provenance}>
							{fstProvenance.stateCount.toLocaleString()} states · {fstProvenance.placeCount.toLocaleString()} places
						</span>
					) : null}
				</div>
				<p className={styles.emptyHint}>Enter an address to walk the FST trie.</p>
			</div>
		)
	}

	// -------------------------------------------------------------------
	// Render: walk visualization
	// -------------------------------------------------------------------

	return (
		<div className={styles.fstWalker}>
			{/* Header */}
			<div className={styles.header}>
				<h4 className={styles.title}>FST Gazetteer Walker</h4>
				{fstProvenance ? (
					<span className={styles.provenance}>
						{fstProvenance.stateCount.toLocaleString()} states · {fstProvenance.placeCount.toLocaleString()} places
					</span>
				) : null}
			</div>

			{/* Walk trail */}
			<div className={styles.trail}>
				{walkSteps.map((step, i) => {
					const places = stepPlaces[i] ?? null
					const isBroken = step.result === null
					const isAccepting = step.result?.accepted ?? false

					return (
						<div key={i} className={`${styles.step} ${isBroken ? styles.stepBroken : ""}`}>
							{/* Step connector arrow */}
							{i > 0 ? <span className={styles.stepArrow}>→</span> : null}

							{/* Token pill */}
							<span
								className={`${styles.tokenPill} ${
									isBroken ? styles.tokenBroken : isAccepting ? styles.tokenAccepting : styles.tokenWalking
								}`}
							>
								{step.token}
							</span>

							{/* State badge */}
							{step.result ? (
								<span className={styles.stateBadge}>
									S<sub>{step.result.stateId}</sub>
									{isAccepting ? (
										<span className={styles.acceptedMark} title="Accepting state">
											✓
										</span>
									) : null}
								</span>
							) : (
								<span
									className={`${styles.stateBadge} ${styles.stateBadgeBroken}`}
									title="Path broken — token not in FST"
								>
									✗
								</span>
							)}

							{/* Places at accepting state */}
							{places && places.length > 0 ? (
								<div className={styles.placesPanel}>
									<div className={styles.placesHeader}>
										{places.length} place{places.length !== 1 ? "s" : ""} at depth {step.result!.depth}
									</div>
									{places.map((p) => (
										<PlaceRow key={p.wofID} place={p} />
									))}
								</div>
							) : null}
						</div>
					)
				})}
			</div>

			{/* Continuations from final valid state */}
			{continuations && continuations.length > 0 ? (
				<div className={styles.continuationsPanel}>
					<div className={styles.continuationsHeader}>Valid continuations ({continuations.length})</div>
					<div className={styles.continuationsList}>
						{continuations.map((c) => (
							<ContinuationChip key={c.token} cont={c} />
						))}
					</div>
				</div>
			) : null}

			{/* Summary footer */}
			<div className={styles.summary}>
				<span className={styles.summaryItem}>
					<strong>{tokens.length}</strong> token{tokens.length !== 1 ? "s" : ""}
				</span>
				<span className={styles.summarySep}>·</span>
				<span className={styles.summaryItem}>
					<strong>{walkSteps.filter((s) => s.result).length}</strong> matched
				</span>
				<span className={styles.summarySep}>·</span>
				<span className={styles.summaryItem}>
					<strong>{walkSteps.filter((s) => s.result?.accepted).length}</strong> accepting state
					{walkSteps.filter((s) => s.result?.accepted).length !== 1 ? "s" : ""}
				</span>
				{walkSteps.some((s) => s.result === null) ? (
					<>
						<span className={styles.summarySep}>·</span>
						<span className={`${styles.summaryItem} ${styles.negativeEvidence}`}>
							negative evidence at token{" "}
							<strong>&ldquo;{walkSteps.find((s) => s.result === null)!.token}&rdquo;</strong>
						</span>
					</>
				) : null}
			</div>
		</div>
	)
}

// ---------------------------------------------------------------------------
// Public component (with BrowserOnly SSR boundary)
// ---------------------------------------------------------------------------

/**
 * FSTWalker — interactive FST gazetteer trie walker.
 *
 * Walks the FST token-by-token for the given input, showing state transitions, accepting places,
 * and valid continuations. Wraps BrowserOnly for SSR safety.
 *
 * Must be used inside a `<DemoEmbedProvider>`.
 */
export const FSTWalker: React.FC<FSTWalkerProps> = ({ input }) => {
	return (
		<BrowserOnly
			fallback={
				<div className={styles.fstWalker}>
					<p>Loading FST walker…</p>
				</div>
			}
		>
			{() => <FSTWalkerInner input={input} />}
		</BrowserOnly>
	)
}
