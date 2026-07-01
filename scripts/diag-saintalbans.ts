import { createWOFResolver } from "@mailwoman/resolver"
import { type ClassificationRecord, createAddressParser } from "mailwoman"
import { readFileSync } from "node:fs"

const TOK = "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
const MODEL = "/tmp/v072-eval/model.onnx"
const CARD = "/tmp/v072-release/model-card.json"
const WOF = [
	"/mnt/playpen/mailwoman-data/wof/admin-global-priority.db",
	"/mnt/playpen/mailwoman-data/wof/postalcode-us.db",
]

const { NeuralAddressClassifier } = await import("@mailwoman/neural")
const { ONNXRunner } = await import("@mailwoman/neural/onnx-runner")
const { MailwomanTokenizer } = await import("@mailwoman/neural/tokenizer")
const modelCard = JSON.parse(readFileSync(CARD, "utf8"))
const [tokenizer, runner] = await Promise.all([MailwomanTokenizer.loadFromFile(TOK), ONNXRunner.create(MODEL)])
const neural = new NeuralAddressClassifier({ tokenizer, runner, labels: modelCard.labels })
const neuralArgmax = new NeuralAddressClassifier({
	tokenizer,
	runner,
	labels: modelCard.labels,
	decode: "argmax",
} as any)
const v0 = createAddressParser()

const { WOFSqlitePlaceLookup } = await import("@mailwoman/resolver-wof-sqlite")
const backend = new WOFSqlitePlaceLookup({ databasePath: WOF })
const resolver = createWOFResolver(backend as never)

function dumpTree(label: string, tree: any) {
	const flat: string[] = []
	const walk = (n: any) => {
		if (n?.tag && n?.value) flat.push(`${n.tag}=${JSON.stringify(n.value)}`)
		for (const c of n?.children ?? []) walk(c)
	}
	for (const r of tree?.roots ?? []) walk(r)
	console.log(`  ${label} tags: ${flat.join("  ") || "(none)"}`)
}

function dumpResolved(label: string, tree: any) {
	const out: string[] = []
	const walk = (n: any) => {
		if (n?.placeId?.startsWith?.("wof:")) {
			const meta = n.metadata as Record<string, unknown> | undefined
			const pt = String(n.sourceId ?? "").split(":")[0]
			out.push(`${pt}:${meta?.["resolver_name"] ?? n.value}(${n.placeId})`)
		}
		for (const c of n?.children ?? []) walk(c)
	}
	for (const r of tree?.roots ?? []) walk(r)
	console.log(`  ${label} resolved: ${out.join("  ") || "(none)"}`)
}

const inputs = [
	// bare "locality, ST"
	"Saint Paul, MN",
	"Belle Fourche, SD",
	"Fort Pierre, SD",
	// SAME localities in a FULL address (house + street + zip)
	"123 Main Street, Saint Paul, MN 55101",
	"512 State Street, Belle Fourche, SD 57717",
	"200 Deadwood Street, Fort Pierre, SD 57532",
	"22 Brigham Rd, Saint Albans, VT 05478",
]
for (const input of inputs) {
	console.log(`\n=== ${input} ===`)
	const nTree = await neural.parse(input, { postcodeRepair: true } as any)
	dumpTree("neural(viterbi)", nTree)
	dumpTree("neural(argmax) ", await neuralArgmax.parse(input, { postcodeRepair: true } as any))
	dumpResolved("neural", await resolver.resolveTree(nTree, { defaultCountry: "US" }))

	const sol = await v0.parse(input)
	const rec = (sol[0]?.classifications ?? {}) as ClassificationRecord
	console.log(
		`  v0 tags: ${Object.entries(rec)
			.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
			.join("  ")}`
	)
}
process.exit(0)
