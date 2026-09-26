/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The activation-coverage census: is every mechanism in the parse path alive on at least one board row?
 *
 * A pipeline part with no test case that activates it is itself a kind of failure: soft mechanisms are
 * designed to degrade silently and outcome tests cannot see a counterfactual, so the census asks not
 * "did the rows pass" but "did each mechanism signal on any row at all".
 *
 * Levels, per mechanism:
 *
 * - **L0 present** — the mechanism's record appears in the trace (the stage ran / the channel was
 *   configured); near meaningless alone, since a stage can report `applied: true` beside all-zero
 *   channels.
 * - **L1 signaled** — it produced nonzero input to the next stage; this file computes L0 and L1 from one
 *   traced run.
 * - **L2 moved an outcome** — needs ablation pairs and is not computed here; the gauntlet's ablation
 *   layer owns it, and it is reported as explicitly unmeasured so a reader cannot mistake L1 coverage
 *   for outcome relevance.
 *
 * A mechanism at zero L1 across the whole set is reported as inert with the standing rule attached:
 * every zero needs either a row that activates it or an allowlisted reason someone can state
 * ({@link CENSUS_ALLOWLIST}).
 */

import { TRACE_PRIOR_KINDS, type NeuralParseTrace, type TracePriorKind } from "@mailwoman/neural"

import type { EngineRegistryLike } from "#engine/registry"
import { evidenceCensus, priorSignals, type ChannelReading } from "#evidence"
import { resolveInputSet, type InputSetRef } from "#input-sets"
import { describeObservedRate } from "#power"
import { inputSetProvenance, provenanceFor } from "#tool-kit"

/**
 * Mechanisms whose L1 zero is expected, each with the reason a reader can check;
 * the census reports them as `allowlisted` rather than inert, and one that unexpectedly
 * fires is reported loudly because the reason on file is then stale.
 */
export const CENSUS_ALLOWLIST: Partial<Record<string, string>> = {
	placetypeCensus:
		"applied: false by construction — the PCN1 census records parent-candidate observations and composes no bias; " +
		"a true here would mean someone wired a census bias into the decoder (blocked behind a calibration δ the " +
		"artifact deliberately does not carry).",
	streetMorphology:
		"Deliberately zeroed in production (ZEROED_MORPHOLOGY_OPTS, runtime-pipeline.ts): the morphology FST is loaded " +
		"to serve the #1142 street-context check INSIDE the fst prior, and its own emission bias ships at scale 0 — " +
		"unrestricted it measured US-golden −48. A firing here means a non-default morphology config, worth knowing.",
}

/**
 * One row's entry in the census, so a reader can go from an inert mechanism
 * to the rows that should have fired it.
 */
export interface CensusRow {
	id: string
	input: string
	channels: { anchor: ChannelReading; gazetteer: ChannelReading; country: ChannelReading; silent: boolean }
	priors_applied: TracePriorKind[]
	emissions_moved: boolean
	repairs_moved: string[]
	case_normalized: boolean
	decode: "viterbi" | "argmax"
	detected_system: string | null
}

interface ChannelTally {
	absent: number
	silent: number
	fired: number
}

export interface CensusAggregate {
	n: number
	channels: Record<"anchor" | "gazetteer" | "country", ChannelTally>
	/**
	 * Per prior kind: rows where the prior record was present (L0) and rows
	 * where its own `applied` check passed (L1).
	 */
	priors: Record<TracePriorKind, { l0_present: number; l1_applied: number }>
	emissions_moved_rows: number
	repairs: Record<string, number>
	case_normalized_rows: number
	decode: Record<string, number>
	detected_systems: Record<string, number>
	/**
	 * The per-row starvation list: rows where every present channel was silent, complete and never truncated.
	 */
	evidence_silent_rows: string[]
	/**
	 * Mechanisms at zero L1 across every row, minus the allowlist — the finding.
	 */
	inert: Array<{ mechanism: string; l0_present: number; note: string }>
	allowlisted: Array<{ mechanism: string; reason: string; expectation_held: boolean }>
}

/**
 * Aggregate one traced run per row into the census; pure, so the arithmetic is testable without an engine.
 */
export function aggregateCensus(rows: Array<{ id: string; input: string; parse: NeuralParseTrace }>): {
	aggregate: CensusAggregate
	rows: CensusRow[]
} {
	const channelTally = (): ChannelTally => ({ absent: 0, silent: 0, fired: 0 })

	const aggregate: CensusAggregate = {
		n: rows.length,
		channels: { anchor: channelTally(), gazetteer: channelTally(), country: channelTally() },
		priors: Object.fromEntries(TRACE_PRIOR_KINDS.map((kind) => [kind, { l0_present: 0, l1_applied: 0 }])) as Record<
			TracePriorKind,
			{ l0_present: number; l1_applied: number }
		>,
		emissions_moved_rows: 0,
		repairs: {},
		case_normalized_rows: 0,
		decode: {},
		detected_systems: {},
		evidence_silent_rows: [],
		inert: [],
		allowlisted: [],
	}

	const censusRows: CensusRow[] = []

	for (const row of rows) {
		const channels = evidenceCensus(row.parse)
		const priors = priorSignals(row.parse)
		const repairsMoved = row.parse.repairs.map((repair) => repair.pass)

		for (const name of ["anchor", "gazetteer", "country"] as const) {
			aggregate.channels[name][channels[name].state]++
		}

		if (channels.silent) {
			aggregate.evidence_silent_rows.push(row.id)
		}

		for (const kind of priors.present) {
			aggregate.priors[kind].l0_present++
		}

		for (const kind of priors.applied) {
			aggregate.priors[kind].l1_applied++
		}

		if (priors.emissions_moved) {
			aggregate.emissions_moved_rows++
		}

		for (const pass of repairsMoved) {
			aggregate.repairs[pass] = (aggregate.repairs[pass] ?? 0) + 1
		}

		if (row.parse.caseNormalized) {
			aggregate.case_normalized_rows++
		}

		aggregate.decode[row.parse.decode] = (aggregate.decode[row.parse.decode] ?? 0) + 1

		const system = row.parse.detectedSystem ?? "none"

		aggregate.detected_systems[system] = (aggregate.detected_systems[system] ?? 0) + 1

		censusRows.push({
			id: row.id,
			input: row.input,
			channels,
			priors_applied: priors.applied,
			emissions_moved: priors.emissions_moved,
			repairs_moved: repairsMoved,
			case_normalized: row.parse.caseNormalized,
			decode: row.parse.decode,
			detected_system: row.parse.detectedSystem,
		})
	}

	for (const [kind, tally] of Object.entries(aggregate.priors)) {
		const allowReason = CENSUS_ALLOWLIST[kind]

		if (allowReason !== undefined) {
			aggregate.allowlisted.push({ mechanism: kind, reason: allowReason, expectation_held: tally.l1_applied === 0 })

			continue
		}

		if (tally.l1_applied === 0) {
			aggregate.inert.push({
				mechanism: kind,
				l0_present: tally.l0_present,
				note:
					tally.l0_present === 0
						? "Never present in any trace — not configured on this engine, or the stage never ran."
						: `Present on ${tally.l0_present} of ${rows.length} rows and applied on none — ran everywhere, moved nothing.`,
			})
		}
	}

	for (const name of ["anchor", "gazetteer", "country"] as const) {
		const tally = aggregate.channels[name]

		if (tally.fired === 0) {
			aggregate.inert.push({
				mechanism: `channel:${name}`,
				l0_present: tally.silent,
				note:
					tally.silent === 0
						? "Channel absent from every trace — not configured on this engine."
						: `Fed on ${tally.silent} of ${rows.length} rows and fed ZEROS every time — the retrieval side never produced a feature.`,
			})
		}
	}

	return { aggregate, rows: censusRows }
}

/**
 * Run the census: one traced parse per input, aggregated.
 */
export async function runCensus(registry: EngineRegistryLike, args: Record<string, unknown>): Promise<unknown> {
	const set = await resolveInputSet((args["inputs"] as InputSetRef | undefined) ?? { kind: "board" })
	const config = (args["config"] as Record<string, unknown> | undefined) ?? {}
	// Tracing is the census's entire input, so it is forced on regardless of what the caller passed.
	const engine = await registry.acquire({ ...config, trace: true })

	const traced: Array<{ id: string; input: string; parse: NeuralParseTrace }> = []
	const untraced: string[] = []

	for (const item of set.inputs) {
		const run = await engine.session.geocode(item.input)

		if (run.trace?.parse) {
			traced.push({ id: item.id, input: item.input, parse: run.trace.parse })
		} else {
			// A row with no trace contributes no entry to any tally — counting it as "no
			// mechanism fired" would manufacture inertness out of a bundle that cannot trace.
			untraced.push(item.id)
		}
	}

	const { aggregate, rows } = aggregateCensus(traced)

	const silentReading = describeObservedRate({
		events: aggregate.evidence_silent_rows.length,
		n: aggregate.n,
		selection: set.selection,
		eventLabel: "were parsed with every present evidence channel silent",
		...(set.populationN === undefined ? {} : { populationN: set.populationN }),
	})

	const inertSentence = aggregate.inert.length
		? `INERT: ${aggregate.inert.map((entry) => entry.mechanism).join(", ")} produced no L1 signal on any of ` +
			`${aggregate.n} rows. Every zero here needs either a row that activates it or an allowlisted reason someone ` +
			"can state — an inert mechanism is a failure, not a neutral fact (#1719)."
		: `No inert mechanisms: every non-allowlisted mechanism signaled on at least one of ${aggregate.n} rows.`

	const staleAllowlist = aggregate.allowlisted.filter((entry) => !entry.expectation_held)

	return {
		provenance: provenanceFor(engine, set),
		input_set: inputSetProvenance(set),
		summary: [
			inertSentence,
			silentReading.sentence,
			staleAllowlist.length
				? `ALLOWLIST STALE: ${staleAllowlist.map((entry) => entry.mechanism).join(", ")} fired despite a reason ` +
					"on file saying it cannot — the reason is out of date, not the mechanism wrong."
				: "",
			"L2 (moved an outcome) is NOT measured here — that needs ablation pairs (gauntlet ablation layer). " +
				"L1 coverage is necessary for relevance, never sufficient.",
		]
			.filter((sentence) => sentence.length)
			.join(" "),
		n_requested: set.n,
		n_traced: aggregate.n,
		n_untraced: untraced.length,
		untraced_rows: untraced,
		...aggregate,
		evidence_silent: silentReading,
		rows,
	}
}
