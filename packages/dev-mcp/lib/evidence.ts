/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What the model was fed, read off a parse trace.
 *
 *   A channel is **absent** (never configured), **silent** (fed all zeros), or **fired** (fed at least one nonzero
 *   feature); absent and silent must not be collapsed, because the repairs differ: wire the mechanism vs. extend its data.
 *
 *   Counting is over `features` rather than `confidence`, because `features` are what the model reads.
 */

import type { NeuralParseTrace, SoftFeatureChannel, TracePriorKind } from "@mailwoman/neural"

/**
 * One channel's reading for one parse.
 */
export type ChannelReading =
	| { state: "absent" }
	| { state: "silent"; of: number }
	| { state: "fired"; tokens_fired: number; of: number }

export interface EvidenceCensus {
	anchor: ChannelReading
	gazetteer: ChannelReading
	country: ChannelReading
	/**
	 * True only when at least one channel was present and every present one was silent;
	 * a session with no channels is not starved.
	 */
	silent: boolean
}

function readChannel(channel: SoftFeatureChannel | undefined): ChannelReading {
	if (!channel) return { state: "absent" }

	const of = channel.features.length
	const fired = channel.features.filter((row) => row.some((value) => value !== 0)).length

	return fired ? { state: "fired", tokens_fired: fired, of } : { state: "silent", of }
}

/**
 * Read the three evidence channels off one parse trace.
 */
export function evidenceCensus(parse: NeuralParseTrace): EvidenceCensus {
	const anchor = readChannel(parse.anchor)
	const gazetteer = readChannel(parse.gazetteer)
	const country = readChannel(parse.country)
	const present = [anchor, gazetteer, country].filter((reading) => reading.state !== "absent")

	return {
		anchor,
		gazetteer,
		country,
		silent: present.length > 0 && present.every((reading) => reading.state === "silent"),
	}
}

/**
 * `applied` is each prior's own report of whether it moved anything, while
 * `emissions_moved` cross-checks the whole emissions matrix, so the two disagreeing
 * means a prior's bookkeeping contradicts what it wrote.
 */
export interface PriorSignals {
	present: TracePriorKind[]
	applied: TracePriorKind[]
	emissions_moved: boolean
}

export function priorSignals(parse: NeuralParseTrace): PriorSignals {
	const present = parse.priors.map((prior) => prior.kind)
	const applied = parse.priors.filter((prior) => prior.applied).map((prior) => prior.kind)

	const emissionsMoved = parse.emissions.some((row, tokenIndex) =>
		row.some((value, labelIndex) => value !== parse.logits[tokenIndex]?.[labelIndex])
	)

	return { present, applied, emissions_moved: emissionsMoved }
}
