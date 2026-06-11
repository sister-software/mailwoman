/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Diagnostic for the Stage 5 joint-reconcile fragmentation bug: `runPipeline("New York City")`
 *   produces `{region: "York", locality: "City"}` while plain argmax produces the correct
 *   `{locality: "New York City"}`. Instruments phrase proposals, classifier top-K, and the
 *   reconcile winner for the three sentinel queries.
 *
 *   Run: node --experimental-strip-types scripts/diag-nyc-reconcile.ts (compile workspaces first:
 *   yarn compile)
 */

import { decodeAsJson } from "@mailwoman/core/decoder"
import { aggregateSpanLogits, reconcileSpans, runPipeline } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier, parseAnchorLookup, parseGazetteerLexicon } from "@mailwoman/neural"
import { OnnxRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { groupPhrases } from "@mailwoman/phrase-grouper"
import { computeQueryShape } from "@mailwoman/query-shape"
import { deserializeFst } from "@mailwoman/resolver-wof-sqlite/fst-serialize"
import { readFileSync } from "node:fs"

const TOKENIZER = "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
const ANCHOR = "/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json"
const GAZ = "data/gazetteer/anchor-lexicon-v1.json"
const MODEL = "/tmp/v130-boundary-40k-int8.onnx"
const FST = "/tmp/v440-stage/en-us/v4.4.0/fst-en-US.bin"
const CARD = "/tmp/v440-stage/en-us/v4.4.0/model-card.json"

const card = JSON.parse(readFileSync(CARD, "utf8"))
const classifier = new NeuralAddressClassifier({
	tokenizer: await MailwomanTokenizer.loadFromFile(TOKENIZER),
	runner: await OnnxRunner.create(MODEL),
	labels: card.labels,
	postcodeAnchorLookup: parseAnchorLookup(JSON.parse(readFileSync(ANCHOR, "utf8"))),
	gazetteerLexicon: parseGazetteerLexicon(JSON.parse(readFileSync(GAZ, "utf8"))),
	suppressGazetteerNearPostcode: true,
	addressSystemConventions: "auto",
	bridgePunctuationGaps: true,
})
const fst = deserializeFst(readFileSync(FST))

const QUERIES = ["New York City", "Brooklyn", "brooklyn, new york, ny"]

for (const q of QUERIES) {
	console.log(`\n================ ${JSON.stringify(q)} ================`)

	// Plain argmax parse
	const argmaxTree = await classifier.parse(q, { queryShape: computeQueryShape(q), fst })
	console.log("argmax:", JSON.stringify(decodeAsJson(argmaxTree)))

	// Pipeline (joint reconcile default-on)
	const result = await runPipeline(q, { computeQueryShape, groupPhrases, classifier, fst })
	console.log("pipeline:", JSON.stringify(decodeAsJson(result.tree)))

	// ── Instrumentation: reproduce the reconcile inputs ──
	const proposals = result.phraseProposals
	console.log("\nphrase proposals:")
	for (const p of proposals) {
		console.log(
			`  [${p.span.start},${p.span.end}) ${JSON.stringify(q.slice(p.span.start, p.span.end))} kind=${p.kindHypothesis} conf=${p.confidence.toFixed(3)}`
		)
	}

	const { logits, pieces } = await classifier.parseWithLogits(q, { queryShape: computeQueryShape(q), fst })
	const topK = aggregateSpanLogits(
		logits,
		pieces,
		proposals.map((p) => ({ start: p.span.start, end: p.span.end })),
		{ labels: card.labels, text: q }
	)
	console.log("\nclassifier top-K per span:")
	for (const c of topK) {
		console.log(
			`  [${c.span.start},${c.span.end}) ${JSON.stringify(q.slice(c.span.start, c.span.end))} ${c.tag}=${c.score.toFixed(4)}`
		)
	}

	const rec = reconcileSpans({ raw: q, phraseProposals: proposals, classifierTopK: topK })
	console.log(
		"\nreconcile winner:",
		JSON.stringify(rec.tree.roots.map((r) => `${r.tag}=${r.value}@${r.confidence.toFixed(3)}`))
	)
	console.log("breakdown:", JSON.stringify(rec.scoreBreakdown))
	console.log("runners-up:", JSON.stringify(rec.runnersUp.map((t) => t.roots.map((r) => `${r.tag}=${r.value}`))))
}
