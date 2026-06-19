/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Blog/diagnostic helper: parse a curated address list through BOTH v0 (the Pelias-port rules
 *   parser) and the neural classifier, print the decoded component maps side by side. Surfaces the
 *   concrete "where each one wins / they differ" examples for the state-of-affairs post.
 *
 *   Run: node --experimental-strip-types scripts/eval/compare-parsers.ts
 */

import { decodeAsJson, proposalsToTree } from "@mailwoman/core/decoder"
import { solutionToProposals } from "@mailwoman/core/parser"
import { createAddressParser } from "mailwoman"
import { readFileSync } from "node:fs"

const MODEL = "/mnt/playpen/mailwoman-data/models/quantized/model-v140-step-40000-int8.onnx"
const TOK = "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
const CARD = "neural-weights-en-us/model-card.json"

const { NeuralAddressClassifier } = await import("@mailwoman/neural")
const { OnnxRunner } = await import("@mailwoman/neural/onnx-runner")
const { MailwomanTokenizer } = await import("@mailwoman/neural/tokenizer")
const card = JSON.parse(readFileSync(CARD, "utf8"))
const [tokenizer, runner] = await Promise.all([MailwomanTokenizer.loadFromFile(TOK), OnnxRunner.create(MODEL)])
const neural = new NeuralAddressClassifier({ tokenizer, runner, labels: card.labels })
const v0 = createAddressParser()

const inputs = [
	"350 5th Ave, New York, NY 10118",
	"109 Seminary Dr, Mill Valley, CA 94941",
	"1600 Pennsylvania Ave NW Apt 4B, Washington, DC 20500",
	"2125 Hearst Ave Unit 12, Berkeley, CA 94709",
	"PO Box 1207, Anchorage, AK 99510",
	"5th & Main, Springfield, IL",
	"221B Baker Street, London",
]

const fmt = (rec: Record<string, unknown>) =>
	Object.keys(rec).length === 0
		? "(empty)"
		: Object.entries(rec)
				.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : v}`)
				.join("  ")

for (const input of inputs) {
	const sols = await v0.parse(input)
	const v0Rec = sols[0] ? decodeAsJson(proposalsToTree(input, solutionToProposals(sols[0]!))) : {}
	const nTree = await neural.parse(input, { postcodeRepair: true })
	const nRec = decodeAsJson(nTree)
	console.log(`\n=== ${input}`)
	console.log(`  v0    : ${fmt(v0Rec as Record<string, unknown>)}`)
	console.log(`  neural: ${fmt(nRec as Record<string, unknown>)}`)
}
