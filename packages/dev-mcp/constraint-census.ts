/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The CONSTRAINT census — what our gates COST, measured per constraint rather than per row.
 *
 *   `census.ts` asks whether a mechanism in the PARSE path fires at all (L0/L1). This asks the resolver-path question
 *   underneath it: of the lookups that resolved nothing, which constraint was in force, and did we hold the row
 *   anyway. Both are needed and neither substitutes for the other — a constraint can be perfectly alive and still be
 *   the reason an answer was lost.
 *
 *   THE SPLIT THAT MAKES THIS A MEASUREMENT rather than a miss count: a lookup that missed in band X while the same
 *   key sits in band Y is a REACHABILITY failure — the gazetteer had the row and the query went to the wrong shelf.
 *   A key that exists nowhere is a COVERAGE fact. Both currently reach a caller as `null`, and they call for opposite
 *   work: one is a retrieval fix, the other is a data acquisition. They are never summed here.
 *
 *   The raw material has existed since #1721 and nothing consumed it: `ResolveNodeTrace.gates` records mechanism
 *   events in execution order, and `picked: null` is — in that type's own words — "a claim, not an omission". The
 *   first run over the board found `parent_fallback_retry` firing 194 times and converting zero, because it relaxes
 *   the PARENT while the BAND is what blocks (#1756).
 *
 *   KEYED WITH `normalizeLocalityForKey`, the fold the candidate build writes and its readers probe. A `toLowerCase()`
 *   approximation silently moves rows from the reachability column into the coverage one, which is the exact error
 *   this census exists to stop other people making.
 */

import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street-normalize"

import type { EngineConfig, EngineRegistry } from "./engine-registry.ts"
import { resolveInputSet, type InputSetRef } from "./input-sets.ts"
import { openSealedArtifact } from "./lookup.ts"
import { provenanceFor, type Provenance } from "./tool-kit.ts"

/**
 * One lookup that resolved nothing, with the constraint that was in force and what the gazetteer holds regardless.
 */
interface ConstraintMiss {
	id: string
	input: string
	tag: string
	value: string
	name_key: string
	/**
	 * The placetype band the query was scoped to. Chosen by the MODEL'S TAG, which is the whole point: a wrong tag makes
	 * a row we hold unreachable, and the miss is indistinguishable from the row not existing.
	 */
	band: string
	gates: string[]
	/**
	 * Bands holding this key OTHER than the one probed, measured with no constraint applied at all. Empty means the key
	 * exists nowhere in the gazetteer, which is a coverage fact rather than a retrieval failure.
	 */
	elsewhere: string[]
	/**
	 * Candidates present on a null pick means the rows came back and lost downstream; none means the probe itself
	 * returned an empty set. Calling a scoring filter an empty gazetteer is the misreading this separates.
	 */
	had_candidates: boolean
}

/**
 * What the census reader needs of a connection it is handed: one prepared read, and a way to end it.
 *
 * Structural rather than `DatabaseClient` itself because `OpenCensusArtifact` is injectable — the tests supply a fake
 * that answers fixed rows without opening a file. `destroy` rather than `close` is what a `DatabaseClient` offers, so
 * the real opener satisfies this without an adapter.
 */
interface CensusDatabase {
	prepare(sql: string): { all(nameKey: string): Array<Record<string, unknown>> }
	destroy(): void | Promise<void>
}

type OpenCensusArtifact = (path: string | undefined) => { db: CensusDatabase } | { unavailable: string }

interface GateReading {
	gates: string
	fired: number
	resolved_nothing: number
	/**
	 * Of the misses under this constraint set, how many hold the key in another band — the subset a retrieval change
	 * could convert, as opposed to the subset that needs data we do not have.
	 */
	reachable_elsewhere: number
}

export interface ConstraintCensusResult {
	provenance: Provenance
	summary: string
	n_rows: number
	n_lookups: number
	n_resolved_nothing: number
	/**
	 * We hold the row and could not reach it. A retrieval fix, and the only column a cross-band retry can move.
	 */
	n_reachability: number
	/**
	 * The key exists nowhere in the gazetteer. A coverage fact, never counted as a retrieval failure and never summed
	 * with the column above.
	 */
	n_coverage: number
	gates: GateReading[]
	/**
	 * Reachability classes, largest first: which band was probed, and which bands actually hold the key. The largest
	 * class is the one a cross-band retry should try first.
	 */
	by_band: Array<{ probed: string; found_in: string[]; n: number; examples: ConstraintMiss[] }>
	inert_gates: string[]
	misses: ConstraintMiss[]
	rendered: string
}

/**
 * Above this, a gate that never once accompanies a successful pick is called INERT rather than merely unlucky.
 *
 * Small on purpose: the claim is about a mechanism that has never worked, and at n below this the honest report is "not
 * enough firings to say", which the rendering states instead.
 */
const INERT_MIN_FIRINGS = 20

function bandsHolding(db: CensusDatabase, nameKey: string): string[] {
	const rows = db
		.prepare(
			`SELECT DISTINCT p.placetype AS placetype
			   FROM candidate c
			   JOIN placetype_codes p ON p.id = c.placetype_id
			  WHERE c.name_key = ?`
		)
		.all(nameKey)

	return rows.map((r) => String(r["placetype"]))
}

function render(result: Omit<ConstraintCensusResult, "rendered">): string {
	const lines: string[] = [
		`${result.n_rows} rows → ${result.n_lookups} backend lookups; ${result.n_resolved_nothing} resolved nothing ` +
			`(${((result.n_resolved_nothing / Math.max(1, result.n_lookups)) * 100).toFixed(1)}%)`,
		`  key exists in another band : ${result.n_reachability}  ← reachability, a retrieval fix`,
		`  key exists nowhere         : ${result.n_coverage}  ← coverage, a data fact`,
		"",
		`  ${"gates".padEnd(46)} fired   nothing  reachable`,
	]

	for (const g of result.gates) {
		const pct = ((g.resolved_nothing / Math.max(1, g.fired)) * 100).toFixed(0)

		lines.push(
			`  ${g.gates.padEnd(46)} ${String(g.fired).padStart(5)}   ${String(g.resolved_nothing).padStart(5)} (${pct.padStart(3)}%)  ${String(g.reachable_elsewhere).padStart(5)}`
		)
	}

	if (result.inert_gates.length) {
		lines.push(
			"",
			`  INERT — fired ≥${INERT_MIN_FIRINGS} times and NEVER accompanied a pick: ${result.inert_gates.join(", ")}`
		)
	}

	for (const cls of result.by_band.slice(0, 8)) {
		lines.push("", `  probed ${cls.probed} → key lives in ${cls.found_in.join(", ")}   (${cls.n} lookup(s))`)

		for (const m of cls.examples) {
			lines.push(`      ${m.id}  tag=${m.tag} "${m.value}"  gates=[${m.gates.join(",")}]`)
		}
	}

	return lines.join("\n")
}

/**
 * Walk an input set through one traced engine and aggregate every lookup that resolved nothing.
 */
export async function runConstraintCensus(
	registry: EngineRegistry,
	args: { inputs?: InputSetRef; config?: EngineConfig },
	dependencies: { openArtifact?: OpenCensusArtifact } = {}
): Promise<ConstraintCensusResult> {
	const set = await resolveInputSet(args.inputs ?? { kind: "board" })
	// Tracing is the census's entire input, and the band probe is what separates reachability from coverage. Both are
	// forced on regardless of what the caller passed — neither can change an answer, so neither is a lever.
	const engine = await registry.acquire({ ...args.config, trace: true, diagnose_unreachable: true })
	const dataRoot = String(engine.effective.dataRoot ?? "")
	const opened = (dependencies.openArtifact ?? openSealedArtifact)(`${dataRoot}/wof/candidate.db`)

	if (!("db" in opened)) {
		throw new Error(
			`the constraint census needs candidate.db to tell reachability from coverage — ${opened.unavailable}`
		)
	}

	const db = opened.db
	const misses: ConstraintMiss[] = []
	const fired = new Map<string, number>()
	const nothing = new Map<string, number>()
	const pickedUnder = new Set<string>()

	let lookups = 0

	try {
		for (const item of set.inputs) {
			let run

			try {
				run = await engine.session.geocode(item.input)
			} catch {
				continue
			}

			for (const rec of run.trace?.resolver ?? []) {
				lookups++

				const key = rec.gates.length ? rec.gates.join("+") : "(none)"

				fired.set(key, (fired.get(key) ?? 0) + 1)

				if (rec.picked) {
					// A gate that ever accompanies a pick is not inert, whatever its miss rate.
					for (const gate of rec.gates) {
						pickedUnder.add(gate)
					}

					continue
				}

				nothing.set(key, (nothing.get(key) ?? 0) + 1)

				const nameKey = normalizeLocalityForKey(rec.value)
				const elsewhere = [...new Set(bandsHolding(db, nameKey).filter((b) => b !== rec.placetype))].toSorted()

				misses.push({
					id: item.id,
					input: item.input,
					tag: rec.tag,
					value: rec.value,
					name_key: nameKey,
					band: rec.placetype,
					gates: rec.gates,
					elsewhere,
					had_candidates: rec.candidates.length > 0,
				})
			}
		}
	} finally {
		await db.destroy()
	}

	const reachability = misses.filter((m) => m.elsewhere.length)

	const gates: GateReading[] = [...fired.entries()]
		.map(([g, n]) => ({
			gates: g,
			fired: n,
			resolved_nothing: nothing.get(g) ?? 0,
			reachable_elsewhere: misses.filter(
				(m) => (m.gates.length ? m.gates.join("+") : "(none)") === g && m.elsewhere.length
			).length,
		}))
		.toSorted((a, b) => b.fired - a.fired)

	const firingsPerGate = new Map<string, number>()

	for (const [set_, n] of fired.entries()) {
		for (const gate of set_.split("+")) {
			firingsPerGate.set(gate, (firingsPerGate.get(gate) ?? 0) + n)
		}
	}

	const inert = [...firingsPerGate.entries()]
		.filter(([gate, n]) => n >= INERT_MIN_FIRINGS && !pickedUnder.has(gate) && gate !== "(none)")
		.map(([gate, n]) => `${gate} (${n} firings)`)
		.toSorted()

	const classes = new Map<string, ConstraintMiss[]>()

	for (const m of reachability) {
		const k = `${m.band}|${m.elsewhere.join(",")}`

		classes.set(k, [...(classes.get(k) ?? []), m])
	}

	const byBand = [...classes.entries()]
		.map(([k, list]) => ({
			probed: k.split("|")[0]!,
			found_in: k.split("|")[1]!.split(","),
			n: list.length,
			examples: list.slice(0, 3),
		}))
		.toSorted((a, b) => b.n - a.n)

	const base: Omit<ConstraintCensusResult, "rendered"> = {
		provenance: provenanceFor(engine, set),
		n_rows: set.inputs.length,
		n_lookups: lookups,
		n_resolved_nothing: misses.length,
		n_reachability: reachability.length,
		n_coverage: misses.length - reachability.length,
		gates,
		by_band: byBand,
		inert_gates: inert,
		misses,
		summary:
			`${misses.length} of ${lookups} lookups over ${set.inputs.length} rows resolved nothing. ` +
			`${reachability.length} hold the key in another band (retrieval), ${misses.length - reachability.length} ` +
			`hold it nowhere (coverage) — never summed. ` +
			(inert.length ? `INERT: ${inert.join(", ")}.` : "No gate reached the inert threshold."),
	}

	return { ...base, rendered: render(base) }
}
