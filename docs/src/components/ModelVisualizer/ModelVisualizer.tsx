/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   <ModelVisualizer trace={…}> — renders one `ParseTraceLike` (the serializable record of a trip
 *   through the neural decode path) as four piece-aligned bands + a locale gauge:
 *
 *   1. Token ribbon — the SentencePiece pieces with char offsets.
 *   2. Channel band — anchor/gazetteer confidence as fed ("not fed" when a channel is absent —
 *      an unfed channel is a diagnostic fact, the #566/#685 OOD class, not an empty one).
 *   3. Emissions heatmap — labels × pieces; toggle raw logits vs post-prior emissions (the delta
 *      IS the priors' influence); conventions-masked cells hatched; viterbi path outlined. Label
 *      rows are sliced to the model's emission width (the Stage-prefix rule — a narrower model
 *      never emits the tail labels).
 *   4. Decode band — final tokens, confidence bars, repair-pass diffs as before→after chips.
 *
 *   Pure and fixture-drivable; the live wrapper (LiveModelVisualizer) feeds it from
 *   `useDemoEmbed()`. Spec: docs/superpowers/specs/2026-07-03-parse-trace-model-visualizer-design.md.
 */

import React, { useMemo, useState } from "react"

import type { ParseTraceLike } from "../../shared/resources.tsx"
import { changedIndices, emissionColor, isMasked, matrixAbsMax, pieceDisplay, softmaxRow, stripBIO } from "./helpers.ts"

import styles from "./styles.module.css"

/**
 * Fallback locale-head axis for traces produced before `localeCountries` rode with the logits. Live traces are
 * self-describing — NEVER extend this list; the model's own axis wins. (Mirrors neural/address-system.ts
 * LOCALE_COUNTRIES as of 2026-07; the PLACETYPE_ORDER dual-maintenance class is exactly why the trace now carries the
 * axis itself.)
 */
const LOCALE_ORDER_FALLBACK = ["US", "FR", "DE", "CA", "GB", "JP", "ES", "IT", "NL"] as const

export interface ModelVisualizerProps {
	trace: ParseTraceLike
}

/** Memoized: the live wrapper re-renders on every input keystroke; `trace` is referentially stable between runs. */
export const ModelVisualizer = React.memo(function ModelVisualizer({ trace }: ModelVisualizerProps): React.JSX.Element {
	const [matrixMode, setMatrixMode] = useState<"logits" | "emissions">("emissions")
	const matrix = matrixMode === "logits" ? trace.logits : trace.emissions
	const absMax = useMemo(() => matrixAbsMax(matrix), [matrix])
	const localeProbs = useMemo(() => (trace.localeLogits ? softmaxRow(trace.localeLogits) : null), [trace.localeLogits])
	// Stage-prefix rule: the model may emit fewer logits than the card's label list. Only the
	// emittable prefix gets heatmap rows.
	const emissionWidth = matrix[0]?.length ?? 0
	const rowLabels = trace.labels.slice(0, emissionWidth)

	if (trace.pieces.length === 0) {
		return <div className={styles.empty}>Empty input — nothing to trace.</div>
	}

	return (
		<div className={styles.root}>
			<header className={styles.header}>
				<code className={styles.inputText}>{trace.text}</code>
				<span className={styles.chips}>
					{trace.caseNormalized ? <span className={styles.chip}>case-normalized</span> : null}
					<span className={styles.chip}>
						system: {trace.detectedSystem ?? "none"} ({trace.systemSource})
					</span>
					<span className={styles.chip}>decode: {trace.decode}</span>
				</span>
			</header>

			<section aria-label="Token ribbon">
				<h4 className={styles.bandTitle}>1 · Tokens</h4>
				<div className={styles.ribbon}>
					{trace.pieces.map((p, i) => (
						<span key={i} className={styles.piece} title={`id ${p.id} · chars [${p.start}, ${p.end})`}>
							{pieceDisplay(p.piece)}
						</span>
					))}
				</div>
			</section>

			<section aria-label="Retrieval channels">
				<h4 className={styles.bandTitle}>2 · Retrieval channels</h4>
				<ChannelRow name="anchor" channel={trace.anchor} count={trace.pieces.length} />
				<ChannelRow name="gazetteer" channel={trace.gazetteer} count={trace.pieces.length} />
			</section>

			<section aria-label="Emissions heatmap">
				<h4 className={styles.bandTitle}>
					3 · Emissions
					<button
						type="button"
						className={styles.toggle}
						onClick={() => setMatrixMode((m) => (m === "logits" ? "emissions" : "logits"))}
					>
						{matrixMode === "emissions" ? "post-prior (click for raw)" : "raw logits (click for post-prior)"}
					</button>
				</h4>
				<div className={styles.heatmapScroll}>
					<table className={styles.heatmap}>
						<tbody>
							{rowLabels.map((label, li) => (
								<tr key={label}>
									<th className={styles.labelCell}>{label}</th>
									{trace.pieces.map((_, ti) => {
										const value = matrix[ti]?.[li] ?? 0
										const onPath = trace.path[ti] === li

										return (
											<td
												key={ti}
												className={[
													styles.cell,
													onPath ? styles.pathCell : "",
													isMasked(value) ? styles.maskedCell : "",
												].join(" ")}
												style={isMasked(value) ? undefined : { backgroundColor: emissionColor(value, absMax) }}
												title={`${label} × ${pieceDisplay(trace.pieces[ti]!.piece)}: ${isMasked(value) ? "masked" : value.toFixed(3)}`}
											/>
										)
									})}
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<p className={styles.priorLine}>
					Priors: {trace.priors.map((p) => `${p.kind}${p.applied ? " ✓" : " –"}`).join("  ")}
				</p>
			</section>

			<section aria-label="Decode">
				<h4 className={styles.bandTitle}>4 · Decode</h4>
				<div className={styles.ribbon}>
					{trace.tokens.map((t, i) => (
						<span key={i} className={styles.decoded} data-o={t.label === "O" || undefined} title={t.label}>
							<span className={styles.decodedPiece}>{pieceDisplay(t.piece)}</span>
							<span className={styles.decodedLabel}>{stripBIO(t.label)}</span>
							<span className={styles.confidenceBar} style={{ width: `${(t.confidence * 100).toFixed(0)}%` }} />
						</span>
					))}
				</div>
				{trace.repairs.map((repair) => (
					<p key={repair.pass} className={styles.repairLine}>
						<strong>{repair.pass}</strong>
						{": "}
						{changedIndices(repair.before, repair.after)
							.map(
								(i) =>
									`${pieceDisplay(trace.pieces[i]?.piece ?? `#${i}`)} ${stripBIO(repair.before[i] ?? "?")}→${stripBIO(repair.after[i] ?? "?")}`
							)
							.join(", ")}
					</p>
				))}
			</section>

			{localeProbs ? (
				<section aria-label="Locale head">
					<h4 className={styles.bandTitle}>Locale head</h4>
					<div className={styles.gauge}>
						{(trace.localeCountries ?? LOCALE_ORDER_FALLBACK).map((cc, i) => (
							<div key={cc} className={styles.gaugeCol} title={`${cc}: ${((localeProbs[i] ?? 0) * 100).toFixed(1)}%`}>
								<div className={styles.gaugeBar} style={{ height: `${((localeProbs[i] ?? 0) * 100).toFixed(1)}%` }} />
								<span className={styles.gaugeLabel}>{cc}</span>
							</div>
						))}
					</div>
				</section>
			) : null}
		</div>
	)
})

function ChannelRow({
	name,
	channel,
	count,
}: {
	name: string
	channel: ParseTraceLike["anchor"]
	count: number
}): React.JSX.Element {
	if (!channel) {
		return (
			<div className={styles.channelRow}>
				<span className={styles.channelName}>{name}</span>
				<span className={styles.notFed}>not fed</span>
			</div>
		)
	}

	return (
		<div className={styles.channelRow}>
			<span className={styles.channelName}>{name}</span>
			{Array.from({ length: count }, (_, i) => (
				<span
					key={i}
					className={styles.channelCell}
					style={{ opacity: Math.max(0.06, channel.confidence[i] ?? 0) }}
					title={`confidence ${(channel.confidence[i] ?? 0).toFixed(2)} · features [${(channel.features[i] ?? []).map((v) => v.toFixed(2)).join(", ")}]`}
				/>
			))}
		</div>
	)
}
