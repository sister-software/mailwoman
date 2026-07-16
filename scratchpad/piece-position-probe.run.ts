import { readFileSync } from "node:fs"

/**
 * Track B: does the model condition its digit-piece labels on RUN LENGTH, or on the marginal?
 *
 * `piece_prior` (Modal) measured what the CORPUS teaches, per piece, through the real encoder:
 *
 * Digit run P(cont -> house_number) P(cont -> postcode) 2 digits 0.7711 0.0427 3 digits 0.6858 0.0477 5 digits 0.0926
 * 0.8792 marginal 0.2609 0.6623 <- 5d runs supply 55.6% of all continuations
 *
 * The sub-agent's per-piece probe found the model emitting `I-postcode` at 0.587-0.765 on a 2-digit run. That is the
 * MARGINAL (0.6623), not the 2-digit CONDITIONAL (0.0427). If that holds at scale, the mechanism is: the model learned
 * the length-marginal continuation prior, and the marginal is postcode-dominated only because postcodes are long and
 * per-character digit tokenization mints one continuation label per extra digit.
 *
 * But that inference rests on two hand-read rows. This measures it over the whole parity corpus: for every digit run,
 * bin the model's per-piece posterior by (run length, position in run) and compare against the corpus table above.
 *
 * PRE-REGISTERED READ (written before the numbers exist): CONFIRM : on 2-3 digit runs, model P(postcode | continuation)
 * tracks the MARGINAL (~0.66), far above the conditional (~0.04). The gap conditional-vs-model is the defect. REFUTE :
 * model P(postcode | continuation) on 2-3 digit runs is near 0.04 — it DOES condition, and the failing rows are
 * something else (rare-token/OOD, not a prior). SPLIT : starts track the conditional while continuations track the
 * marginal — the model conditions where the street context is adjacent and stops once it is inside a run.
 *
 * Package-shaped on purpose (#718): an explicit --model grades a channel-starved model.
 */
import { decodeAsTuples } from "@mailwoman/core/decoder"
import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { computeQueryShape } from "@mailwoman/query-shape"

const PARITY = "mailwoman/eval-harness/fixtures/parity-corpus.jsonl"

interface Cell {
	n: number
	pc: number
	hn: number
	pcMass: number
	hnMass: number
}

const key = (len: number, pos: "start" | "cont", arm: string) => `${len}:${pos}:${arm}`
const cells = new Map<string, Cell>()

function bump(len: number, pos: "start" | "cont", pPc: number, pHn: number, argmax: string, arm: string) {
	const k = key(len, pos, arm)
	let c = cells.get(k)
	if (!c) {
		c = { n: 0, pc: 0, hn: 0, pcMass: 0, hnMass: 0 }
		cells.set(k, c)
	}
	c.n++
	c.pcMass += pPc
	c.hnMass += pHn
	if (argmax.endsWith("postcode")) c.pc++
	if (argmax.endsWith("house_number")) c.hn++
}

const softmax = (row: number[]) => {
	const m = Math.max(...row)
	const ex = row.map((v) => Math.exp(v - m))
	const s = ex.reduce((a, b) => a + b, 0)

	return ex.map((v) => v / s)
}

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-us" })

const lines = readFileSync(PARITY, "utf8").trim().split("\n")
let rows = 0

for (const line of lines) {
	const fixture = JSON.parse(line) as { input: string; expect?: Record<string, string[]> }
	if (!fixture.input) continue
	const shape = computeQueryShape(fixture.input)
	const trace = await classifier.traceParse(fixture.input, { queryShape: shape })
	rows++

	// The arm: did this row emit a postcode the gold does not have? That is the precision half —
	// the exact defect Track B is chasing — so it is the split that matters.
	// `parse` returns an AddressTree, NOT a flat record: read it with `decodeAsTuples`, the same
	// extractor parity-corpus.ts uses, under the same ship-config knobs. A different parse here
	// would make the arm an artifact of the probe rather than the defect.
	const tuples = decodeAsTuples(
		await classifier.parse(fixture.input, {
			postcodeRepair: true,
			queryShape: shape,
			enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
		})
	)
	const goldPc = fixture.expect?.postcode?.length ? true : false
	const gotPc = tuples.some(([tag]) => tag === "postcode")
	const arm = !goldPc && gotPc ? "SPURIOUS-PC" : "ok"

	const { pieces, logits, labels } = trace
	const idxPc = labels.findIndex((l) => l === "B-postcode")
	const idxIpc = labels.findIndex((l) => l === "I-postcode")
	const idxHn = labels.findIndex((l) => l === "B-house_number")
	const idxIhn = labels.findIndex((l) => l === "I-house_number")

	// Walk maximal runs of digit-bearing pieces — the same unit `piece_prior` counts on the
	// corpus side, so the two tables are comparable.
	let i = 0
	while (i < pieces.length) {
		const hasDigit = (p: { piece: string }) => /\d/.test(p.piece)
		if (!hasDigit(pieces[i]!)) {
			i++
			continue
		}
		let j = i
		while (j < pieces.length && hasDigit(pieces[j]!)) j++

		const run = pieces.slice(i, j)
		const nDigits = run.reduce((a, p) => a + (p.piece.match(/\d/g)?.length ?? 0), 0)

		for (let k = i; k < j; k++) {
			const probs = softmax(logits[k]!)
			const pos = k === i ? "start" : "cont"
			// At a start piece the competition is B-pc vs B-hn; inside a run it is I-pc vs I-hn.
			const pPc = pos === "start" ? (probs[idxPc] ?? 0) : (probs[idxIpc] ?? 0)
			const pHn = pos === "start" ? (probs[idxHn] ?? 0) : (probs[idxIhn] ?? 0)
			const argmax = labels[probs.indexOf(Math.max(...probs))] ?? "?"
			bump(nDigits, pos, pPc, pHn, argmax, arm)
		}
		i = j
	}
}

console.log(`rows: ${rows}\n`)
console.log("MODEL, per digit-run length x position (parity corpus, production config)")
console.log("  corpus reference (piece_prior, 200k rows, the real encoder):")
console.log("    2d cont -> hn 0.7711 / pc 0.0427   |   3d cont -> hn 0.6858 / pc 0.0477")
console.log("    5d cont -> hn 0.0926 / pc 0.8792   |   MARGINAL cont -> hn 0.2609 / pc 0.6623\n")
console.log(
	`  ${"len".padStart(4)} ${"pos".padStart(6)} ${"n".padStart(7)}   ${"argmax:pc".padStart(10)} ${"argmax:hn".padStart(10)}   ${"meanP(pc)".padStart(10)} ${"meanP(hn)".padStart(10)}`
)
for (const arm of ["ok", "SPURIOUS-PC"]) {
	console.log(`\n  === arm: ${arm} ===`)
	for (const len of [...new Set([...cells.keys()].map((k) => Number(k.split(":")[0])))].sort((a, b) => a - b)) {
		for (const pos of ["start", "cont"] as const) {
			const c = cells.get(key(len, pos, arm))
			if (!c || c.n < 5) continue
			console.log(
				`  ${String(len).padStart(4)} ${pos.padStart(6)} ${String(c.n).padStart(7)}   ` +
					`${(c.pc / c.n).toFixed(4).padStart(10)} ${(c.hn / c.n).toFixed(4).padStart(10)}   ` +
					`${(c.pcMass / c.n).toFixed(4).padStart(10)} ${(c.hnMass / c.n).toFixed(4).padStart(10)}`
			)
		}
	}
}
