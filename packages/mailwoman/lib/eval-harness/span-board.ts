/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The standing-board frame the digit and fragment boards share: load a JSONL fixture set, parse every row under the
 *   PRODUCTION configuration, tally per class, and print Wilson-intervalled rates with a miss sample. Each board owns
 *   its grading, its header, and its miss rendering — the frame owns everything else, so the two boards cannot drift
 *   on the half that makes their numbers comparable.
 */

import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { computeQueryShape } from "@mailwoman/query-shape"
import { JSONSpliterator } from "spliterator"

import { flattenNodes } from "#eval-harness/flatten-nodes"

/**
 * Production parse configuration — the query-shape prior is fed on every path production parses on (safeClassify, and
 * geocode-core since #981). See baselines.json $config.
 */
export function productionParseOptions(input: string): {
	postcodeRepair: true
	queryShape: ReturnType<typeof computeQueryShape>
	enforceWordConsistency: typeof WORD_CONSISTENCY_SHIP_DEFAULT
} {
	return {
		postcodeRepair: true,
		queryShape: computeQueryShape(input),
		enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
	}
}

/**
 * Wilson score interval — the reason the boards exist. The normal approximation collapses at the extremes (it reports a
 * negative lower bound on 0/400, and a zero-width interval on 400/400); Wilson stays inside [0,1] and stays sane on the
 * small, skewed cells that fragment classes actually produce.
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

/**
 * The fields every span-board fixture carries.
 */
export interface SpanBoardFixture {
	id: string
	klass: string
	input: string
	expect: Record<string, string[]>
	surface: string | null
	source: string
}

export interface SpanBoardOptions {
	locale?: string
	weightsCacheRoot?: string
	fixturesPath?: string
	/**
	 * Restrict to one class (e.g. `bare-street`) for a fast iteration loop.
	 */
	klass?: string
}

export interface SpanBoardOutcome {
	exitCode: number
}

export interface SpanBoardSpec<Fixture extends SpanBoardFixture> {
	/**
	 * Name used in the no-fixtures refusal (`"digit board"`).
	 */
	name: string
	defaultFixturesPath: string
	/**
	 * Grade one fixture from the parse's flattened nodes: whether the scored assertion held, and what the parse put in
	 * the scored slot (carried into the miss sample).
	 */
	grade: (fixture: Fixture, nodes: ReturnType<typeof flattenNodes>) => { ok: boolean; got: string }
	headerLines: (fixtureCount: number) => string[]
	describeWant: (fixture: Fixture) => string
	missSampleSize: number
}

export async function runSpanBoard<Fixture extends SpanBoardFixture>(
	spec: SpanBoardSpec<Fixture>,
	options: SpanBoardOptions = {}
): Promise<SpanBoardOutcome> {
	const fixtures = (
		await Array.fromAsync(JSONSpliterator.fromAsync<Fixture>(options.fixturesPath ?? spec.defaultFixturesPath))
	).filter((fixture) => !options.klass || fixture.klass === options.klass)

	if (!fixtures.length) throw new Error(`${spec.name}: no fixtures matched (klass=${options.klass ?? "*"})`)

	const classifier = await NeuralAddressClassifier.loadFromWeights({
		locale: options.locale ?? "en-US",
		cacheRoot: options.weightsCacheRoot,
	})

	const tally = new Map<string, { hit: number; total: number; misses: Array<Fixture & { got: string }> }>()

	for (const fixture of fixtures) {
		const tree = await classifier.parse(fixture.input, productionParseOptions(fixture.input))
		const { ok, got } = spec.grade(fixture, flattenNodes(tree.roots))
		const bucket = tally.get(fixture.klass) ?? { hit: 0, total: 0, misses: [] }

		bucket.total++

		if (ok) {
			bucket.hit++
		} else {
			bucket.misses.push({ ...fixture, got })
		}

		tally.set(fixture.klass, bucket)
	}

	for (const line of spec.headerLines(fixtures.length)) {
		console.log(line)
	}

	console.log(`  class                     n     rate    95% CI`)

	let totalHit = 0
	let totalN = 0

	for (const [klass, bucket] of [...tally].toSorted()) {
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

	for (const [klass, bucket] of [...tally].toSorted()) {
		if (!bucket.misses.length) continue

		console.log(`\n  --- ${klass}: ${bucket.misses.length} misses (first ${spec.missSampleSize}) ---`)

		for (const miss of bucket.misses.slice(0, spec.missSampleSize)) {
			console.log(`    ${JSON.stringify(miss.input)}`)
			console.log(`        want=${JSON.stringify(spec.describeWant(miss))}  got=${JSON.stringify(miss.got)}`)
		}
	}

	return { exitCode: 0 }
}
