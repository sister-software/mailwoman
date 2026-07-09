/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node-side WASM latency probe for the browser runtime (#293/#378). Loads a model through
 *   `WebONNXRunner` on onnxruntime-web's WASM execution provider — the same EP the demo falls back
 *   to without WebGPU — and measures per-parse latency (p50/p95) plus session-load time over a
 *   fixed prompt set. This is NOT the in-browser P95 SLO number (#378 wants real Chrome on real
 *   hardware); it is the closest CPU-only proxy available without a browser: same WASM binary, same
 *   graph, Node's V8 instead of Chrome's.
 *
 *   Usage:
 *     node scripts/eval/wasm-latency-probe.ts \
 *       --model out/bsplice-meaninit-int8/model.onnx \
 *       --tokenizer /path/to/tokenizer.model \
 *       --golden data/eval/external/oa-cz-coord-1k.jsonl --n 200 --label bsplice-int8
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

import { MailwomanTokenizer, NeuralAddressClassifier } from "@mailwoman/neural"
import { WebONNXRunner } from "@mailwoman/neural-web"
// Same module instance the runner imports — Node can't spawn ORT's threaded worker (it arrives as
// a blob: URL the ESM loader refuses), so force the single-threaded WASM path before any session
// is created. Browsers keep the threaded path; this cost is Node-only and makes the probe a
// conservative (slower-than-browser) bound.
import * as ort from "onnxruntime-web/webgpu"

ort.env.wasm.numThreads = 1
ort.env.wasm.proxy = false

const { values } = parseArgs({
	options: {
		model: { type: "string" },
		tokenizer: { type: "string" },
		golden: { type: "string" },
		"model-card": { type: "string", default: "neural-weights-en-us/model-card.json" },
		n: { type: "string", default: "200" },
		warmup: { type: "string", default: "10" },
		label: { type: "string", default: "probe" },
		// The onnxruntime-web dist directory holding the WASM glue (.jsep.mjs) + binary (.jsep.wasm).
		// In Node they must load as file: URLs (the ESM loader refuses http:/blob:, and fetch() the
		// package-internal default) — set per-file via ort.env.wasm.wasmPaths below.
		"wasm-dist": { type: "string", default: "node_modules/onnxruntime-web/dist" },
	},
})

if (!values.model || !values.tokenizer || !values.golden) {
	console.error("usage: wasm-latency-probe.ts --model <onnx> --tokenizer <model> --golden <jsonl> [--n 200]")
	process.exit(2)
}

const n = Number(values.n)
const warmup = Number(values.warmup)
const raws: string[] = readFileSync(values.golden, "utf8")
	.trim()
	.split("\n")
	.filter(Boolean)
	.map((l) => (JSON.parse(l) as { raw: string }).raw)

const modelBytes = new Uint8Array(readFileSync(values.model))
const t0 = performance.now()
ort.env.wasm.wasmPaths = {
	mjs: pathToFileURL(join(values["wasm-dist"]!, "ort-wasm-simd-threaded.jsep.mjs")).href,
	wasm: pathToFileURL(join(values["wasm-dist"]!, "ort-wasm-simd-threaded.jsep.wasm")).href,
}

const [tokenizer, runner] = await Promise.all([
	MailwomanTokenizer.loadFromFile(values.tokenizer),
	WebONNXRunner.fromBytes(modelBytes, { useWebGPU: false }),
])
const loadMs = performance.now() - t0
const labels = (JSON.parse(readFileSync(values["model-card"]!, "utf8")) as { labels: string[] }).labels
const classifier = new NeuralAddressClassifier({ tokenizer, runner, labels })

for (let i = 0; i < warmup; i++) {
	await classifier.parse(raws[i % raws.length]!)
}

const samples: number[] = []

for (let i = 0; i < n; i++) {
	const raw = raws[i % raws.length]!
	const s = performance.now()

	await classifier.parse(raw)
	samples.push(performance.now() - s)
}
samples.sort((a, b) => a - b)
const pct = (p: number) => samples[Math.min(samples.length - 1, Math.floor((p / 100) * samples.length))]!

console.log(
	JSON.stringify(
		{
			label: values.label,
			model: values.model,
			model_bytes: modelBytes.length,
			load_ms: Math.round(loadMs),
			n,
			parse_ms_p50: Number(pct(50).toFixed(2)),
			parse_ms_p90: Number(pct(90).toFixed(2)),
			parse_ms_p95: Number(pct(95).toFixed(2)),
			parse_ms_max: Number(samples[samples.length - 1]!.toFixed(2)),
		},
		null,
		2
	)
)
