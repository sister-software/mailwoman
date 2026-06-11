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

import {
	type AnchorLookup,
	type GazetteerLexicon,
	MailwomanTokenizer,
	NeuralAddressClassifier,
	type NeuralAddressClassifierConfig,
	parseGazetteerLexicon,
	PostcodeBinaryResolver,
} from "@mailwoman/neural/browser"

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
	/**
	 * The parsed postcode-anchor lookup (postcode → posterior + centroid), when anchor binaries were
	 * loaded. Exposed so consumers (the demo's anchor-centroid map fallback) can reuse the SAME
	 * artifact the model channel feeds from — WOF ships placeholder (0,0) for ~22% of US postcodes;
	 * this lookup has a real centroid for every covered ZIP.
	 */
	postcodeAnchorLookup?: import("@mailwoman/neural").AnchorLookup
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
	/**
	 * URLs to one or more PCB1 postcode binaries (`postcode-<cc>.bin`). For anchor-trained models
	 * (#239/#240) these are decoded + merged into the postcode→anchor lookup the classifier feeds at
	 * inference, so the demo runs the model with the anchor on. Pass the locales the model handles
	 * (e.g. US + DE). Omit for plain models — the runner then feeds the anchor-off identity.
	 */
	postcodeBinaryUrls?: readonly string[]
	/**
	 * URL to the gazetteer-anchor lexicon JSON (`anchor-lexicon-v1.json`, #464 — the in-repo source
	 * is `data/gazetteer/anchor-lexicon-v1.json`). Gazetteer-trained models (v4.2.0+, whose ONNX
	 * declares the `gazetteer_features`/`gazetteer_confidence` inputs) REQUIRE this clue at
	 * inference: running them on the zero-filled fallback is the measured train/inference mismatch
	 * that wrecks segmentation ("the zero-fill trap", CONTRIBUTING_MODEL_WORK.mdx eval invariants).
	 *
	 * Defaults to `anchor-lexicon-v1.json` next to `modelUrl`. A fetch miss (404 etc.) does NOT throw
	 * — older bundles never shipped the file — but if the loaded model turns out to be
	 * gazetteer-trained the loader logs a loud `console.error` naming the missing file and the model
	 * runs gazetteer-off (structurally valid, quality-degraded). Pass `null` to skip the fetch
	 * entirely.
	 */
	gazetteerLexiconUrl?: string | null
	/**
	 * Channel choreography (#464, v0.9.13 postcode fix): zero the gazetteer clue on pieces adjacent
	 * to a postcode-anchor hit. Defaults to TRUE — it pairs with the train-time half on every
	 * gazetteer-trained bundle (v4.2.0+) and is inert when either channel is absent.
	 */
	suppressGazetteerNearPostcode?: boolean
	/**
	 * Address-system conventions mode (#511 Tier A, v4.3.0+). Defaults to `"auto"` (read the model's
	 * locale head when exported; inert on bundles without `locale_logits`). Pass a `SystemCode` to
	 * pin, or `null` to disable.
	 */
	addressSystemConventions?: NeuralAddressClassifierConfig["addressSystemConventions"] | null
	/**
	 * Span bridge (v4.4.0 declared behavior): merge same-tag spans split at intra-token punctuation
	 * ("P.O. Box"). Defaults to TRUE per the v4.4.0 ship config (model-card.json: po_box 60.4
	 * without, 89.1 with). Pass false to disable for pre-bridge bundles where gate parity matters.
	 */
	bridgePunctuationGaps?: boolean
	/** Optional fetch override. Defaults to `globalThis.fetch`. */
	fetchImpl?: typeof fetch
}

/** Merge per-binary anchor lookups: union the country posteriors per postcode, mean the centroids. */
function mergeAnchorLookups(lookups: readonly AnchorLookup[]): AnchorLookup {
	if (lookups.length === 1) return lookups[0]!
	const merged: AnchorLookup = new Map()
	for (const lookup of lookups) {
		for (const [postcode, entry] of lookup) {
			const existing = merged.get(postcode)
			if (!existing) {
				merged.set(postcode, { posterior: { ...entry.posterior }, lat: entry.lat, lon: entry.lon })
				continue
			}
			for (const country of Object.keys(entry.posterior)) existing.posterior[country] = 1
			// Average a real centroid in; ignore (0,0) placeholders.
			if (entry.lat !== 0 || entry.lon !== 0) {
				if (existing.lat === 0 && existing.lon === 0) {
					existing.lat = entry.lat
					existing.lon = entry.lon
				} else {
					existing.lat = (existing.lat + entry.lat) / 2
					existing.lon = (existing.lon + entry.lon) / 2
				}
			}
		}
	}
	return merged
}

/**
 * Default location of the gazetteer-anchor lexicon: `anchor-lexicon-v1.json` as a sibling of the
 * model file. Matches how release bundles lay out their version directory (model.onnx,
 * tokenizer.model, model-card.json, postcode-*.bin, anchor-lexicon-v1.json side by side).
 */
export function defaultGazetteerLexiconUrl(modelUrl: string): string {
	// Swap the final path segment — string surgery rather than `new URL()` so relative model URLs
	// ("/static/mailwoman/model.onnx") stay relative.
	return modelUrl.replace(/[^/]*$/, "anchor-lexicon-v1.json")
}

/**
 * Convenience factory: fetch model + tokenizer, build the runner, return a classifier. The
 * tokenizer is loaded via the existing `loadFromBase64` path so this file shares zero Node-only
 * code with `@mailwoman/neural/classifier`'s `loadFromWeights`.
 *
 * The classifier is constructed with the v4.4.0 ship config by default (gazetteer lexicon +
 * postcode anchor when their assets resolve, `suppressGazetteerNearPostcode: true`,
 * `addressSystemConventions: "auto"`, `bridgePunctuationGaps: true`) — every knob is inert on
 * bundles that predate the corresponding channel, so older versions keep decoding unchanged.
 */
export async function loadNeuralClassifierFromUrls(opts: LoadFromUrlsOpts): Promise<LoadResult> {
	const fetchImpl = opts.fetchImpl ?? globalThis.fetch
	if (!fetchImpl) {
		throw new Error("no fetch implementation available — pass fetchImpl in non-fetch environments")
	}

	const gazetteerLexiconUrl =
		opts.gazetteerLexiconUrl === null ? null : (opts.gazetteerLexiconUrl ?? defaultGazetteerLexiconUrl(opts.modelUrl))

	const [modelBytes, tokenizerBytes, labels, gazetteerLexicon] = await Promise.all([
		fetchBytes(opts.modelUrl, fetchImpl),
		fetchBytes(opts.tokenizerUrl, fetchImpl),
		opts.modelCardUrl ? fetchLabelsFromModelCard(opts.modelCardUrl, fetchImpl) : Promise.resolve(null),
		gazetteerLexiconUrl ? fetchGazetteerLexicon(gazetteerLexiconUrl, fetchImpl) : Promise.resolve(null),
	])

	const [tokenizer, runner, postcodeAnchorLookup] = await Promise.all([
		MailwomanTokenizer.loadFromBase64(toBase64(tokenizerBytes)),
		WebOnnxRunner.fromBytes(modelBytes, opts.runner),
		opts.postcodeBinaryUrls?.length
			? Promise.all(
					opts.postcodeBinaryUrls.map(async (url) =>
						new PostcodeBinaryResolver(await fetchBytes(url, fetchImpl)).toAnchorLookup()
					)
				).then(mergeAnchorLookups)
			: Promise.resolve<AnchorLookup | undefined>(undefined),
	])

	const conventions = opts.addressSystemConventions === null ? undefined : (opts.addressSystemConventions ?? "auto")
	const classifier = new NeuralAddressClassifier({
		tokenizer,
		runner,
		...(labels ? { labels } : {}),
		...(postcodeAnchorLookup ? { postcodeAnchorLookup } : {}),
		...(gazetteerLexicon ? { gazetteerLexicon } : {}),
		suppressGazetteerNearPostcode: opts.suppressGazetteerNearPostcode ?? true,
		...(conventions ? { addressSystemConventions: conventions } : {}),
		bridgePunctuationGaps: opts.bridgePunctuationGaps ?? true,
	})
	await runner.infer([0])
	warnOnUnfedTrainedChannels(runner, {
		gazetteerLexicon,
		gazetteerLexiconUrl,
		postcodeAnchorLookup,
	})
	return { classifier, diagnostics: runner.diagnostics, labels }
}

/**
 * Loud degrade (#464): the warmup `infer([0])` above forced session creation, so the graph's
 * declared inputs are now known. A gazetteer/anchor-TRAINED model running on the zero-filled
 * fallback is a measured failure mode (train/inference mismatch — "the zero-fill trap"), not a
 * quality-neutral default; without this check the only symptom would be silently degraded parses.
 * (Pre-fix, the symptom was worse still: ORT's cryptic `input 'gazetteer_features' is missing in
 * 'feeds'`.) The loader still returns a working classifier — structural fallback, loud console.
 */
function warnOnUnfedTrainedChannels(
	runner: WebOnnxRunner,
	fed: {
		gazetteerLexicon: GazetteerLexicon | null
		gazetteerLexiconUrl: string | null
		postcodeAnchorLookup: AnchorLookup | undefined
	}
): void {
	const inputNames = runner.inputNames
	if (!inputNames) return
	if (inputNames.includes("gazetteer_features") && !fed.gazetteerLexicon) {
		console.error(
			"[mailwoman/neural-web] This model is gazetteer-anchor-trained (its ONNX declares `gazetteer_features`) " +
				"but no gazetteer lexicon was loaded" +
				(fed.gazetteerLexiconUrl
					? ` — \`anchor-lexicon-v1.json\` could not be fetched from ${fed.gazetteerLexiconUrl}. ` +
						"Upload the lexicon next to model.onnx, or pass `gazetteerLexiconUrl` explicitly."
					: " — `gazetteerLexiconUrl` was explicitly disabled (null). ") +
				" Running with zero-filled gazetteer clues: parses will be degraded (train/inference mismatch)."
		)
	}
	if (inputNames.includes("anchor_features") && !fed.postcodeAnchorLookup) {
		console.error(
			"[mailwoman/neural-web] This model is postcode-anchor-trained (its ONNX declares `anchor_features`) " +
				"but no `postcodeBinaryUrls` were provided (postcode-<cc>.bin). " +
				"Running with zero-filled anchor features: the anchor-off identity, degraded vs the ship config."
		)
	}
}

/**
 * Fetch + parse `anchor-lexicon-v1.json`. A missing file (404 or network failure) returns null —
 * the caller decides whether that matters (it does iff the model declares the gazetteer inputs; see
 * `warnOnUnfedTrainedChannels`). A PRESENT-but-malformed lexicon throws loudly via
 * `parseGazetteerLexicon`'s validation — never silently zero-fill off bad data.
 */
async function fetchGazetteerLexicon(url: string, fetchImpl: typeof fetch): Promise<GazetteerLexicon | null> {
	let res: Response
	try {
		res = await fetchImpl(url)
	} catch {
		return null
	}
	if (!res.ok) return null
	return parseGazetteerLexicon((await res.json()) as Parameters<typeof parseGazetteerLexicon>[0])
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
