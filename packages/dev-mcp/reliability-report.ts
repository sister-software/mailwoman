/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mwdev_reliability`'s measurement: pick a surface, collect graded confidences, curve them, and say what a gate on
 *   them would buy.
 *
 *   The report deliberately answers TWO questions that get conflated. "Is the number honest?" is the curve — ECE, MCE,
 *   the per-bin gap. "Is it worth gating on?" is the threshold table, and a well-calibrated surface can still fail it,
 *   because the admitted-error count at every useful recall can be too high for the downstream cost. A tool that
 *   returned only ECE would let a caller conclude the second from the first.
 */

import { resolvePath } from "path-ts"

import type { EngineConfig, EngineRegistryLike } from "./engine-registry.ts"
import { resolveInputSet, type InputSetRef } from "./input-sets.ts"
import { describeObservedRate, type Selection } from "./power.ts"
import {
	coarsePlacerReliabilitySample,
	ComponentAggregate,
	decodeReliabilitySample,
	UnassertedPolicy,
	type SurfaceSample,
} from "./reliability-surfaces.ts"
import { curveByStratum, errorClasses, reliabilityCurve, thresholdTable } from "./reliability.ts"
import { provenanceFor } from "./tool-kit.ts"

/**
 * The confidence surfaces this tool can grade. Each is a distinct head over distinct features — they share a
 * reliability diagram and nothing else — so adding one means adding a sample function, not widening an existing one.
 */
export const ReliabilitySurface = {
	Decode: "decode",
	CoarsePlacer: "coarse_placer",
} as const

export type ReliabilitySurface = (typeof ReliabilitySurface)[keyof typeof ReliabilitySurface]

/**
 * Where the coarse placer's held-out split lives, relative to the repo root.
 *
 * NOT tracked in git — the surface reports its absence rather than substituting another split, because `val` and
 * `train` load identically and produce a curve that is the temperature fit reporting on itself.
 */
const PLACER_TEST_SPLIT = ["data", "coarse-placer", "test.jsonl"] as const

/**
 * The gate positions the placer work actually argued over, so a reader comparing against that record does not have to
 * re-derive the rows. A caller may pass their own; these are a starting table, not a claim about where the gate
 * belongs.
 */
const DEFAULT_THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.99] as const

const DEFAULT_BIN_COUNT = 10

/**
 * Which strata each surface can split by. Fixed per surface rather than free-form: a caller asking to stratify a decode
 * curve by `expected` would get one group called `(unset)` and read it as a finding.
 */
const STRATA_FOR: Record<ReliabilitySurface, readonly string[]> = {
	[ReliabilitySurface.Decode]: ["tag", "country", "address_kind"],
	[ReliabilitySurface.CoarsePlacer]: ["expected"],
}

/**
 * One surface's collected sample plus the facts a confidence-bound sentence needs to describe it honestly.
 */
interface SurfaceRun {
	sample: SurfaceSample
	provenance: unknown
	nRequested: number
	selection: Selection
	eventLabel: string
}

export async function runReliability(registry: EngineRegistryLike, args: Record<string, unknown>): Promise<unknown> {
	const surface = (args["surface"] as ReliabilitySurface | undefined) ?? ReliabilitySurface.Decode
	const binCount = (args["bins"] as number | undefined) ?? DEFAULT_BIN_COUNT
	const thresholds = (args["thresholds"] as number[] | undefined) ?? [...DEFAULT_THRESHOLDS]
	const requestedStrata = (args["stratify"] as string[] | undefined) ?? STRATA_FOR[surface]

	const { sample, provenance, nRequested, selection, eventLabel } =
		surface === ReliabilitySurface.CoarsePlacer ? await placerRun(registry, args) : await decodeRun(registry, args)

	const overall = reliabilityCurve(sample.observations, binCount)
	const gate = thresholdTable(sample.observations, thresholds)

	// Read at the lowest threshold that admits anything, so the classes describe a gate someone could actually set. A
	// threshold admitting nothing has no admitted errors to rank, which reads as a clean confusion matrix.
	const gateForClasses = gate.find((row) => row.admitted > 0)?.threshold ?? thresholds[0] ?? 0

	const reading = describeObservedRate({
		events: sample.observations.filter((observation) => !observation.correct).length,
		n: sample.observations.length,
		selection,
		eventLabel,
	})

	return {
		surface,
		provenance,
		n_requested: nRequested,
		n_evaluated: sample.observations.length,
		n_errored: 0,
		n_excluded: sample.excluded.reduce((total, entry) => total + entry.n, 0),
		excluded: sample.excluded,
		unasserted: sample.unasserted,
		overall,
		by_stratum: Object.fromEntries(
			requestedStrata
				.filter((key) => STRATA_FOR[surface].includes(key))
				.map((key) => [key, curveByStratum(sample.observations, key, binCount)])
		),
		thresholds: gate,
		error_classes_at: gateForClasses,
		error_classes: errorClasses(sample.observations, gateForClasses, 12),
		notes: sample.notes,
		summary: summarize(surface, overall, gate, sample, reading.sentence),
	}
}

async function decodeRun(registry: EngineRegistryLike, args: Record<string, unknown>): Promise<SurfaceRun> {
	const set = await resolveInputSet((args["inputs"] as InputSetRef | undefined) ?? { kind: "board" })
	const config = (args["config"] as EngineConfig | undefined) ?? {}
	// The per-token softmax IS the measurement, so tracing is forced on regardless of what the caller passed.
	const engine = await registry.acquire({ ...config, trace: true })
	const limit = args["limit"] as number | undefined
	const selected = limit ? set.inputs.slice(0, limit) : set.inputs

	const sample = await decodeReliabilitySample(
		engine,
		selected,
		(args["aggregate"] as ComponentAggregate | undefined) ?? ComponentAggregate.Min,
		(args["unasserted"] as UnassertedPolicy | undefined) ?? UnassertedPolicy.Exclude
	)

	return {
		sample,
		provenance: provenanceFor(engine, set),
		nRequested: selected.length,
		// A `limit` makes a full board a slice, and reporting the set's own selection would let a 20-row probe carry a
		// full board's confidence wording.
		selection: limit && limit < set.inputs.length ? "slice" : set.selection,
		eventLabel: "incorrect component",
	}
}

async function placerRun(registry: EngineRegistryLike, args: Record<string, unknown>): Promise<SurfaceRun> {
	const corpus = (args["corpus"] as string | undefined) ?? resolvePath(registry.repoRoot, ...PLACER_TEST_SPLIT)
	const sample = await coarsePlacerReliabilitySample(corpus)

	return {
		sample,
		// No engine and no input set: the placer is loaded from its own bundle and graded against a corpus on disk, so
		// the standard provenance block would be a shape with every field empty. The two facts that DO identify this
		// measurement are the corpus and the tree.
		provenance: {
			corpus,
			tree_fingerprint: registry.fingerprint().digest,
			note: "coarse-placer surface: no geocode engine is involved, so no engine_id or input_set applies",
		},
		nRequested: sample.observations.length + sample.excluded.reduce((total, entry) => total + entry.n, 0),
		// The whole held-out split is the population this surface has, so it is `full` — not a claim that it represents
		// every address, which the split's own construction already bounds.
		selection: "full",
		eventLabel: "misplaced country",
	}
}

function summarize(
	surface: ReliabilitySurface,
	overall: ReturnType<typeof reliabilityCurve>,
	gate: ReturnType<typeof thresholdTable>,
	sample: SurfaceSample,
	powerSentence: string
): string {
	if (overall.ece === null) {
		return `No gradeable observations on the ${surface} surface, so nothing was measured. ${powerSentence}`
	}

	// The most useful single row: the highest threshold that still admits a majority of what it could. Named rather
	// than left to the reader, because a table's rows are all equally prominent and its point is not.
	const workable = gate.toReversed().find((row) => row.admitted_share >= 0.5)

	const gateSentence = workable
		? `A gate at ${workable.threshold} admits ${(workable.admitted_share * 100).toFixed(1)}% of observations at ` +
			`precision ${workable.precision_above?.toFixed(3) ?? "n/a"}, letting ${workable.errors_admitted} errors ` +
			`through and turning away ${workable.correct_below} correct ones.`
		: "No threshold in the table admits half the observations, so the gate table describes only the tail."

	const excludedTotal = sample.excluded.reduce((total, entry) => total + entry.n, 0)
	const excludedSentence = excludedTotal ? ` ${excludedTotal} rows were excluded and are itemized.` : ""

	// Named in the sentence, not just in a field: the curve covers only the components truth asserted, and a reader
	// who does not know how much output sat outside it will read the ECE as covering the parse.
	const unassertedSentence = sample.unasserted?.n
		? ` A further ${sample.unasserted.n} produced components were not asserted by any truth row (mean confidence ` +
			`${sample.unasserted.mean_confidence?.toFixed(3)}) and are counted, not curved.`
		: ""

	return (
		`${surface}: ${overall.n} graded observations, accuracy ${overall.accuracy?.toFixed(3)}, ` +
		`ECE ${overall.ece.toFixed(3)} / MCE ${overall.mce?.toFixed(3)}. ${gateSentence}${excludedSentence}` +
		`${unassertedSentence} ` +
		`${powerSentence}`
	)
}
