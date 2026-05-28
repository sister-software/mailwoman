/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Browser-side loader that pairs the existing `MailwomanTokenizer` (whose `loadFromBase64` path is
 *   already browser-safe — it doesn't touch Node fs) with a fresh `WebOnnxRunner`, and returns a
 *   ready-to-use `NeuralAddressClassifier`.
 *
 *   V1 strategy: fetch both `model.onnx` and `tokenizer.model` over HTTP from caller-provided URLs
 *   (typically pointing at the same static-asset bundle that ships the resolver's slim WOF DB). The
 *   neural weights package `@mailwoman/neural-weights-en-us` is the canonical source of those two
 *   files; for a static deploy, copy them into the public bundle and pass the resulting URLs.
 */

import { MailwomanTokenizer, NeuralAddressClassifier } from "@mailwoman/neural/browser"

import { WebOnnxRunner, type WebOnnxRunnerDiagnostics, type WebOnnxRunnerOpts } from "./web-onnx-runner.js"

export type { WebOnnxRunnerDiagnostics }

export interface LoadResult {
	classifier: NeuralAddressClassifier
	diagnostics: WebOnnxRunnerDiagnostics | null
	/**
	 * Labels actually applied to the classifier. `null` when no model-card was provided or its
	 * `labels` field was missing — the classifier fell back to its built-in default (Stage 2).
	 */
	labels: readonly string[] | null
}

export interface LoadFromUrlsOpts {
	/** URL to the ONNX model file (e.g. `/static/mailwoman/model.onnx`). */
	modelUrl: string
	/** URL to the SentencePiece tokenizer model (e.g. `/static/mailwoman/tokenizer.model`). */
	tokenizerUrl: string
	/**
	 * URL to `model-card.json`. When provided, its `labels` field is threaded into the classifier so
	 * post-Stage-2 bundles (33-label Stage 3 and beyond) decode correctly. Skip for legacy bundles
	 * whose cards predate the `labels` field — the loader falls back to the built-in Stage 2
	 * default.
	 *
	 * Required for any v0.6.x+ bundle: without it the classifier builds a 21×21 transition mask while
	 * the model emits 33 logits and viterbi crashes with "Cannot read properties of undefined".
	 */
	modelCardUrl?: string
	/** Runner options (WebGPU toggle, fixed sequence length, WASM path override). */
	runner?: WebOnnxRunnerOpts
	/** Optional fetch override. Defaults to `globalThis.fetch`. */
	fetchImpl?: typeof fetch
}

/**
 * Convenience factory: fetch model + tokenizer, build the runner, return a classifier. The
 * tokenizer is loaded via the existing `loadFromBase64` path so this file shares zero Node-only
 * code with `@mailwoman/neural/classifier`'s `loadFromWeights`.
 */
export async function loadNeuralClassifierFromUrls(opts: LoadFromUrlsOpts): Promise<LoadResult> {
	const fetchImpl = opts.fetchImpl ?? globalThis.fetch
	if (!fetchImpl) {
		throw new Error("no fetch implementation available — pass fetchImpl in non-fetch environments")
	}

	const [modelBytes, tokenizerBytes, labels] = await Promise.all([
		fetchBytes(opts.modelUrl, fetchImpl),
		fetchBytes(opts.tokenizerUrl, fetchImpl),
		opts.modelCardUrl ? fetchLabelsFromModelCard(opts.modelCardUrl, fetchImpl) : Promise.resolve(null),
	])

	const [tokenizer, runner] = await Promise.all([
		MailwomanTokenizer.loadFromBase64(toBase64(tokenizerBytes)),
		WebOnnxRunner.fromBytes(modelBytes, opts.runner),
	])

	const classifier = new NeuralAddressClassifier({
		tokenizer,
		runner,
		...(labels ? { labels } : {}),
	})
	await runner.infer([0])
	return { classifier, diagnostics: runner.diagnostics, labels }
}

/**
 * Browser-side analogue of `weights.readLabelsFromModelCard`. Same shape contract: returns the
 * `labels` array only when the card has a non-empty string array, throws on a present-but-malformed
 * field, returns `null` when the field is simply absent (legacy pre-v0.4.0 card).
 *
 * A 404 on the model-card itself is treated as "no card provided" — we tolerate older bundles that
 * shipped without one and let the classifier fall back to its compile-time default.
 */
async function fetchLabelsFromModelCard(url: string, fetchImpl: typeof fetch): Promise<readonly string[] | null> {
	const res = await fetchImpl(url)
	if (!res.ok) {
		if (res.status === 404) return null
		throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`)
	}
	const parsed = (await res.json()) as { labels?: unknown }
	const labels = parsed.labels
	if (labels === undefined) return null
	if (!Array.isArray(labels) || labels.length === 0 || !labels.every((l) => typeof l === "string")) {
		throw new Error(
			`model-card at ${url} has a malformed \`labels\` field — ` +
				`expected a non-empty array of strings, got ${JSON.stringify(labels)}.`
		)
	}
	return Object.freeze(labels.slice()) as readonly string[]
}

async function fetchBytes(url: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
	const res = await fetchImpl(url)
	if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`)
	return new Uint8Array(await res.arrayBuffer())
}

/**
 * Base64-encode a Uint8Array. Browsers + Node 18+ both have `btoa(String.fromCharCode(...))` but
 * String.fromCharCode chokes on long arrays (call-stack overflow on a few MB of bytes). The chunked
 * loop avoids that — kept here rather than imported because both browser and Node need it and
 * adding a dep for ~5 lines is silly.
 */
function toBase64(bytes: Uint8Array): string {
	const chunkSize = 0x8000
	let binary = ""
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize)
		binary += String.fromCharCode(...chunk)
	}
	if (typeof btoa === "function") return btoa(binary)
	// Node: Buffer is the lower-friction path; the lazy import keeps the file from pulling in
	// node:buffer when bundlers are statically analyzing browser entries.
	return Buffer.from(binary, "binary").toString("base64")
}
