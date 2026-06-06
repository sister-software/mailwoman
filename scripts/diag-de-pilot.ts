import { readFileSync } from "node:fs"

const TOK = "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
const { NeuralAddressClassifier } = await import("@mailwoman/neural")
const { OnnxRunner } = await import("@mailwoman/neural/onnx-runner")
const { MailwomanTokenizer } = await import("@mailwoman/neural/tokenizer")

async function load(model: string, card: string) {
	const modelCard = JSON.parse(readFileSync(card, "utf8"))
	const [tokenizer, runner] = await Promise.all([
		MailwomanTokenizer.loadFromFile(TOK),
		OnnxRunner.create(model),
	])
	return new NeuralAddressClassifier({ tokenizer, runner, labels: modelCard.labels })
}

const pilot = await load("/tmp/pilot-eval/model.onnx", "/tmp/pilot-eval/model-card.json")
const v072 = await load("/tmp/v072-eval/model.onnx", "/tmp/v072-eval/model-card.json")

function flat(tree: any): string {
	const out: string[] = []
	const walk = (n: any) => {
		if (n?.tag && n?.value) out.push(`${n.tag}=${JSON.stringify(n.value)}`)
		for (const c of n?.children ?? []) walk(c)
	}
	for (const r of tree?.roots ?? []) walk(r)
	return out.join("  ") || "(none)"
}

// Real German golden rows (Berlin/Saxony order: street house, [postcode] city).
const inputs = [
	"Davoser Straße 22 A, Berlin",
	"Karl-Liebknecht-Straße 12, 10178 Berlin",
	"Prager Straße 8, 01069 Dresden",
	"Straußstraße 5, Leipzig",
	"Bautzner Straße 101, 01099 Dresden",
	"Unter den Linden 77, 10117 Berlin",
]
for (const input of inputs) {
	console.log(`\n=== ${input} ===`)
	console.log(`  pilot: ${flat(await pilot.parse(input, { postcodeRepair: true } as any))}`)
	console.log(`  v072 : ${flat(await v072.parse(input, { postcodeRepair: true } as any))}`)
}
process.exit(0)
