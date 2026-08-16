/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What the model was actually fed, read off a parse trace — the per-row half of the inert-mechanism story (#1718).
 *
 *   The distinction this module exists to keep is three-way, not two-way. A channel can be **absent** (never
 *   configured — the trace carries no record of it), **silent** (fed, and fed all zeros — the retrieval side had
 *   nothing to say about any token), or **fired** (fed at least one nonzero feature). Collapsing absent into silent is
 *   the standing meaning-of-zero mistake: one is a fact about the configuration, the other about this input, and the
 *   remedies are different (wire the mechanism vs. extend its data).
 *
 *   The predicate that matters downstream: a parse where every PRESENT channel is silent was decided by the token
 *   embeddings alone. That is often correct behaviour — the Weimar case parsed correctly with all channels silent —
 *   so the flag is a diagnostic fact for accounts and ledgers, never a health verdict on the row.
 *
 *   Counting is over `features`, not `confidence`: the features are what the model reads (the house count-at-the-unit
 *   rule); the confidence column is derived alongside them and can disagree in principle.
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
	 * True when at least one channel was present and every present channel was silent — the model decided from token
	 * embeddings alone. False when any channel fired, and ALSO false when no channel was configured at all: a session
	 * with no channels cannot be starved of them, and reporting it as starved would point the reader at retrieval when
	 * the fact is about configuration.
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
 * Which decode-time priors moved the emissions on this parse.
 *
 * `applied` is each prior record's own contract — "whether this prior moved anything" — so this is an L1 signal per
 * prior, not merely "the stage ran". `emissions_moved` is the cross-check over the whole matrix: true when the decoded
 * emissions differ anywhere from the raw logits, i.e. when SOME prior wrote something. `applied` kinds with
 * `emissions_moved: false` (or vice versa) would mean a prior's own bookkeeping disagrees with the matrix it claims to
 * have written — worth surfacing, never worth papering over.
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
