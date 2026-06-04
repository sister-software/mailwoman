/**
 * Japan parse-look (probe, 2026-06-05). Part 2 of the JP cheap probe: does the CURRENT universal
 * parser (v0.7.2, US+FR trained, OOD on Japanese) produce a usable component breakdown for a
 * STREET-LESS, block-coordinate, descending-order Japanese address?
 *
 * Dumps raw per-token BIO (the honest coverage view — argmax, no tree post-processing) plus the
 * assembled component tree, for native-kanji, romaji, Sapporo-grid, and Kyoto intersection forms.
 * No resolver (no JP postcode db yet); this is purely "what does the model label." Run: node
 * --experimental-strip-types scripts/diag-japan-parse.ts
 */
import { type ClassificationRecord, createAddressParser } from "mailwoman"
import { readFileSync } from "node:fs"

const TOK = "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
const MODEL = "/tmp/v072-eval/model.onnx"
const CARD = "/tmp/v072-release/model-card.json"

const { NeuralAddressClassifier } = await import("@mailwoman/neural")
const { OnnxRunner } = await import("@mailwoman/neural/onnx-runner")
const { MailwomanTokenizer } = await import("@mailwoman/neural/tokenizer")
const modelCard = JSON.parse(readFileSync(CARD, "utf8"))
const labels: string[] = modelCard.labels
const [tokenizer, runner] = await Promise.all([MailwomanTokenizer.loadFromFile(TOK), OnnxRunner.create(MODEL)])
const neural = new NeuralAddressClassifier({ tokenizer, runner, labels })
const v0 = createAddressParser()

function argmax(row: number[]): number {
	let bi = 0
	for (let i = 1; i < row.length; i++) if (row[i]! > row[bi]!) bi = i
	return bi
}

// Raw per-token BIO straight from the model — no tree, no repair. This is the coverage truth.
async function rawBio(text: string): Promise<string> {
	const { pieces, ids } = tokenizer.encode(text)
	const { logits } = await runner.infer(ids)
	return pieces
		.map((p: any, i: number) => {
			const lab = labels[argmax(logits[i]!)] ?? "O"
			return lab === "O" ? `${p.piece}·O` : `${p.piece}·${lab}`
		})
		.join("  ")
}

function dumpTree(tree: any): string {
	const flat: string[] = []
	const walk = (n: any) => {
		if (n?.tag && n?.value) flat.push(`${n.tag}=${JSON.stringify(n.value)}`)
		for (const c of n?.children ?? []) walk(c)
	}
	for (const r of tree?.roots ?? []) walk(r)
	return flat.join("  ") || "(none)"
}

const inputs: Array<{ label: string; text: string }> = [
	{ label: "Tokyo, kanji native", text: "東京都中央区銀座1-1-1" },
	{ label: "Tokyo, w/ postcode", text: "〒104-0061 東京都中央区銀座1丁目1番1号" },
	{ label: "Tokyo, romaji", text: "1-1-1 Ginza, Chuo-ku, Tokyo 104-0061" },
	{ label: "Sapporo GRID, kanji", text: "北海道札幌市中央区北1条西2丁目" },
	{ label: "Sapporo GRID, w/ pc", text: "〒060-0001 北海道札幌市中央区北1条西2丁目1-1" },
	{ label: "Sapporo GRID, romaji", text: "Kita 1-jo Nishi 2-chome, Chuo-ku, Sapporo, Hokkaido 060-0001" },
	{ label: "Kyoto intersection", text: "京都府京都市中京区寺町通御池上る上本能寺前町488" },
	{ label: "Gov bldg, kanji", text: "〒163-8001 東京都新宿区西新宿2-8-1" },
]

for (const { label, text } of inputs) {
	console.log(`\n=== ${label} ===`)
	console.log(`  input: ${text}`)
	console.log(`  raw BIO : ${await rawBio(text)}`)
	console.log(`  tree    : ${dumpTree(await neural.parse(text, { postcodeRepair: true } as any))}`)
	const sol = await v0.parse(text)
	const rec = (sol[0]?.classifications ?? {}) as ClassificationRecord
	console.log(
		`  v0      : ${
			Object.entries(rec)
				.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
				.join("  ") || "(none)"
		}`
	)
}
process.exit(0)
