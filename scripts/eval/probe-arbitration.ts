/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #478 leg-2 diagnosis: trace the arbitration path stage-by-stage on a handful of clean US addresses
 *   to find WHERE street/house_number is dropped (the precondition 100→48% regression). Replicates
 *   exactly what `runPipeline`'s `arbitrate` block does: route → neural proposals ∪ solved-v0 proposals
 *   → policy registry → coherence pass → (would-be) proposalsToTree.
 *
 *   Run: node --experimental-strip-types scripts/eval/probe-arbitration.ts
 */

import { proposalsToTree, resolveProposalOverlaps, treeToProposals } from "@mailwoman/core/decoder"
import { solutionToProposals } from "@mailwoman/core/parser"
import { policyRegistryFromRoute, routeInputShape } from "@mailwoman/core/policy"
import type { ClassificationProposal } from "@mailwoman/core/types"
import { classifyKind } from "@mailwoman/kind-classifier"
import { detectLocale } from "@mailwoman/locale-gate"
import { normalize } from "@mailwoman/normalize"
import { computeQueryShape } from "@mailwoman/query-shape"
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

const N = Number(process.env.PROBE_N ?? "0")
const inputs = N
	? readFileSync("data/eval/external/openaddresses-us-sample.jsonl", "utf8")
			.split("\n")
			.filter((l) => l.trim())
			.slice(0, N)
			.map((l) => JSON.parse(l).input as string)
	: [
			"109 Seminary Dr, Mill Valley, CA 94941",
			"5210 South Ingleside Avenue, Chicago, IL 60615",
			"2631 Moreland Place Nw, Washington, DC 20015",
			"350 5th Ave, New York, NY 10118",
		]

let nStreetDropped = 0
let nLocChanged = 0
let nRegChanged = 0
let nStreetDroppedBySuffix = 0
const verbose = !N

const fmt = (ps: readonly ClassificationProposal[]): string =>
	ps.length === 0
		? "(none)"
		: ps
				.map((p) => `${p.component}[${p.span.start},${p.span.end}]"${p.span.body}"·${p.source}·${p.confidence.toFixed(2)}`)
				.join("  ")

for (const input of inputs) {
	const norm = normalize(input)
	const shape = computeQueryShape(norm)
	const locale = await detectLocale(norm, shape, { hint: "en-US" })
	const kind = await classifyKind(norm, shape, locale)
	const route = routeInputShape(
		{ kind: kind.kind, confidence: kind.confidence },
		{ characterClass: shape.characterClass },
		null
	)

	const nTree = await neural.parse(norm.normalized, { queryShape: shape as never, postcodeRepair: true })
	const nProps = treeToProposals(nTree, "neural")
	const sols = await v0.parse(norm.normalized)
	const rProps = sols[0] ? solutionToProposals(sols[0]!, "v0-rules") : []

	const arbitrated = policyRegistryFromRoute(route).apply([...nProps, ...rProps], locale.locale)
	const coherent = resolveProposalOverlaps(arbitrated)
	const finalTree = proposalsToTree(norm.normalized, coherent)

	const has = (ps: readonly ClassificationProposal[], tag: string) => ps.some((p) => p.component === tag)
	const val = (ps: readonly ClassificationProposal[], tag: string) => ps.find((p) => p.component === tag)?.span.body

	// Did arbitration drop street that the neural parse HAD? And was it evicted by an overlapping suffix/prefix?
	const neuralHadStreet = has(nProps, "street")
	const finalHasStreet = has(coherent, "street")
	const arbHadStreet = has(arbitrated, "street")
	if (neuralHadStreet && !finalHasStreet) {
		nStreetDropped++
		if (arbHadStreet) nStreetDroppedBySuffix++ // present after arbitration, gone after coherence = overlap eviction
	}
	if (val(nProps, "locality") !== val(coherent, "locality")) nLocChanged++
	if (val(nProps, "region") !== val(coherent, "region")) nRegChanged++

	if (verbose) {
		console.log(`\n=== ${input}`)
		console.log(`route:  ${route.defaultMode} (${route.reason}) | kind=${kind.kind}@${kind.confidence.toFixed(2)} cc=${shape.characterClass}`)
		console.log(`neural: ${fmt(nProps)}`)
		console.log(`rule:   ${fmt(rProps)}`)
		console.log(`arb:    ${fmt(arbitrated)}`)
		console.log(`cohere: ${fmt(coherent)}`)
		console.log(
			`FINAL precond: street=${finalHasStreet} house_number=${has(coherent, "house_number")} | locality=${has(coherent, "locality")} region=${has(coherent, "region")} | roots=${finalTree.roots.length}`
		)
	} else if (neuralHadStreet && !finalHasStreet) {
		console.log(`STREET DROPPED: "${input}" — arb-had-street=${arbHadStreet} | cohere: ${fmt(coherent)}`)
	}
}

if (N) {
	console.log(`\n=== AGGREGATE over ${inputs.length} rows ===`)
	console.log(`street dropped (neural had, final lacks): ${nStreetDropped}/${inputs.length}`)
	console.log(`  └ of which evicted by overlap in coherence pass: ${nStreetDroppedBySuffix}`)
	console.log(`locality value changed vs neural: ${nLocChanged}/${inputs.length}`)
	console.log(`region value changed vs neural: ${nRegChanged}/${inputs.length}`)
}
