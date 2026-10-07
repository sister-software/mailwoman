/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This module finds where answers change along a ladder of near-identical inputs. It reports which component changed first.
 *
 *   Other measurements here vary the configuration while holding the input fixed. This measurement varies the input
 *   while holding the configuration fixed. That isolates changes caused by a token from changes caused by a setting.
 *
 *   The caller supplies the rungs. A local generator would assert a component order. A generator with the wrong
 *   order for one locale would produce a table for an invalid ordering.
 *
 *   A tag absent on a rung is reported as absent. A component can be gained, lost, or changed. The table preserves
 *   those separate facts instead of grouping all three under "different".
 */

import type { QueryIntentMarker } from "@mailwoman/core/pipeline"
import { haversineKm } from "@mailwoman/spatial"

import type { EngineConfig, EngineRegistryLike } from "#dev-mcp/engine/registry"

/**
 * Borrowed from the counterfactual threshold for the same reason: below the
 * tightest distance anything here grades at, a move cannot change a verdict,
 * so reporting it fills the table with coordinate jitter.
 */
const MOVED_KM = 1

/**
 * One ladder: an ordered series of inputs, each differing minimally from the one before it.
 */
export interface Ladder {
	label?: string
	rungs: string[]
}

/**
 * What changed between one rung and the previous one.
 */
interface RungDelta {
	gained: Array<{ tag: string; value: string }>
	lost: Array<{ tag: string; value: string }>
	changed: Array<{ tag: string; from: string; to: string }>
	moved_km: number | null
	tier_from: string
	tier_to: string
}

interface RungReading {
	step: number
	input: string
	components: Record<string, string>
	lat: number | null
	lon: number | null
	tier: string
	/**
	 * The query-intent advisory codes this rung attached, comma-separated.
	 *
	 * A `QueryIntentMarker` leaves the selected answer unchanged, as its declaration
	 * in `@mailwoman/core/pipeline` states, so a rung carrying one still reports
	 * whatever components and coordinate it resolved.
	 * `poi_category` and `authority_designation` describe an answer the run returned.
	 *
	 * This field therefore states what the run said about its answer.
	 * The reason a component on this rung is absent lies elsewhere, in the parse or the resolver walk.
	 */
	advisories: string | null
	/**
	 * Null on step 0, where there is no previous rung — a different fact from a
	 * delta whose every list is empty.
	 */
	delta: RungDelta | null
	error: string | null
}

interface LadderReading {
	label: string
	rungs: RungReading[]
	/**
	 * The first rung whose components or coordinate differ from the rung below it;
	 * `null` means the whole ladder answered identically.
	 */
	first_divergence: { step: number; input: string; tags: string[]; moved_km: number | null } | null
	rendered: string
}

const ABSENT = "—"

function componentsOf(result: { components?: Record<string, string | undefined> }): Record<string, string> {
	const out: Record<string, string> = {}

	for (const [tag, value] of Object.entries(result.components ?? {})) {
		if (typeof value === "string" && value) {
			out[tag] = value
		}
	}

	return out
}

function diffRungs(previous: RungReading, current: RungReading): RungDelta {
	const gained: RungDelta["gained"] = []
	const lost: RungDelta["lost"] = []
	const changed: RungDelta["changed"] = []

	for (const [tag, value] of Object.entries(current.components)) {
		const before = previous.components[tag]

		if (!Object.hasOwn(previous.components, tag)) {
			gained.push({ tag, value })
		} else if (before !== value) {
			changed.push({ tag, from: before!, to: value })
		}
	}

	for (const [tag, value] of Object.entries(previous.components)) {
		if (!Object.hasOwn(current.components, tag)) {
			lost.push({ tag, value })
		}
	}

	// A null coordinate on either side is not distance zero: abstention is its own result and the tier fields record it.
	const moved =
		previous.lat !== null && previous.lon !== null && current.lat !== null && current.lon !== null
			? haversineKm(previous.lat, previous.lon, current.lat, current.lon)
			: null

	return {
		gained,
		lost,
		changed,
		moved_km: moved === null ? null : Number(moved.toFixed(3)),
		tier_from: previous.tier,
		tier_to: current.tier,
	}
}

/**
 * The rendering shows the addresses a reader needs to decide whether a defect is real.
 *
 * A JSON blob of component maps does not show those addresses.
 */
function renderLadder(reading: Omit<LadderReading, "rendered">): string {
	const tags = [...new Set(reading.rungs.flatMap((rung) => Object.keys(rung.components)))].toSorted()
	const inputWidth = Math.max(5, ...reading.rungs.map((rung) => rung.input.length))

	const widths = tags.map((tag) =>
		Math.max(tag.length, ...reading.rungs.map((r) => (r.components[tag] ?? ABSENT).length))
	)

	const lines = [
		`  ${"input".padEnd(inputWidth)}  ${tags.map((tag, i) => tag.padEnd(widths[i]!)).join("  ")}  tier`,
		`  ${"-".repeat(inputWidth)}  ${widths.map((w) => "-".repeat(w)).join("  ")}  ----`,
	]

	for (const rung of reading.rungs) {
		if (rung.error) {
			lines.push(`  ${rung.input.padEnd(inputWidth)}  ERROR: ${rung.error}`)

			continue
		}

		const cells = tags.map((tag, i) => (rung.components[tag] ?? ABSENT).padEnd(widths[i]!))
		const mark = reading.first_divergence?.step === rung.step ? " ←" : ""
		// An advisory describes the answer on this row and leaves it in place,
		// so the cells beside it are the components the rung resolved.
		const advisories = rung.advisories ? `  advisories: ${rung.advisories}` : ""

		lines.push(`  ${rung.input.padEnd(inputWidth)}  ${cells.join("  ")}  ${rung.tier}${mark}${advisories}`)
	}

	if (reading.first_divergence) {
		const { input, tags: changedTags, moved_km } = reading.first_divergence

		lines.push(
			`  diverges at "${input}" — ${changedTags.join(", ")}` +
				(moved_km === null ? " (no coordinate on one side)" : `, answer moved ${moved_km} km`)
		)
	} else {
		lines.push("  no divergence — every rung produced the same components and the same answer")
	}

	return lines.join("\n")
}

export interface MinimalPairsResult {
	n_ladders: number
	n_rungs_requested: number
	n_rungs_evaluated: number
	n_rungs_errored: number
	config_effective: Record<string, unknown>
	engine_id: string
	moved_km_threshold: number
	ladders: LadderReading[]
	summary: string
}

/**
 * Walk each ladder through one engine and report where its answer first moves.
 *
 * One engine for the whole call, deliberately, because a ladder measured across
 * two engines cannot attribute a change to the input.
 */
export async function runMinimalPairs(
	registry: EngineRegistryLike,
	args: { ladders: Ladder[]; config?: EngineConfig }
): Promise<MinimalPairsResult> {
	const ladders = args.ladders ?? []

	if (!ladders.length) throw new Error("no ladders supplied — pass at least one { rungs: [...] }")

	const engine = await registry.acquire(args.config ?? {})

	const readings: LadderReading[] = []
	let requested = 0
	let evaluated = 0
	let errored = 0

	for (const [index, ladder] of ladders.entries()) {
		const rungs: RungReading[] = []

		requested += ladder.rungs.length

		for (const [step, input] of ladder.rungs.entries()) {
			try {
				const run = await engine.session.geocode(input)
				const markers = (run.result as { intent_markers?: QueryIntentMarker[] }).intent_markers

				rungs.push({
					step,
					input,
					components: componentsOf(run.result),
					lat: run.result.lat,
					lon: run.result.lon,
					tier: run.result.resolution_tier,
					delta: null,
					// `code` is the stable identifier the marker declares.
					// `kind` is the query kind that produced it, so reading `kind` here printed
					// `locality_only` where a reader expected the advisory's own name.
					advisories: markers?.length ? markers.map((marker) => marker.code).join(", ") : null,
					error: null,
				})

				evaluated++
			} catch (error) {
				rungs.push({
					step,
					input,
					components: {},
					lat: null,
					lon: null,
					tier: "error",
					advisories: null,
					delta: null,
					error: (error as Error).message,
				})

				errored++
			}
		}

		let firstDivergence: LadderReading["first_divergence"] = null

		for (let i = 1; i < rungs.length; i++) {
			const current = rungs[i]!
			const previous = rungs[i - 1]!

			if (current.error || previous.error) continue

			const delta = diffRungs(previous, current)

			current.delta = delta

			const tagsChanged = [
				...delta.gained.map((g) => `+${g.tag}`),
				...delta.lost.map((l) => `-${l.tag}`),
				...delta.changed.map((c) => `${c.tag}: ${c.from} → ${c.to}`),
			]

			const movedFar = delta.moved_km !== null && delta.moved_km >= MOVED_KM
			const abstentionFlipped = (previous.lat === null) !== (current.lat === null)

			if (!firstDivergence && (tagsChanged.length || movedFar || abstentionFlipped)) {
				firstDivergence = {
					step: current.step,
					input: current.input,
					tags: tagsChanged.length ? tagsChanged : [`tier ${delta.tier_from} → ${delta.tier_to}`],
					moved_km: delta.moved_km,
				}
			}
		}

		const base: Omit<LadderReading, "rendered"> = {
			label: ladder.label ?? `ladder-${index + 1}`,
			rungs,
			first_divergence: firstDivergence,
		}

		readings.push({ ...base, rendered: renderLadder(base) })
	}

	const diverged = readings.filter((r) => r.first_divergence).length

	return {
		n_ladders: readings.length,
		n_rungs_requested: requested,
		n_rungs_evaluated: evaluated,
		n_rungs_errored: errored,
		config_effective: engine.effective,
		engine_id: engine.engineID,
		moved_km_threshold: MOVED_KM,
		ladders: readings,
		summary:
			`${diverged} of ${readings.length} ladder(s) diverged over ${evaluated} evaluated rung(s)` +
			(errored ? `, ${errored} errored` : "") +
			`. A ladder that did not diverge is a measured negative, not an unmeasured one.`,
	}
}
