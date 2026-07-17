/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The LOCALE FRAGMENT BOARD — targeted failure classes with confidence intervals (#727 stage-2,
 *   Tier 1c). The second of the two standing boards; the first is the global parity floor
 *   (`parity-corpus.ts`, broad, "do no harm").
 *
 *   A change ships when board 1 HOLDS and board 2 MOVES. Neither is a verdict alone. The span-head
 *   arc is the cautionary tale: +23.8pp on its target class and ~+0 net overall, which a single
 *   blended number turns into "inside noise, ship it" — hiding both the win and what it cost.
 *
 *   WHY INTERVALS. The Paris fixture (n=63) reports cells like 3/15. That has a 95% Wilson interval
 *   of roughly 4–48%: not a measurement, an anecdote with a decimal point. This board samples BAN
 *   (Tier A — clean, national, street-name complete) at ~400/class so a cell means something, and
 *   prints the interval next to every number so nobody has to remember that.
 *
 *   THE NEGATIVE CLASS IS THE POINT. `bare-locality` rows carry `expect_no_street`, and the board
 *   scores whether the parser emits a street anyway. Every other street harness in the repo filters
 *   to rows carrying `expect.street`, which makes a hallucinated street INVISIBLE BY CONSTRUCTION —
 *   and that is exactly where T1a caught the span decode failing (12/54 shipped vs 19/54). A board
 *   that cannot score the failure cannot grade the fix.
 *
 *   LABEL POLICY: the full street phrase is `street` — designator, particle, elision, hyphenated
 *   compound, and date material included. `12 bis Rue X` ⇒ house_number "12 bis", street "Rue X".
 *
 *   SPLIT: the fixture's street surfaces are reserved in `ban-fragments-fr.surfaces.txt`. A training
 *   shard MUST exclude them — source-disjoint by normalized street SURFACE, never by record row.
 *   Row-disjoint leaks the surface across the boundary and measures memorization.
 */

import { readFileSync } from "node:fs"

import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { computeQueryShape } from "@mailwoman/query-shape"

export const FRAGMENT_BOARD_FIXTURES = "mailwoman/eval-harness/fixtures/ban-fragments-fr.jsonl"

/** Tags that together form the street phrase under the board's label policy. */
const STREET_TAGS = new Set(["street", "street_prefix", "street_prefix_particle", "street_suffix"])

export interface FragmentFixture {
	id: string
	klass: string
	input: string
	expect: Record<string, string[]>
	/** Present on the negative class: the parser must emit NO street. */
	expect_no_street?: boolean
	surface: string | null
	source: string
}

export interface FragmentBoardOptions {
	locale?: string
	weightsCacheRoot?: string
	fixturesPath?: string
	/** Restrict to one class (e.g. `bare-street`) for a fast iteration loop. */
	klass?: string
}

export interface FragmentBoardOutcome {
	exitCode: number
}

const fold = (value: string): string => value.toLowerCase().replace(/\s+/g, " ").trim()

/**
 * Wilson score interval — the reason this board exists. The normal approximation collapses at the extremes (it happily
 * reports a negative lower bound on 0/400, and a zero-width interval on 400/400); Wilson stays inside [0,1] and stays
 * sane on the small, skewed cells that fragment classes actually produce.
 */
export function wilson(successes: number, total: number, z = 1.96): { low: number; high: number } {
	if (total === 0) return { low: 0, high: 0 }
	const p = successes / total
	const z2 = z * z
	const denom = 1 + z2 / total
	const centre = p + z2 / (2 * total)
	const spread = z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))

	return { low: Math.max(0, (centre - spread) / denom), high: Math.min(1, (centre + spread) / denom) }
}

function flatten(nodes: ReadonlyArray<{ tag: string; value: string; start: number; children?: unknown }>): Array<{
	tag: string
	value: string
	start: number
}> {
	const out: Array<{ tag: string; value: string; start: number }> = []
	const stack = [...nodes]

	while (stack.length) {
		const node = stack.pop() as { tag: string; value: string; start: number; children?: never[] }
		out.push(node)
		stack.push(...((node.children ?? []) as never[]))
	}

	return out
}

export async function runFragmentBoard(options: FragmentBoardOptions = {}): Promise<FragmentBoardOutcome> {
	const fixtures = readFileSync(options.fixturesPath ?? FRAGMENT_BOARD_FIXTURES, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as FragmentFixture)
		.filter((fixture) => !options.klass || fixture.klass === options.klass)

	if (!fixtures.length) throw new Error(`fragment board: no fixtures matched (klass=${options.klass ?? "*"})`)

	const classifier = await NeuralAddressClassifier.loadFromWeights({
		locale: options.locale ?? "en-US",
		cacheRoot: options.weightsCacheRoot,
	})

	// hit = the scored assertion held. For positive classes that is street exact-match; for the
	// negative class it is the ABSENCE of a street.
	const tally = new Map<string, { hit: number; total: number; misses: FragmentFixture[] }>()

	for (const fixture of fixtures) {
		// Production config — the query-shape prior is fed on every path production parses on
		// (safeClassify, and geocode-core since #981). See baselines.json $config.
		const tree = await classifier.parse(fixture.input, {
			postcodeRepair: true,
			queryShape: computeQueryShape(fixture.input),
			enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
		})
		const street = flatten(tree.roots as never)
			.filter((node) => STREET_TAGS.has(node.tag))
			.sort((a, b) => a.start - b.start)
			.map((node) => node.value)
			.join(" ")

		const bucket = tally.get(fixture.klass) ?? { hit: 0, total: 0, misses: [] }
		bucket.total++

		const ok = fixture.expect_no_street
			? fold(street) === ""
			: fold(street) === fold((fixture.expect.street ?? []).join(" "))

		if (ok) {
			bucket.hit++
		} else {
			bucket.misses.push({ ...fixture, got: street } as never)
		}
		tally.set(fixture.klass, bucket)
	}

	console.log(`\nFR locale fragment board — ${fixtures.length} fixtures, BAN (Tier A), production config`)
	console.log(`95% Wilson intervals. bare-locality scores the ABSENCE of a street (the hallucination class).\n`)
	console.log(`  class                     n     rate    95% CI`)

	let totalHit = 0
	let totalN = 0

	for (const [klass, bucket] of [...tally].sort()) {
		totalHit += bucket.hit
		totalN += bucket.total
		const rate = bucket.hit / bucket.total
		const ci = wilson(bucket.hit, bucket.total)
		console.log(
			`  ${klass.padEnd(22)} ${String(bucket.total).padStart(4)}   ${rate.toFixed(3)}   [${ci.low.toFixed(3)}, ${ci.high.toFixed(3)}]`
		)
	}

	const overall = wilson(totalHit, totalN)
	console.log(
		`  ${"OVERALL".padEnd(22)} ${String(totalN).padStart(4)}   ${(totalHit / totalN).toFixed(3)}   [${overall.low.toFixed(3)}, ${overall.high.toFixed(3)}]`
	)

	for (const [klass, bucket] of [...tally].sort()) {
		if (!bucket.misses.length) continue
		console.log(`\n  --- ${klass}: ${bucket.misses.length} misses (first 6) ---`)

		for (const miss of bucket.misses.slice(0, 6)) {
			const want = miss.expect_no_street ? "(no street)" : (miss.expect.street ?? []).join(" ")
			console.log(`    ${JSON.stringify(miss.input)}`)
			console.log(`        want=${JSON.stringify(want)}  got=${JSON.stringify((miss as never as { got: string }).got)}`)
		}
	}

	return { exitCode: 0 }
}
