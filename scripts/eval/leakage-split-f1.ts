/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Leakage-split F1 (#371, DeepSeek 2026-06-07 S39 — "may change everything"). Random OA evaluation
 *   can flatter us: the model trains on the corpus (tiger/BAN/WOF), which COVERS the same
 *   streets/localities that OA tests, so component recall is partly memorization rather than
 *   generalization. The corpus holds out specific geography (`v0.1.0` `splits/SPLIT_MANIFEST.json`:
 *   VT/WY/ND for US, Corse/Lozère/ Creuse for FR). So OA rows in the held-out geography test the
 *   model on places it NEVER trained on, and the gap between in-training F1 and held-out F1 is an
 *   honest estimate of the leakage inflation.
 *
 *   This computes per-tag precision/recall/F1 over OA, split by held-out vs in-training geography,
 *   for the tags OA gold carries ({locality, region, postcode}). A large in-training − held-out gap
 *   means the headline F1 is partly memorization.
 *
 *   Caveat: held-out geography can differ in intrinsic difficulty (rural VT vs urban CA), so a gap is
 *   an upper bound on leakage, not a clean isolation. Reported per-state so the confound is
 *   visible.
 *
 *   Run: node --experimental-strip-types scripts/eval/leakage-split-f1.ts\
 *   --eval data/eval/external/openaddresses-us-sample.jsonl --held VT,WY,ND\
 *   [--model neural-weights-en-us/model.onnx --tokenizer ... --model-card ... --out-md <path>]
 */

import { readFileSync, writeFileSync } from "node:fs"

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)

	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

interface OaRow {
	input: string
	expected: { locality?: string; region?: string; postcode?: string }
	state: string
}

const GRADED = ["locality", "region", "postcode"] as const

function norm(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ")
}

function valueMatch(pred: string, gold: string): boolean {
	const a = norm(pred)
	const b = norm(gold)

	if (!a || !b) return false

	if (a === b) return true
	const aset = new Set(a.split(" "))
	const bset = new Set(b.split(" "))
	const subset = (xs: Set<string>, ys: Set<string>): boolean => [...xs].every((t) => ys.has(t))

	return subset(aset, bset) || subset(bset, aset)
}

function firstByTag(tree: AddressTree, tag: string): AddressNode | undefined {
	let found: AddressNode | undefined
	const walk = (n: AddressNode): void => {
		if (found) return

		if (n.tag === tag) {
			found = n
		} else {
			for (const c of n.children) {
				walk(c)
			}
		}
	}

	for (const r of tree.roots) {
		walk(r)
	}

	return found
}

interface Counts {
	tp: number
	fp: number
	fn: number
}
const newCounts = (): Record<string, Counts> => ({
	locality: { tp: 0, fp: 0, fn: 0 },
	region: { tp: 0, fp: 0, fn: 0 },
	postcode: { tp: 0, fp: 0, fn: 0 },
})

/** Grade one parse against OA's partial gold; accumulate TP/FP/FN per graded tag. */
function grade(tree: AddressTree, expected: OaRow["expected"], acc: Record<string, Counts>): void {
	for (const tag of GRADED) {
		const gold = expected[tag]
		const pred = firstByTag(tree, tag)

		if (gold && pred) {
			if (valueMatch(pred.value, gold)) {
				acc[tag]!.tp++
			} else {
				acc[tag]!.fp++
				acc[tag]!.fn++
			}
		} else if (gold && !pred) {
			acc[tag]!.fn++ // missed a component that's there
		} else if (!gold && pred) {
			acc[tag]!.fp++ // emitted a component OA says isn't there (rare for these tags)
		}
	}
}

function f1(c: Counts): { p: number; r: number; f1: number } {
	const p = c.tp + c.fp ? c.tp / (c.tp + c.fp) : 0
	const r = c.tp + c.fn ? c.tp / (c.tp + c.fn) : 0

	return { p, r, f1: p + r ? (2 * p * r) / (p + r) : 0 }
}

async function main(): Promise<void> {
	const evalPath = arg("eval", "data/eval/external/openaddresses-us-sample.jsonl")
	const held = new Set(
		arg("held", "VT,WY,ND")
			.split(",")
			.map((s) => s.trim().toUpperCase())
	)
	const limit = Number(arg("limit", "0")) || Infinity

	const rows: OaRow[] = readFileSync(evalPath, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l))
		.slice(0, limit === Infinity ? undefined : limit)

	const { NeuralAddressClassifier } = await import("@mailwoman/neural")
	const { ONNXRunner } = await import("@mailwoman/neural/onnx-runner")
	const { MailwomanTokenizer } = await import("@mailwoman/neural/tokenizer")
	const modelCard = JSON.parse(readFileSync(arg("model-card", "neural-weights-en-us/model-card.json"), "utf8"))
	const [tokenizer, runner] = await Promise.all([
		MailwomanTokenizer.loadFromFile(arg("tokenizer", "neural-weights-en-us/tokenizer.model")),
		ONNXRunner.create(arg("model", "neural-weights-en-us/model.onnx")),
	])
	const neural = new NeuralAddressClassifier({ tokenizer, runner, labels: modelCard.labels })
	const parseOpts = { postcodeRepair: true } as Parameters<typeof neural.parse>[1]

	const heldAcc = newCounts()
	const inAcc = newCounts()
	const perState: Record<string, Record<string, Counts>> = {}
	let heldN = 0
	let inN = 0
	let i = 0

	for (const row of rows) {
		i++

		if (i % 1000 === 0) {
			console.error(`  ${i}/${rows.length}`)
		}
		let tree: AddressTree

		try {
			tree = await neural.parse(row.input, parseOpts)
		} catch {
			continue
		}
		const st = (row.state || "??").toUpperCase()
		const isHeld = held.has(st)
		grade(tree, row.expected, isHeld ? heldAcc : inAcc)

		if (!perState[st]) {
			perState[st] = newCounts()
		}
		grade(tree, row.expected, perState[st]!)

		if (isHeld) {
			heldN++
		} else {
			inN++
		}
	}

	const macro = (acc: Record<string, Counts>): number => GRADED.reduce((s, t) => s + f1(acc[t]!).f1, 0) / GRADED.length

	const lines: string[] = []
	lines.push(`# Leakage-split F1 — ${evalPath.split("/").pop()}`)
	lines.push("")
	lines.push(
		`Per-tag F1 split by corpus-held-out geography (${[...held].join("/")}) vs in-training geography. ` +
			`A large in-training − held-out gap = the headline F1 is partly memorization (#371).`
	)
	lines.push("")
	lines.push(
		`- held-out rows: ${heldN} · in-training rows: ${inN} · model: ${arg("model", "neural-weights-en-us/model.onnx")}`
	)
	lines.push("")
	lines.push("| tag | held-out F1 | in-training F1 | gap (in − held) |")
	lines.push("| --- | ---: | ---: | ---: |")

	for (const t of GRADED) {
		const h = f1(heldAcc[t]!).f1
		const inF = f1(inAcc[t]!).f1
		lines.push(`| ${t} | ${h.toFixed(3)} | ${inF.toFixed(3)} | ${(inF - h >= 0 ? "+" : "") + (inF - h).toFixed(3)} |`)
	}
	lines.push(
		`| **macro** | **${macro(heldAcc).toFixed(3)}** | **${macro(inAcc).toFixed(3)}** | **${(macro(inAcc) - macro(heldAcc) >= 0 ? "+" : "") + (macro(inAcc) - macro(heldAcc)).toFixed(3)}** |`
	)
	lines.push("")
	lines.push("## Per-state macro-F1 (difficulty confound check)")
	lines.push("")
	lines.push("| state | n | macro-F1 | held-out? |")
	lines.push("| --- | ---: | ---: | --- |")
	const stateRows = Object.entries(perState)
		.map(([st, acc]) => {
			const n = GRADED.reduce((s, t) => s + acc[t]!.tp + acc[t]!.fn, 0)

			return { st, n, m: macro(acc), held: held.has(st) }
		})
		.sort((a, b) => a.m - b.m)

	for (const s of stateRows) {
		lines.push(`| ${s.st} | ${s.n} | ${s.m.toFixed(3)} | ${s.held ? "✅ held-out" : ""} |`)
	}
	lines.push("")

	const out = lines.join("\n") + "\n"
	const outMd = arg("out-md")

	if (outMd) {
		writeFileSync(outMd, out)
		console.error(`wrote → ${outMd}`)
	} else {
		console.log(out)
	}
	console.error(
		`\nmacro-F1 held-out ${macro(heldAcc).toFixed(3)} vs in-training ${macro(inAcc).toFixed(3)} (gap ${(macro(inAcc) - macro(heldAcc)).toFixed(3)})`
	)
}

void main()
