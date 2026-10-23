/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The workbench's right column: the trace's metadata and the four readings, each computed from fields the
 *   trace already holds so a reader can check every number against the bands.
 *
 *   - Predictability: each token's label confidence and, when the bundle records them, the decoder's margin.
 *   - Confoundance: the best other label per token and the chosen label's lead over it.
 *   - Congruence: tokens where a retrieval channel fired and the label disagrees with the channel's kind.
 *   - Plausibility: whether the conventions mask applied and which repair passes changed which pieces.
 */

import { tagOf } from "@mailwoman/neural/span"
import { softmax } from "@mailwoman/neural/viterbi"
import type { ParseTraceLike } from "mailwoman/browser-runtime/types"
import React, { useMemo } from "react"

import { changedIndices, isMasked, labelFamily, pieceDisplay, runnerUp } from "./helpers.ts"

import styles from "./styles.module.css"

export interface ReadingsPanelProps {
	trace: ParseTraceLike
}

/**
 * The count of near misses and low margins each list shows.
 */
const LIST_LENGTH = 5

/**
 * The label families a channel's hit speaks for.
 * A channel firing under another family is a disagreement.
 *
 * The gazetteer channel is absent here: its features are slot bits, and the trace records them
 * without their slot labels, so its hits are listed with their labels for the reader to judge.
 */
const CHANNEL_FAMILIES: Record<string, readonly string[]> = {
	anchor: ["postcode"],
	country: ["country"],
	streetType: ["street", "street_prefix", "street_suffix", "intersection_a", "intersection_b"],
	localitySurface: ["locality", "dependent_locality"],
}

/**
 * The index of the `country_ambiguous` flag in the country channel's per-piece feature.
 *
 * A hit flagged ambiguous, such as a surname that is also a country, is no disagreement under another label.
 */
const COUNTRY_AMBIGUOUS_FEATURE = 1

const labelText = (label: string): string => tagOf(label) || label

interface Disagreement {
	channel: string
	piece: number
	label: string
	confidence: number
}

function channelDisagreements(trace: ParseTraceLike): Disagreement[] {
	const out: Disagreement[] = []

	const channels: Array<[string, ParseTraceLike["anchor"] | undefined]> = [
		["anchor", trace.anchor],
		["country", trace.country],
		["streetType", trace.streetType],
		["localitySurface", trace.localitySurface],
	]

	for (const [name, channel] of channels) {
		if (!channel) continue

		const families = CHANNEL_FAMILIES[name] ?? []

		channel.confidence.forEach((confidence, piece) => {
			if (confidence <= 0) return

			if (name === "country" && channel.features[piece]?.[COUNTRY_AMBIGUOUS_FEATURE] === 1) return

			const label = trace.labels[trace.path[piece] ?? -1]

			if (!label || families.includes(labelFamily(label))) return

			out.push({ channel: name, piece, label, confidence })
		})
	}

	return out
}

/**
 * The pieces the gazetteer channel fired on, each with the label the decoder chose.
 */
function gazetteerHits(trace: ParseTraceLike): Array<{ piece: number; label: string }> {
	if (!trace.gazetteer) return []

	return trace.gazetteer.confidence.flatMap((confidence, piece) =>
		confidence > 0 ? [{ piece, label: trace.labels[trace.path[piece] ?? -1] ?? "?" }] : []
	)
}

/**
 * The right column of the workbench.
 */
export function ReadingsPanel({ trace }: ReadingsPanelProps): React.JSX.Element {
	const localeGuess = useMemo(() => {
		if (!trace.localeLogits?.length || !trace.localeCountries) return null

		const probabilities = softmax(trace.localeLogits)
		let best = 0

		probabilities.forEach((p, i) => {
			if (p > (probabilities[best] ?? 0)) {
				best = i
			}
		})

		return { country: trace.localeCountries[best] ?? "?", probability: probabilities[best] ?? 0 }
	}, [trace.localeLogits, trace.localeCountries])

	const confidences = useMemo(
		() =>
			trace.emissions.map((row, piece) => {
				const chosen = trace.path[piece] ?? 0
				const unmasked = row.map((value) => (isMasked(value) ? -1e9 : value))

				return softmax(unmasked)[chosen] ?? 0
			}),
		[trace.emissions, trace.path]
	)

	const lowestMargins = useMemo(() => {
		const margins = trace.margins

		if (!margins) return null

		return margins
			.map((margin, piece) => ({ piece, margin }))
			.toSorted((a, b) => a.margin - b.margin)
			.slice(0, LIST_LENGTH)
	}, [trace.margins])

	const nearMisses = useMemo(
		() =>
			trace.emissions
				.map((row, piece) => ({ piece, other: runnerUp(row, trace.labels, trace.path[piece] ?? 0) }))
				.filter((entry): entry is { piece: number; other: NonNullable<typeof entry.other> } => entry.other !== null)
				.toSorted((a, b) => a.other.gap - b.other.gap)
				.slice(0, LIST_LENGTH),
		[trace.emissions, trace.labels, trace.path]
	)

	const disagreements = useMemo(() => channelDisagreements(trace), [trace])
	const hits = useMemo(() => gazetteerHits(trace), [trace])
	const mask = trace.priors.find((prior) => prior.kind === "conventionsMask")
	const pieceText = (piece: number): string => pieceDisplay(trace.pieces[piece]?.piece ?? `#${piece}`)
	const pieceLabel = (piece: number): string => labelText(trace.labels[trace.path[piece] ?? -1] ?? "?")

	return (
		<div className={styles.readings}>
			<section>
				<h4 className={styles.bandTitle}>Metadata</h4>
				<dl className={styles.metadata}>
					<dt>Address system</dt>
					<dd>
						{trace.detectedSystem ?? "none"} ({trace.systemSource})
					</dd>
					<dt>Country guess</dt>
					<dd>
						{localeGuess ? `${localeGuess.country} ${(localeGuess.probability * 100).toFixed(0)}%` : "no locale head"}
					</dd>
					<dt>Decode</dt>
					<dd>{trace.decode}</dd>
					<dt>Priors applied</dt>
					<dd>
						{trace.priors
							.filter((prior) => prior.applied)
							.map((prior) => prior.kind)
							.join(", ") || "none"}
					</dd>
				</dl>
			</section>

			<section>
				<h4 className={styles.bandTitle}>Predictability</h4>
				<p className={styles.readingHint}>
					Label confidence per piece, and the decoder's lead over the best other label where the bundle records it.
				</p>
				<ol className={styles.readingList}>
					{(lowestMargins ?? confidences.map((confidence, piece) => ({ piece, margin: confidence })))
						.toSorted((a, b) => a.margin - b.margin)
						.slice(0, LIST_LENGTH)
						.map(({ piece, margin }) => (
							<li key={piece}>
								<code>{pieceText(piece)}</code> {pieceLabel(piece)} · {((confidences[piece] ?? 0) * 100).toFixed(0)}%
								{trace.margins ? ` · margin ${margin.toFixed(2)}` : ""}
							</li>
						))}
				</ol>
			</section>

			<section>
				<h4 className={styles.bandTitle}>Confoundance</h4>
				<p className={styles.readingHint}>
					The closest calls: the best other label per piece and how far behind it sat.
				</p>
				<ol className={styles.readingList}>
					{nearMisses.map(({ piece, other }) => (
						<li key={piece}>
							<code>{pieceText(piece)}</code> {pieceLabel(piece)} over {labelText(other.label)} by{" "}
							{other.gap.toFixed(2)}
						</li>
					))}
				</ol>
			</section>

			<section>
				<h4 className={styles.bandTitle}>Congruence</h4>
				<p className={styles.readingHint}>Pieces where a retrieval channel fired and the label took another family.</p>
				{disagreements.length ? (
					<ul className={styles.readingList}>
						{disagreements.map((entry) => (
							<li key={`${entry.channel}-${entry.piece}`}>
								<code>{pieceText(entry.piece)}</code> {entry.channel} fired at {(entry.confidence * 100).toFixed(0)}%,
								label {labelText(entry.label)}
							</li>
						))}
					</ul>
				) : (
					<p className={styles.readingHint}>Every typed channel hit agrees with its label.</p>
				)}
				{hits.length ? (
					<p className={styles.readingHint}>
						Gazetteer hits: {hits.map((hit) => `${pieceText(hit.piece)} ${labelText(hit.label)}`).join(", ")}
					</p>
				) : null}
			</section>

			<section>
				<h4 className={styles.bandTitle}>Plausibility</h4>
				<p className={styles.readingHint}>
					Conventions mask {mask ? (mask.applied ? "applied" : "present, inert") : "absent"} for{" "}
					{trace.detectedSystem ?? "no detected system"}.
				</p>
				{trace.repairs.length ? (
					<ul className={styles.readingList}>
						{trace.repairs.map((repair) => (
							<li key={repair.pass}>
								<strong>{repair.pass}</strong>
								{": "}
								{changedIndices(repair.before, repair.after)
									.map(
										(piece) =>
											`${pieceText(piece)} ${labelText(repair.before[piece] ?? "?")}→${labelText(repair.after[piece] ?? "?")}`
									)
									.join(", ") || "changed no piece"}
							</li>
						))}
					</ul>
				) : (
					<p className={styles.readingHint}>The decoded path needed no repair.</p>
				)}
			</section>
		</div>
	)
}
