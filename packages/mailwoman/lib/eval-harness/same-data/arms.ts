/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The three arms of the same-data benchmark (#2261), each reading one frozen fixture row and answering
 *   with a selection, a confidence, and a machine-readable reason.
 *
 *   EVERY ARM RECORDS WHAT IT READ BEFORE IT RESOLVES. `observeEvidence` runs first and its receipt travels
 *   with the result, so the equality check is over what the arms actually consumed rather than over the
 *   file they were handed — a validator that only reads the file cannot catch an arm that filtered the
 *   pool on its way in.
 *
 *   ONE CONFIDENCE DEFINITION FOR ALL THREE. The winner's margin over the runner-up within the arm's own
 *   considered set, normalized into [0, 1], with 1 when there was no runner-up. The arms score on
 *   different scales, so the bins are not comparable across arms and the record says so; calibration asks
 *   whether an arm's own confidence tracks its own accuracy, which is a per-arm property.
 *
 *   AN ABSTENTION IS A CLAIM. `picked: null` on every trace, or no admin node carrying a `placeID`, is
 *   recorded as an abstention WITH the checks that produced it. A row that errored is not an abstention
 *   and is never scored as one — it is a harness failure, and `error` carries it.
 */

import { collectNodes, type AddressNode, type AddressTree } from "@mailwoman/core/decoder"
import type { ResolveNodeTrace, ResolveOpts } from "@mailwoman/core/resolver"
import { createWOFResolver } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"

import { ADMIN_TAG_DEPTH, selectBaseline } from "#eval-harness/same-data/baseline"
import {
	type ArmEvidenceObservation,
	observeEvidence,
	replayBackend,
	type SameDataFixtureRow,
	type SameDataPanelRow,
} from "#eval-harness/same-data/fixture"

/**
 * The distance beyond which a selection is a wrong-area selection, as the frozen ruler registers it.
 */
export const WRONG_AREA_KM = 25

/**
 * The ablation arm's pinned options — the six library defaults it turns off. Read from the frozen definition at run
 * time; this constant exists so a unit test can assert the two agree.
 */
export const ABLATION_RESOLVE_OPTS: ResolveOpts = {
	adminCoherence: false,
	postcodeConsistency: false,
	spanRescore: false,
	postalCompoundRecovery: false,
	parentFallback: false,
	hierarchyCompletion: false,
}

export interface ArmRowResult {
	arm: string
	rowID: string
	stratum: string
	/**
	 * The selected candidate id as a string, or null for an abstention.
	 */
	selection: string | null
	/**
	 * True when the selection equals the row's gold place id. Always false for an abstention, including in the
	 * withheld-gold stratum — abstention is scored there through the abstention metrics, not by calling it a selection.
	 */
	correct: boolean
	/**
	 * True when the selection lies more than {@link WRONG_AREA_KM} from the gold coordinate. Null when the arm abstained
	 * or the selected candidate carries no coordinate — absence of a distance is not a distance of zero.
	 */
	wrongArea: boolean | null
	distanceKm: number | null
	confidence: number
	/**
	 * The deciding check or refusal condition, in the arm's own vocabulary. Null when the arm produced none, which the
	 * mechanism-coverage metric counts.
	 */
	mechanism: string | null
	evidence: ArmEvidenceObservation
	/**
	 * Set when the arm raised. A row carrying an error is a harness failure and is excluded from every metric with its
	 * count reported, never folded into abstention.
	 */
	error?: string
}

/**
 * The deepest admin node carrying a resolver-supplied place id, using the registered depth order.
 */
function deepestResolvedAdmin(tree: AddressTree): AddressNode | null {
	const byTag = new Map<string, AddressNode[]>()

	for (const node of collectNodes(tree.roots, (candidate) => Boolean(candidate.placeID))) {
		const bucket = byTag.get(node.tag) ?? []

		bucket.push(node)
		byTag.set(node.tag, bucket)
	}

	for (const tag of ADMIN_TAG_DEPTH) {
		const hit = byTag.get(tag)?.[0]

		if (hit) return hit
	}

	return null
}

/**
 * The candidate id inside a `wof:<id>` place URI.
 */
function placeIDValue(placeID: string): string {
	return placeID.startsWith("wof:") ? placeID.slice("wof:".length) : placeID
}

/**
 * The winner's normalized margin over the runner-up in one trace, in [0, 1]. One when the lookup considered a single
 * candidate; zero when the top two tied.
 */
function traceMargin(trace: ResolveNodeTrace): number {
	const scores = trace.candidates.map((candidate) => candidate.score).toSorted((left, right) => right - left)
	const [top, runnerUp] = scores

	if (top === undefined) return 0

	if (runnerUp === undefined) return 1

	const span = Math.abs(top)

	if (span === 0) return 0

	return Math.min(1, Math.max(0, (top - runnerUp) / span))
}

/**
 * The trace that produced a node's selection, matched on the picked id.
 */
function tracesFor(traces: readonly ResolveNodeTrace[], selection: string): ResolveNodeTrace | null {
	return traces.find((trace) => trace.picked && String(trace.picked.id) === selection) ?? null
}

/**
 * The mechanism string for a resolver arm: the pick's source and the checks that ran, or the checks of the last lookup
 * when the arm abstained.
 */
function resolverMechanism(traces: readonly ResolveNodeTrace[], picked: ResolveNodeTrace | null): string | null {
	if (picked) {
		return [`picked:${picked.picked?.source ?? "unknown"}`, ...picked.checks].join(" ")
	}

	const last = traces.at(-1)

	if (!last) return null

	return ["picked:none", ...last.checks].join(" ")
}

function gradeSelection(
	panel: SameDataPanelRow,
	selection: string | null,
	selectedCoord: {
		lat?: number
		lon?: number
	} | null
): Pick<ArmRowResult, "correct" | "wrongArea" | "distanceKm"> {
	if (selection === null) return { correct: false, wrongArea: null, distanceKm: null }

	const correct = panel.gold.placeIDs.some((placeID) => String(placeID) === selection)

	if (selectedCoord?.lat === undefined || selectedCoord.lon === undefined) {
		return { correct, wrongArea: null, distanceKm: null }
	}

	const distanceKm = haversineKm(selectedCoord.lat, selectedCoord.lon, panel.gold.lat, panel.gold.lon)

	return { correct, wrongArea: distanceKm > WRONG_AREA_KM, distanceKm }
}

/**
 * Run one resolver arm over one row.
 */
export async function runResolverArm(
	arm: string,
	panel: SameDataPanelRow,
	row: SameDataFixtureRow,
	opts: ResolveOpts
): Promise<ArmRowResult> {
	const evidence = observeEvidence(arm, row)
	const traces: ResolveNodeTrace[] = []

	try {
		const resolver = createWOFResolver(replayBackend(row))

		const decorated = await resolver.resolveTree(row.tree, {
			...opts,
			traceSink: (record) => traces.push(record),
		})

		const node = deepestResolvedAdmin(decorated)
		const selection = node?.placeID ? placeIDValue(node.placeID) : null
		const picked = selection ? tracesFor(traces, selection) : null

		return {
			arm,
			rowID: panel.id,
			stratum: panel.stratum,
			selection,
			...gradeSelection(panel, selection, node ? { lat: node.lat, lon: node.lon } : null),
			confidence: picked ? traceMargin(picked) : 0,
			mechanism: resolverMechanism(traces, picked),
			evidence,
		}
	} catch (error) {
		return {
			arm,
			rowID: panel.id,
			stratum: panel.stratum,
			selection: null,
			correct: false,
			wrongArea: null,
			distanceKm: null,
			confidence: 0,
			mechanism: null,
			evidence,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

/**
 * Run the baseline arm over one row.
 */
export function runBaselineArm(panel: SameDataPanelRow, row: SameDataFixtureRow): ArmRowResult {
	const evidence = observeEvidence("baseline", row)
	const selected = selectBaseline(row.tree, row.pool)

	const candidate = selected.placeID ? (row.pool.find((entry) => String(entry.id) === selected.placeID) ?? null) : null

	return {
		arm: "baseline",
		rowID: panel.id,
		stratum: panel.stratum,
		selection: selected.placeID,
		...gradeSelection(panel, selected.placeID, candidate),
		confidence: selected.confidence,
		mechanism: selected.abstainedBecause
			? `abstained:${selected.abstainedBecause}`
			: selected.components
				? `exact:${selected.components.exact} country:${selected.components.countryQualifier} region:${selected.components.regionQualifier} similarity:${selected.components.similarity.toFixed(4)}`
				: null,
		evidence,
	}
}
