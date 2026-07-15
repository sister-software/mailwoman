/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Oracle-recall@k over segment-level k-best decodes (#727 stage-2 instrumentation).
 *
 *   Every standing gate scores the TOP-1 parse, which made hypothesis-space improvements invisible —
 *   the instrument-blindness the 2026-07-15 stage-2 plan names. This eval measures the k-best
 *   headroom directly: a semi-Markov Viterbi over the CURRENT model's post-prior emissions (span
 *   score = summed B-/I- log-probs over word-aligned segments, smoothed empirical segment-type
 *   transition bigrams from the golden dev gold orderings), returning the top-k whole segmentations.
 *   `oracle@k` = the gold value appears in ANY of the top-k hypotheses' extractions.
 *
 *   Baseline registered night-3 (v264, triaged parity corpus): street token-decode 0.584 vs
 *   seg-decode@1 0.453 / oracle@5 0.663 / oracle@10 0.749 — the naive re-decode is WORSE at rank 1
 *   (a trained span scorer is necessary) while the correct reading exists in the top-10 ~75% of the
 *   time (+16.5pt of rerank headroom). Both halves of the DeepSeek-designed falsifier (session
 *   019f6471) — details in `docs/superpowers/plans/2026-07-15-727-stage2-kbest-plan.md`.
 *
 *   This decoder is deliberately the same shape the stage-2 JS/WASM post-processing decode will
 *   take (span enumeration + pruning + k-way Viterbi outside the ONNX graph); when the trained span
 *   head lands, its scores replace the summed BIO log-probs here and this eval's oracle@k becomes
 *   the rerank ceiling tracker.
 */

import { readFileSync } from "node:fs"

import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"

import type { ParityFixture } from "../dev-tools/convert-parity-fixtures.run.ts"
import { PARITY_FIXTURES_PATH, PARITY_FLOORS } from "./parity-corpus.ts"

/** Maximum typed-segment length in words. */
const MAX_SEGMENT_WORDS = 6

/** Golden dev files used to estimate the segment-type transition bigrams. */
const TRANSITION_GOLDEN_FILES = ["us.jsonl", "fr.jsonl"]

export interface OracleKOptions {
	locale?: string
	/** Package-shaped candidate weights dir (mirrors `eval parity --weights-cache`). */
	weightsCacheRoot?: string
	fixturesPath?: string
	/** Golden dev dir for the transition-bigram estimate. */
	goldenDir?: string
	/** Hypotheses kept per input (default 10). */
	k?: number
}

export interface OracleKOutcome {
	exitCode: number
}

const fold = (value: string): string => value.toLowerCase().replace(/\s+/g, " ").trim()
const PUNCTUATION_ONLY = /^[^\p{L}\p{N}]+$/u

/** Smoothed empirical segment-type transition table from gold component orderings. */
export function buildTransitionTable(goldenDir: string): (from: string, to: string) => number {
	const counts = new Map<string, number>()
	const fromTotals = new Map<string, number>()
	const bump = (a: string, b: string): void => {
		counts.set(`${a}→${b}`, (counts.get(`${a}→${b}`) ?? 0) + 1)
		fromTotals.set(a, (fromTotals.get(a) ?? 0) + 1)
	}

	for (const file of TRANSITION_GOLDEN_FILES) {
		let text: string

		try {
			text = readFileSync(`${goldenDir}/${file}`, "utf8")
		} catch {
			continue
		}

		for (const line of text.split("\n")) {
			if (!line.trim()) continue
			const row = JSON.parse(line) as { raw?: string; components?: Record<string, string> }

			if (!row.components || !row.raw) continue
			const folded = fold(row.raw)
			const seq = Object.entries(row.components)
				.map(([tag, value]) => ({ tag, idx: folded.indexOf(fold(String(value))) }))
				.filter((entry) => entry.idx >= 0)
				.sort((a, b) => a.idx - b.idx)
				.map((entry) => entry.tag)

			if (!seq.length) continue
			bump("START", seq[0]!)

			for (let i = 1; i < seq.length; i++) {
				bump(seq[i - 1]!, seq[i]!)
			}
			bump(seq[seq.length - 1]!, "END")
		}
	}

	// add-alpha smoothing over a nominal 40-type vocabulary
	const ALPHA = 0.5

	return (from, to) =>
		Math.log(((counts.get(`${from}→${to}`) ?? 0) + ALPHA) / ((fromTotals.get(from) ?? 0) + ALPHA * 40))
}

interface Hypothesis {
	score: number
	/** Typed segments as [firstWord, lastWordExclusive, type]. */
	segments: Array<[number, number, string]>
}

interface SegmentDecodeResult {
	hypotheses: Hypothesis[]
	/** Word → piece indices. */
	words: number[][]
}

/**
 * K-best segment-level semi-Markov Viterbi over a trace's post-prior emissions. Word-aligned spans (a `▁`-delimited
 * word never splits); pure-punctuation pieces are unit `O` words that no typed segment may cross; `O` words are unit
 * length. State = (word index, last non-O segment type); scores share one normalization per input, so the k hypotheses'
 * scores are directly comparable.
 */
export function segmentDecodeKBest(
	trace: {
		labels: string[]
		emissions: number[][]
		tokens: Array<{ piece: string; start: number; end: number }>
	},
	k: number,
	logTransition: (from: string, to: string) => number
): SegmentDecodeResult {
	const bIndex = new Map<string, number>()
	const iIndex = new Map<string, number>()
	trace.labels.forEach((label, index) => {
		if (label.startsWith("B-")) bIndex.set(label.slice(2), index)
		else if (label.startsWith("I-")) iIndex.set(label.slice(2), index)
	})
	const oIndex = trace.labels.indexOf("O")
	const types = [...bIndex.keys()].filter((type) => iIndex.has(type))

	const logProbs = trace.emissions.map((row) => {
		const max = Math.max(...row)
		const z = Math.log(row.reduce((sum, value) => sum + Math.exp(value - max), 0)) + max

		return row.map((value) => value - z)
	})

	// Group pieces into words; pure-punctuation pieces are their own word.
	const words: number[][] = []
	let current: number[] = []
	const flush = (): void => {
		if (current.length) words.push(current)
		current = []
	}
	trace.tokens.forEach((token, index) => {
		const content = token.piece.startsWith("▁") ? token.piece.slice(1) : token.piece

		if (content.trim() === "") {
			flush()

			return
		}

		if (PUNCTUATION_ONLY.test(content)) {
			flush()
			words.push([index])

			return
		}

		if (token.piece.startsWith("▁")) {
			flush()
			current = [index]
		} else {
			current.push(index)
		}
	})
	flush()
	const isPunctuationWord = words.map(
		(word) => word.length === 1 && PUNCTUATION_ONLY.test(trace.tokens[word[0]!]!.piece.replace(/^▁/, ""))
	)

	const wordCount = words.length
	const spanScore = (from: number, to: number, type: string): number => {
		let score = 0
		let first = true

		for (let w = from; w < to; w++) {
			if (isPunctuationWord[w]) return -Infinity

			for (const pieceIndex of words[w]!) {
				score += logProbs[pieceIndex]![(first ? bIndex : iIndex).get(type)!] ?? -50
				first = false
			}
		}

		return score
	}
	const oScore = (wordIndex: number): number =>
		words[wordIndex]!.reduce((sum, pieceIndex) => sum + (logProbs[pieceIndex]![oIndex] ?? -50), 0)

	type Entry = { score: number; segments: Array<[number, number, string]> }
	const dp: Array<Map<string, Entry[]>> = Array.from({ length: wordCount + 1 }, () => new Map())
	dp[0]!.set("START", [{ score: 0, segments: [] }])
	const push = (column: Map<string, Entry[]>, key: string, entry: Entry): void => {
		const list = column.get(key) ?? []
		list.push(entry)
		list.sort((a, b) => b.score - a.score)

		if (list.length > k) list.length = k
		column.set(key, list)
	}

	for (let i = 0; i < wordCount; i++) {
		for (const [lastType, entries] of dp[i]!) {
			for (const entry of entries) {
				push(dp[i + 1]!, lastType, { score: entry.score + oScore(i), segments: entry.segments })

				if (isPunctuationWord[i]) continue

				for (let j = i + 1; j <= Math.min(wordCount, i + MAX_SEGMENT_WORDS); j++) {
					for (const type of types) {
						const score = spanScore(i, j, type)

						if (score === -Infinity) break
						push(dp[j]!, type, {
							score: entry.score + score + logTransition(lastType, type),
							segments: [...entry.segments, [i, j, type]],
						})
					}

					if (isPunctuationWord[j - 1]) break
				}
			}
		}
	}

	const finals: Hypothesis[] = []

	for (const [lastType, entries] of dp[wordCount]!) {
		for (const entry of entries) {
			finals.push({ score: entry.score + logTransition(lastType, "END"), segments: entry.segments })
		}
	}
	finals.sort((a, b) => b.score - a.score)

	return { hypotheses: finals.slice(0, k), words }
}

/** Concatenate a hypothesis's segment surfaces whose type satisfies the predicate, in position order. */
function extractSurface(
	hypothesis: Hypothesis,
	words: number[][],
	trace: { text: string; tokens: Array<{ start: number; end: number }> },
	matches: (type: string) => boolean
): string {
	return hypothesis.segments
		.filter(([, , type]) => matches(type))
		.sort((a, b) => a[0] - b[0])
		.map(([from, to]) => {
			const firstPiece = words[from]![0]!
			const lastWord = words[to - 1]!

			return trace.text.slice(trace.tokens[firstPiece]!.start, trace.tokens[lastWord[lastWord.length - 1]!]!.end)
		})
		.join(" ")
}

/** Run the oracle-recall@k eval; narrates the per-floor table on stdout. Informational — always exits 0. */
export async function runOracleK(options: OracleKOptions = {}): Promise<OracleKOutcome> {
	const k = options.k ?? 10
	const fixtures = readFileSync(options.fixturesPath ?? PARITY_FIXTURES_PATH, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ParityFixture)
		.filter((fixture) => !fixture.dropped && fixture.expect)

	const logTransition = buildTransitionTable(options.goldenDir ?? "data/eval/golden/v0.1.2/dev")
	const classifier = await NeuralAddressClassifier.loadFromWeights({
		locale: options.locale ?? "en-US",
		cacheRoot: options.weightsCacheRoot,
	})

	const tallies = new Map(
		PARITY_FLOORS.map((floor) => [floor.label, { total: 0, base: 0, top1: 0, oracle5: 0, oracleK: 0 }])
	)

	for (const fixture of fixtures) {
		const tree = await classifier.parse(fixture.input, {
			postcodeRepair: true,
			enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
		})
		const baseByTag = new Map<string, string[]>()
		const stack = [...tree.roots]

		while (stack.length) {
			const node = stack.pop()!
			baseByTag.set(node.tag, [...(baseByTag.get(node.tag) ?? []), node.value])
			stack.push(...node.children)
		}

		const trace = await classifier.traceParse(fixture.input)
		const { hypotheses, words } = segmentDecodeKBest(trace, k, logTransition)

		for (const { label, tags } of PARITY_FLOORS) {
			const goldValues = fixture.expect![label]

			if (!goldValues?.length) continue
			const gold = fold(goldValues.join(" "))
			const tally = tallies.get(label)!
			tally.total++
			const tagSet = new Set<string>(tags)
			const baseActual = tags.flatMap((tag) => baseByTag.get(tag) ?? []).join(" ")

			if (fold(baseActual) === gold) tally.base++
			const surfaces = hypotheses.map((hypothesis) =>
				fold(extractSurface(hypothesis, words, trace, (type) => tagSet.has(type)))
			)

			if (surfaces[0] === gold) tally.top1++

			if (surfaces.slice(0, 5).includes(gold)) tally.oracle5++

			if (surfaces.includes(gold)) tally.oracleK++
		}
	}

	console.log(`oracle-recall@k — k=${k}, ${fixtures.length} live fixtures, segment decode over current emissions`)
	console.log("")
	console.log(`label          n     token@1  seg@1   oracle@5  oracle@${k}`)

	for (const { label } of PARITY_FLOORS) {
		const tally = tallies.get(label)!
		const rate = (value: number): string => (tally.total ? (value / tally.total).toFixed(3) : "—")
		console.log(
			`${label.padEnd(14)} ${String(tally.total).padStart(3)}   ${rate(tally.base).padStart(7)}  ${rate(tally.top1).padStart(6)}  ${rate(tally.oracle5).padStart(8)}  ${rate(tally.oracleK).padStart(8)}`
		)
	}

	return { exitCode: 0 }
}
