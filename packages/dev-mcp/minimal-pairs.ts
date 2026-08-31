/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where along a LADDER of near-identical inputs the answer changes, and which component changed first.
 *
 *   Every other measurement here varies the CONFIGURATION and holds the input fixed: `mwdev_compare` swaps arms,
 *   `counterfactual.ts` flips one lever. This varies the INPUT and holds the configuration fixed, which is the only
 *   way to attribute a failure to a token rather than a setting. Both defects it was built from were diagnosed this
 *   way by hand:
 *
 *       Portopetro, Illes Balears, Spain              locality ok   region ok
 *       07691 Portopetro, Illes Balears, Spain        locality ok   region DISCARDED
 *       15, 07691 Portopetro, Illes Balears, Spain    locality DISPLACED by the region
 *
 *   Read down that ladder and the diagnosis is not "Spain is weak" — it is that a leading postcode discards the
 *   region and a house number then displaces the locality, in two separate stages, with no street involved. The
 *   aggregate score for ES says none of that.
 *
 *   RUNGS ARE THE CALLER'S. Nothing here generates them, because generating them means asserting a component order,
 *   and a generator that is silently wrong about order for one locale would produce a confident table about a ladder
 *   nobody wrote. The caller supplies the minimal pairs; this measures them.
 *
 *   A tag that is ABSENT on a rung is reported absent. Gained, lost and changed are three different facts about a
 *   component, and collapsing them into "different" is what makes a diff table unreadable.
 */

import { haversineKm } from "@mailwoman/spatial"

import type { EngineConfig, EngineRegistryLike } from "#engine-registry"

/**
 * How far the resolved point must move before the rung is called a divergence, in kilometres.
 *
 * Borrowed from the counterfactual threshold for the same reason it was chosen there: below the tightest distance
 * anything here grades at, a move cannot change a verdict, so reporting it fills the table with coordinate jitter.
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
	 * The #1649 intent gate's verdict, when it fired on this rung.
	 *
	 * A refused rung has NO components and no coordinate, and is otherwise indistinguishable from an input the parser
	 * could make nothing of. It is the opposite: the gate discards a COMPLETED tree. `Cafe at St Mary's, Oxford` parses
	 * to `locality=Oxford › dependent_locality=St Mary's › street=Cafe` and is then refused as a thing-query, while `The
	 * Cafe at St Mary's, Oxford` is not — so a ladder over the two reads as a parse collapse unless the refusal is named
	 * here.
	 */
	refused?: string
	/**
	 * What changed against the PREVIOUS rung. Null on step 0, where there is no previous rung — which is a different fact
	 * from a delta whose every list is empty, and the rendering keeps them apart.
	 */
	delta: RungDelta | null
	error?: string
}

interface LadderReading {
	label: string
	rungs: RungReading[]
	/**
	 * The first rung whose components or coordinate differ from the rung below it. `null` means the whole ladder answered
	 * identically with reportable result.
	 */
	first_divergence: { step: number; input: string; tags: string[]; moved_km: number | null } | null
	rendered: string
}

const ABSENT = "—"

function componentsOf(result: { components?: Record<string, string | undefined> }): Record<string, string> {
	const out: Record<string, string> = {}

	for (const [tag, value] of Object.entries(result.components ?? {})) {
		if (typeof value === "string" && value.length) {
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

	// A null coordinate on either side is not distance zero. Abstention is its own outcome and the tier fields carry it.
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
 * The ladder as a table, with the input beside its own result on every line.
 *
 * The rendering is the deliverable, not a convenience: a reader deciding whether a defect is real needs the addresses
 * in view, and a JSON blob of component maps does not put them there.
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
		// A refusal is stated on the row itself. Its cells are all ABSENT, which without this reads as a parse that
		// found nothing rather than a completed parse that was thrown away.
		const refusal = rung.refused ? `  REFUSED as ${rung.refused} — parse discarded, not failed` : ""

		lines.push(`  ${rung.input.padEnd(inputWidth)}  ${cells.join("  ")}  ${rung.tier}${mark}${refusal}`)
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
 * Walk each ladder through ONE engine and report where its answer first moves.
 *
 * One engine for the whole call, deliberately: a ladder measured across two engines cannot attribute a change to the
 * input, which is the only thing this measures.
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
				const markers = (run.result as { intent_markers?: Array<{ kind: string }> }).intent_markers

				rungs.push({
					step,
					input,
					components: componentsOf(run.result),
					lat: run.result.lat,
					lon: run.result.lon,
					tier: String(run.result.resolution_tier),
					delta: null,
					...(markers?.length ? { refused: markers.map((m) => m.kind).join(", ") } : {}),
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
