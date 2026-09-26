/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `mwdev_reliability`'s measurement: collect graded confidences for one surface, curve them, and state what an eval
 * on them would buy, because a well-calibrated surface can still have no threshold worth setting.
 */

import { resolvePath } from "path-ts"

import type { EngineConfig, EngineRegistryLike } from "#engine/registry"
import { resolveInputSet, type InputSetRef } from "#input-sets"
import { describeObservedRate, type Selection } from "#power"
import { curveByStratum, errorClasses, reliabilityCurve, thresholdTable } from "#reliability/index"
import {
	coarsePlacerReliabilitySample,
	ComponentAggregate,
	decodeReliabilitySample,
	UnassertedPolicy,
	type SurfaceSample,
} from "#reliability/surfaces"
import { provenanceFor } from "#tool-kit"

/**
 * The confidence surfaces this tool can grade; each is a distinct head over distinct features,
 * so adding one means adding a sample function rather than widening an existing one.
 */
export const ReliabilitySurface = {
	Decode: "decode",
	CoarsePlacer: "coarse_placer",
} as const

/**
 * The identifier of one gradeable confidence surface.
 */
export type ReliabilitySurface = (typeof ReliabilitySurface)[keyof typeof ReliabilitySurface]

/**
 * Where the coarse placer's held-out split lives, relative to the repo root;
 * it is not tracked in git, and the surface reports its absence rather than substituting
 * a split that would be the temperature fit reporting on itself.
 */
const PLACER_TEST_SPLIT = ["data", "coarse-placer", "test.jsonl"] as const

/**
 * A starting table of eval positions, not a claim about where the eval belongs.
 */
const DEFAULT_THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.99] as const

const DEFAULT_BIN_COUNT = 10

/**
 * Which strata each surface can split by, fixed per surface because a caller stratifying
 * a decode curve by `expected` would get one `(unset)` group and read it as a finding.
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

/**
 * Grade one confidence surface and return its curve, threshold table and error classes.
 */
export async function runReliability(registry: EngineRegistryLike, args: Record<string, unknown>): Promise<unknown> {
	const surface = (args["surface"] as ReliabilitySurface | undefined) ?? ReliabilitySurface.Decode
	const binCount = (args["bins"] as number | undefined) ?? DEFAULT_BIN_COUNT
	const thresholds = (args["thresholds"] as number[] | undefined) ?? [...DEFAULT_THRESHOLDS]
	const requestedStrata = (args["stratify"] as string[] | undefined) ?? STRATA_FOR[surface]

	const { sample, provenance, nRequested, selection, eventLabel } =
		surface === ReliabilitySurface.CoarsePlacer ? await placerRun(registry, args) : await decodeRun(registry, args)

	const overall = reliabilityCurve(sample.observations, binCount)
	const check = thresholdTable(sample.observations, thresholds)

	// Read at the lowest threshold that admits anything, so the classes describe an eval
	// someone could actually set rather than an empty confusion matrix.
	const thresholdForClasses = check.find((row) => row.admitted > 0)?.threshold ?? thresholds[0] ?? 0

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
		thresholds: check,
		error_classes_at: thresholdForClasses,
		error_classes: errorClasses(sample.observations, thresholdForClasses, 12),
		notes: sample.notes,
		summary: summarize(surface, overall, check, sample, reading.sentence),
	}
}

async function decodeRun(registry: EngineRegistryLike, args: Record<string, unknown>): Promise<SurfaceRun> {
	const set = await resolveInputSet((args["inputs"] as InputSetRef | undefined) ?? { kind: "board" })
	const config = (args["config"] as EngineConfig | undefined) ?? {}
	// The per-token softmax is the measurement, so tracing is forced on regardless of what the caller passed.
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
		// A `limit` makes a full board a subset, and reporting the set's own selection
		// would let a 20-row probe carry a full board's confidence wording.
		selection: limit && limit < set.inputs.length ? "subset" : set.selection,
		eventLabel: "incorrect component",
	}
}

async function placerRun(registry: EngineRegistryLike, args: Record<string, unknown>): Promise<SurfaceRun> {
	const corpus = (args["corpus"] as string | undefined) ?? resolvePath(registry.repoRoot, ...PLACER_TEST_SPLIT)
	const sample = await coarsePlacerReliabilitySample(corpus)

	return {
		sample,
		// No engine and no input set: the placer is loaded from its own bundle
		// and graded against a corpus on disk, so the standard provenance block would be a
		// shape with every field empty; the corpus and the tree identify it.
		provenance: {
			corpus,
			tree_fingerprint: (await registry.fingerprint()).digest,
			note: "coarse-placer surface: no geocode engine is involved, so no engine_id or input_set applies",
		},
		nRequested: sample.observations.length + sample.excluded.reduce((total, entry) => total + entry.n, 0),
		// The whole held-out split is the population this surface has, so it is `full` —
		// not a claim that it represents every address.
		selection: "full",
		eventLabel: "misplaced country",
	}
}

function summarize(
	surface: ReliabilitySurface,
	overall: ReturnType<typeof reliabilityCurve>,
	check: ReturnType<typeof thresholdTable>,
	sample: SurfaceSample,
	powerSentence: string
): string {
	if (overall.ece === null) {
		return `No gradeable observations on the ${surface} surface, so nothing was measured. ${powerSentence}`
	}

	// The most useful single row: the highest threshold that still admits a majority of what
	// it could, named because a table's rows are all equally prominent and its point is not.
	const workable = check.toReversed().find((row) => row.admitted_share >= 0.5)

	const thresholdSentence = workable
		? `A check at ${workable.threshold} admits ${(workable.admitted_share * 100).toFixed(1)}% of observations at ` +
			`precision ${workable.precision_above?.toFixed(3) ?? "n/a"}, letting ${workable.errors_admitted} errors ` +
			`through and turning away ${workable.correct_below} correct ones.`
		: "No threshold in the table admits half the observations, so the check table describes only the tail."

	const excludedTotal = sample.excluded.reduce((total, entry) => total + entry.n, 0)
	const excludedSentence = excludedTotal ? ` ${excludedTotal} rows were excluded and are itemized.` : ""

	// Named in the sentence rather than only in a field, because the curve covers only the
	// components truth asserted and a reader could otherwise read the ECE as covering the parse.
	const unassertedSentence = sample.unasserted?.n
		? ` A further ${sample.unasserted.n} produced components were not asserted by any truth row (mean confidence ` +
			`${sample.unasserted.mean_confidence?.toFixed(3)}) and are counted, not curved.`
		: ""

	return (
		`${surface}: ${overall.n} graded observations, accuracy ${overall.accuracy?.toFixed(3)}, ` +
		`ECE ${overall.ece.toFixed(3)} / MCE ${overall.mce?.toFixed(3)}. ${thresholdSentence}${excludedSentence}` +
		`${unassertedSentence} ` +
		`${powerSentence}`
	)
}
