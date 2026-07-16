/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The NO DIGIT-OWNERSHIP BOARD — which tag owns a digit-bearing token (Track B).
 *
 *   The third standing board. Board 1 is the global parity floor (`parity-corpus.ts`, broad, "do no
 *   harm"); board 2 is the FR locale fragment board (`fragment-board.ts`, street polarity); this is
 *   board 3, and it exists because Track B's entire defect was visible only as `postcode 25/249 =
 *   0.100` on the parity precision half — 25 rows, no subclass, no interval. A board that cannot put
 *   a CI on a cell cannot grade a fix.
 *
 *   WHY NORWAY. `#901` measured a 30% residual on Norwegian street-led forms, diagnosed it as
 *   order-sensitive decode, and built `synth-no-street-led` at source weight 12.0 — the maximum
 *   targeted-fix tier — to close it. The YAML Norway problem (`NO:` resolves to the boolean `false`
 *   under YAML 1.1, so `country_weights.get("NO")` misses and the loader drops every row) meant that
 *   shard never contributed a single row to any run since v1.9.0. The fix is #1145.
 *
 *   That makes the baseline unusually clean: SHIPPED v310 has never seen one Norwegian address, so
 *   this board's v310 arm is a TRUE ZERO-KNOWLEDGE reading, not a weak-prior one. Register it before
 *   the retrain exists.
 *
 *   THE NEGATIVE CLASS IS THE POINT — the same lesson as board 2's `bare-locality`. Every positive
 *   class here rewards "call the digit a house_number", so a model can ace all five by never
 *   emitting postcode again. `bare-pc` rows carry `expect_no_house_number` and score whether the
 *   parser still reads a real postcode as a postcode. Without it the board cannot tell a learned
 *   DISTINCTION from a flipped DEFAULT, which is exactly the trade board 2 caught v310 NOT making
 *   (bare-locality held 0.980 -> 0.980).
 *
 *   WHY `bare-street-hn` MATTERS MOST DIAGNOSTICALLY: it carries no postcode at all, so nothing
 *   competes for the digit. If the model still says postcode there, the defect is not a
 *   postcode-vs-house_number competition and the whole framing is wrong.
 *
 *   SPLIT: surfaces are reserved in `no-digits.surfaces.txt` and `no-street-led` REQUIRES
 *   `--exclude-surfaces` (it throws otherwise). Source-disjoint by normalized street SURFACE, never
 *   by record row — row-disjoint leaks the surface across the boundary and measures memorization.
 *
 *   SLASH HAZARD: Norwegian `124/1` is ONE component (cadastral gnr/bnr); Australian `12/345` is TWO
 *   (unit 12 + house_number 345). Identical surface shape, opposite correct answers. `slash-hn` pins
 *   the Norwegian reading so a future AU intra-word-split shard cannot generalize over it unnoticed.
 */

import { readFileSync } from "node:fs"

import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { computeQueryShape } from "@mailwoman/query-shape"

import { wilson } from "./fragment-board.ts"

export const DIGIT_BOARD_FIXTURES = "mailwoman/eval-harness/fixtures/no-digits.jsonl"

export interface DigitFixture {
	id: string
	klass: string
	input: string
	expect: Record<string, string[]>
	/** Present on the negative class: the parser must emit NO house_number, and MUST still emit the postcode. */
	expect_no_house_number?: boolean
	surface: string | null
	source: string
}

export interface DigitBoardOptions {
	locale?: string
	weightsCacheRoot?: string
	fixturesPath?: string
	klass?: string
}

export interface DigitBoardOutcome {
	exitCode: number
}

const fold = (value: string): string => value.toLowerCase().replace(/\s+/g, " ").trim()

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

const tagText = (nodes: Array<{ tag: string; value: string; start: number }>, tag: string): string =>
	nodes
		.filter((n) => n.tag === tag)
		.sort((a, b) => a.start - b.start)
		.map((n) => n.value)
		.join(" ")

export async function runDigitBoard(options: DigitBoardOptions = {}): Promise<DigitBoardOutcome> {
	const fixtures = readFileSync(options.fixturesPath ?? DIGIT_BOARD_FIXTURES, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as DigitFixture)
		.filter((fixture) => !options.klass || fixture.klass === options.klass)

	if (!fixtures.length) throw new Error(`digit board: no fixtures matched (klass=${options.klass ?? "*"})`)

	const classifier = await NeuralAddressClassifier.loadFromWeights({
		locale: options.locale ?? "en-US",
		cacheRoot: options.weightsCacheRoot,
	})

	const tally = new Map<string, { hit: number; total: number; misses: Array<DigitFixture & { got: string }> }>()

	for (const fixture of fixtures) {
		// Production config — the query-shape prior is fed on every path production parses on
		// (safeClassify, and geocode-core since #981). See baselines.json $config.
		const tree = await classifier.parse(fixture.input, {
			postcodeRepair: true,
			queryShape: computeQueryShape(fixture.input),
			enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
		})
		const nodes = flatten(tree.roots as never)
		const hn = tagText(nodes, "house_number")
		const pc = tagText(nodes, "postcode")

		const bucket = tally.get(fixture.klass) ?? { hit: 0, total: 0, misses: [] }

		bucket.total++

		// The negative class scores TWO things at once, because either failure is the same mistake:
		// the postcode must survive AND no house_number may be invented from it.
		const ok = fixture.expect_no_house_number
			? fold(hn) === "" && fold(pc) === fold((fixture.expect.postcode ?? []).join(" "))
			: fold(hn) === fold((fixture.expect.house_number ?? []).join(" "))

		if (ok) bucket.hit++
		else bucket.misses.push({ ...fixture, got: fixture.expect_no_house_number ? `hn=${hn} pc=${pc}` : hn })
		tally.set(fixture.klass, bucket)
	}

	console.log(`\nNO digit-ownership board — ${fixtures.length} fixtures, Kartverket-derived, production config`)
	console.log(`95% Wilson intervals. bare-pc scores the ABSENCE of a house_number AND a surviving postcode.`)
	console.log(`bare-street-hn carries NO postcode — nothing competes for the digit.\n`)
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
		console.log(`\n  --- ${klass}: ${bucket.misses.length} misses (first 5) ---`)

		for (const miss of bucket.misses.slice(0, 5)) {
			const want = miss.expect_no_house_number
				? `hn=(none) pc=${(miss.expect.postcode ?? []).join(" ")}`
				: (miss.expect.house_number ?? []).join(" ")

			console.log(`    ${JSON.stringify(miss.input)}`)
			console.log(`        want=${JSON.stringify(want)}  got=${JSON.stringify(miss.got)}`)
		}
	}

	return { exitCode: 0 }
}
