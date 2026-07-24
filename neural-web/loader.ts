/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Browser-side loader that pairs the existing `MailwomanTokenizer` (whose `loadFromBase64` path is
 *   already browser-safe — it doesn't touch Node fs) with a fresh `WebONNXRunner`, and returns a
 *   ready-to-use `NeuralAddressClassifier`.
 *
 *   V1 strategy: fetch both `model.onnx` and `tokenizer.model` over HTTP from caller-provided URLs
 *   (typically pointing at the same static-asset bundle that ships the resolver's slim WOF DB). The
 *   neural weights package `@mailwoman/neural-weights-en-us` is the canonical source of those two
 *   files; for a static deploy, copy them into the public bundle and pass the resulting URLs.
 */

import {
	type AnchorLookup,
	type CountryLexicon,
	type GazetteerLexicon,
	MailwomanTokenizer,
	NeuralAddressClassifier,
	type NeuralAddressClassifierConfig,
	PairIndexResolver,
	parseCountryLexicon,
	parseGazetteerLexicon,
	peekPairIndexHeader,
	PostcodeBinaryResolver,
} from "@mailwoman/neural/browser"

import { WebONNXRunner, type WebONNXRunnerDiagnostics, type WebONNXRunnerOpts } from "./web-onnx-runner.ts"

export type { WebONNXRunnerDiagnostics }

/**
 * One fetched PIX1 placetype-pair index (placetype-pair-prior arc, #1278 browser wiring) as the loader saw it.
 * `resolver` is constructed ONLY for a country-matched index — a gated-out index had its header peeked
 * (`peekPairIndexHeader`, no entry parse) and stays `null`, mirroring the node-side `loadFromWeights` discipline of
 * never paying the full-parse cost for an index the gate discards.
 */
export interface LoadedPairIndex {
	/** URL the binary was fetched from. */
	url: string
	/** The header's ISO country code — the value the country gate compared. */
	country: string
	/**
	 * The constructed resolver when `country` matched the loader's gate country (see {@link LoadFromURLsOptions.country});
	 * `null` when the index loaded but was gated out. A non-null resolver here is the SAME instance wired into the
	 * classifier's `placetypePair` config.
	 */
	resolver: PairIndexResolver | null
}

export interface LoadResult {
	classifier: NeuralAddressClassifier
	diagnostics: WebONNXRunnerDiagnostics | null
	/**
	 * Labels actually applied to the classifier. `null` when no model-card was provided or its `labels` field was missing
	 * — the classifier fell back to its built-in default (Stage 2).
	 */
	labels: readonly string[] | null
	/**
	 * The parsed postcode-anchor lookup (postcode → posterior + centroid), when anchor binaries were loaded. Exposed so
	 * consumers (the demo's anchor-centroid map fallback) can reuse the SAME artifact the model channel feeds from — WOF
	 * ships placeholder (0,0) for ~22% of US postcodes; this lookup has a real centroid for every covered ZIP.
	 */
	postcodeAnchorLookup?: import("@mailwoman/neural").AnchorLookup
	/**
	 * Every placetype-pair index that fetched + parsed a header, with its header country and (for the country-matched
	 * one) the constructed resolver — see {@link LoadedPairIndex}. Empty when `pairIndexURLs` was omitted or every fetch
	 * failed. Exposed so consumers (the demo's preset lighting) can see which countries' indexes loaded and which one, if
	 * any, is live on the classifier.
	 */
	pairIndexes: readonly LoadedPairIndex[]
}

export interface LoadFromURLsOptions {
	/** URL to the ONNX model file (e.g. `/static/mailwoman/model.onnx`). */
	modelURL: string
	/** URL to the SentencePiece tokenizer model (e.g. `/static/mailwoman/tokenizer.model`). */
	tokenizerURL: string
	/**
	 * URL to `model-card.json`. When provided, its `labels` field is threaded into the classifier so post-Stage-2 bundles
	 * (33-label Stage 3 and beyond) decode correctly. Skip for legacy bundles whose cards predate the `labels` field —
	 * the loader falls back to the built-in Stage 2 default.
	 *
	 * Required for any v0.6.x+ bundle: without it the classifier builds a 21×21 transition mask while the model emits 33
	 * logits and viterbi crashes with "Cannot read properties of undefined".
	 */
	modelCardURL?: string
	/** Runner options (WebGPU toggle, fixed sequence length, WASM path override). */
	runner?: WebONNXRunnerOpts
	/**
	 * URLs to one or more PCB1 postcode binaries (`postcode-<cc>.bin`). For anchor-trained models (#239/#240) these are
	 * decoded + merged into the postcode→anchor lookup the classifier feeds at inference, so the demo runs the model with
	 * the anchor on. Pass the locales the model handles (e.g. US + DE). Omit for plain models — the runner then feeds the
	 * anchor-off identity.
	 */
	postcodeBinaryURLs?: readonly string[]
	/**
	 * URLs to one or more PIX1 placetype-pair indexes (`pair-index-<cc>.bin`, placetype-pair-prior arc — the GB
	 * dependent_locality retrieval channel, #1278). Each binary is OPTIONAL and fetched TOLERANTLY (the
	 * `postcodeBinaryURLs` contract): a 404/network failure/corrupt file is skipped with a loud `console.warn` and never
	 * blocks the classifier load — older HF release versions ship no pair indexes at all. A fetched index is then
	 * COUNTRY-GATED: its header's `country` must equal the gate country derived from {@link country}, mirroring the node
	 * classifier's `loadFromWeights` hard gate (an index built for one country must never bias a parse resolved for a
	 * different locale). The first matching index is wired into the classifier's `placetypePair` config — probe-chain
	 * `"auto"` default, `delta`/`transitionBeta` from the index header, identical to the node construction. No match =
	 * byte-stable decode (the prior stays off).
	 */
	pairIndexURLs?: readonly string[]
	/**
	 * The country the loaded classifier's parses are FOR — the placetype-pair country gate's right-hand side. Accepts a
	 * full locale ("en-gb") or a bare ISO country code ("gb"), case-insensitive; a locale is reduced to its country
	 * subtag, mirroring the node classifier's `localeCountry` derivation (`(opts.locale ?? "en-us").split("-")[1]`).
	 * Defaults to `"en-us"` → `"us"` — the node default — so omitting it can never light a non-US index by accident.
	 *
	 * There is deliberately NO browser-side auto-detection: nothing in this loader or the runner knows a locale (the
	 * bundle URLs encode one only by convention, and the model's own locale head is a per-parse, post-inference signal —
	 * too late for a load-time gate). The caller (the demo) owns the posture and passes it explicitly.
	 */
	country?: string
	/**
	 * URL to the gazetteer-anchor lexicon JSON (`anchor-lexicon-v1.json`, #464 — the in-repo source is
	 * `data/gazetteer/anchor-lexicon-v1.json`). Gazetteer-trained models (v4.2.0+, whose ONNX declares the
	 * `gazetteer_features`/`gazetteer_confidence` inputs) REQUIRE this clue at inference: running them on the zero-filled
	 * fallback is the measured train/inference mismatch that wrecks segmentation ("the zero-fill trap",
	 * CONTRIBUTING_MODEL_WORK.mdx eval invariants).
	 *
	 * Defaults to `anchor-lexicon-v1.json` next to `modelURL`. A fetch miss (404 etc.) does NOT throw — older bundles
	 * never shipped the file — but if the loaded model turns out to be gazetteer-trained the loader logs a loud
	 * `console.error` naming the missing file and the model runs gazetteer-off (structurally valid, quality-degraded).
	 * Pass `null` to skip the fetch entirely.
	 */
	gazetteerLexiconURL?: string | null
	/**
	 * URL to the country-surface lexicon JSON (`country-surface-lexicon-v1.json`, #1104 — the in-repo source is
	 * `data/gazetteer/country-surface-lexicon-v1.json`). Country-channel models (v6.2.0+, whose ONNX declares the
	 * `country_features`/`country_confidence` inputs) REQUIRE this clue at inference — same zero-fill trap as the
	 * gazetteer. Defaults to `country-surface-lexicon-v1.json` next to `modelURL`; a fetch miss does NOT throw, but a
	 * country-trained model with no lexicon runs country-off (loud `console.error`, structurally valid). Pass `null` to
	 * skip.
	 */
	countryLexiconURL?: string | null
	/**
	 * Channel choreography (#464, v0.9.13 postcode fix): zero the gazetteer clue on pieces adjacent to a postcode-anchor
	 * hit. Defaults to TRUE — it pairs with the train-time half on every gazetteer-trained bundle (v4.2.0+) and is inert
	 * when either channel is absent.
	 */
	suppressGazetteerNearPostcode?: boolean
	/**
	 * Address-system conventions mode (#511 Tier A, v4.3.0+). Defaults to `"auto"` (read the model's locale head when
	 * exported; inert on bundles without `locale_logits`). Pass a `SystemCode` to pin, or `null` to disable.
	 */
	addressSystemConventions?: NeuralAddressClassifierConfig["addressSystemConventions"] | null
	/**
	 * Span bridge (v4.4.0 declared behavior): merge same-tag spans split at intra-token punctuation ("P.O. Box").
	 * Defaults to TRUE per the v4.4.0 ship config (model-card.json: po_box 60.4 without, 89.1 with). Pass false to
	 * disable for pre-bridge bundles where gate parity matters.
	 */
	bridgePunctuationGaps?: boolean
	/** Optional fetch override. Defaults to `globalThis.fetch`. */
	fetchImpl?: typeof fetch
}

/**
 * Fetch + decode the postcode anchor binaries TOLERANTLY, then merge the ones that loaded.
 *
 * Each `postcode-<cc>.bin` is OPTIONAL: the postcode anchor is a soft ranking channel, not a load-bearing model input,
 * so a single missing/404 binary must NEVER reject the whole classifier load. This is the fix for the 2026-07 demo
 * outage — `postcode-de.bin` went 404 on prod R2 for every shipped version while postcode-us/fr stayed 200, and the old
 * throwing `Promise.all(urls.map(fetchBytes))` rejected on that one 404. That rejection propagated up through
 * `loadNeuralClassifierFromURLs` → `runtime.ready` never fired → the demo input stayed permanently disabled even though
 * the model, tokenizer, and the other two postcode binaries were all fine.
 *
 * Behavior: fetch each binary independently; SKIP any that fail (404 or network) with a loud `console.warn` naming the
 * URL + the failure; merge the successes via {@link mergeAnchorLookups}. If ALL fail, return `undefined` — identical to
 * the no-`postcodeBinaryURLs`-configured path, so the classifier still loads (anchor-off identity, ranking degrades
 * slightly but nothing blocks). A PRESENT-but-corrupt binary (bad magic) throws inside `PostcodeBinaryResolver`; that
 * is caught here too and treated as a skip — a garbage optional asset should degrade, not brick the demo.
 */
async function loadPostcodeAnchorLookup(
	urls: readonly string[],
	fetchImpl: typeof fetch
): Promise<AnchorLookup | undefined> {
	const settled = await Promise.all(
		urls.map(async (url): Promise<AnchorLookup | null> => {
			try {
				return new PostcodeBinaryResolver(await fetchBytes(url, fetchImpl)).toAnchorLookup()
			} catch (error) {
				console.warn(
					`[mailwoman/neural-web] optional postcode anchor binary skipped: ${url} — ` +
						`${error instanceof Error ? error.message : String(error)}. ` +
						"The postcode anchor is a soft ranking channel; the classifier loads without it (degraded ranking only)."
				)

				return null
			}
		})
	)
	const lookups = settled.filter((lookup): lookup is AnchorLookup => lookup !== null)

	return lookups.length ? mergeAnchorLookups(lookups) : undefined
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

			for (const country of Object.keys(entry.posterior)) {
				existing.posterior[country] = 1
			}

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
 * Reduce {@link LoadFromURLsOptions.country} to the bare country code the pair-index gate compares. A full locale
 * ("en-gb") yields its country subtag ("gb") — the node classifier's exact `localeCountry` derivation — and a bare code
 * ("gb") passes through unchanged (a browser-side widening: the node path only ever receives locales). Omitted =
 * `"en-us"` → `"us"`, the node default.
 */
export function resolvePairGateCountry(country: string | undefined): string {
	const normalized = (country ?? "en-us").toLowerCase()

	return normalized.split("-")[1] ?? normalized
}

/**
 * Fetch + gate the PIX1 placetype-pair indexes TOLERANTLY (the {@link loadPostcodeAnchorLookup} contract): each
 * `pair-index-<cc>.bin` is OPTIONAL, so a 404/network failure/corrupt binary (bad magic, truncated header) is skipped
 * with a loud `console.warn` naming the URL — never a rejection that blocks the classifier load. Older HF release
 * versions ship no pair indexes at all, and the prior is a soft decode channel, not a load-bearing model input.
 *
 * Each fetched index is then COUNTRY-GATED against `gateCountry`, mirroring `NeuralAddressClassifier.loadFromWeights`'s
 * hard gate INCLUDING its peek-before-construct discipline: the header is read via `peekPairIndexHeader` (no entry
 * parse, no Map build), and the full `PairIndexResolver` constructor only runs on a match. A mismatched index is
 * recorded with `resolver: null` — listing several countries' indexes while only one matches the posture is the
 * anticipated multi-locale deploy shape, so a single mismatch is NOT warned per-index; the loud warning fires only when
 * indexes loaded but NONE matched (the prior ends up off despite assets being present — the misconfiguration worth
 * naming).
 */
async function loadPairIndexes(
	urls: readonly string[],
	gateCountry: string,
	fetchImpl: typeof fetch
): Promise<LoadedPairIndex[]> {
	const settled = await Promise.all(
		urls.map(async (url): Promise<LoadedPairIndex | null> => {
			try {
				const bytes = await fetchBytes(url, fetchImpl)
				const header = peekPairIndexHeader(bytes)

				return {
					url,
					country: header.country,
					resolver: header.country === gateCountry ? new PairIndexResolver(bytes) : null,
				}
			} catch (error) {
				console.warn(
					`[mailwoman/neural-web] optional placetype-pair index skipped: ${url} — ` +
						`${error instanceof Error ? error.message : String(error)}. ` +
						"The pair prior is a soft decode channel; the classifier loads without it (no placetype-pair bias only)."
				)

				return null
			}
		})
	)
	const loaded = settled.filter((index): index is LoadedPairIndex => index !== null)

	if (loaded.length > 0 && !loaded.some((index) => index.resolver)) {
		console.warn(
			`[mailwoman/neural-web] no placetype-pair index matched the gate country "${gateCountry}" — ` +
				`loaded header countries: ${loaded.map((index) => `"${index.country}"`).join(", ")}. ` +
				'The placetype-pair prior stays OFF (byte-stable decode). Pass `country` (e.g. "en-gb") to light a matching index.'
		)
	}

	return loaded
}

/**
 * Default location of the gazetteer-anchor lexicon: `anchor-lexicon-v1.json` as a sibling of the model file. Matches
 * how release bundles lay out their version directory (model.onnx, tokenizer.model, model-card.json, postcode-*.bin,
 * anchor-lexicon-v1.json side by side).
 */
export function defaultGazetteerLexiconURL(modelURL: string): string {
	// Swap the final path segment — string surgery rather than `new URL()` so relative model URLs
	// ("/static/mailwoman/model.onnx") stay relative.
	return modelURL.replace(/[^/]*$/, "anchor-lexicon-v1.json")
}

/**
 * Default location of the country-surface lexicon (#1104): `country-surface-lexicon-v1.json` as a sibling of the model
 * file — the release bundle lays it out beside anchor-lexicon-v1.json.
 */
export function defaultCountryLexiconURL(modelURL: string): string {
	return modelURL.replace(/[^/]*$/, "country-surface-lexicon-v1.json")
}

/**
 * Convenience factory: fetch model + tokenizer, build the runner, return a classifier. The tokenizer is loaded via the
 * existing `loadFromBase64` path so this file shares zero Node-only code with `@mailwoman/neural/classifier`'s
 * `loadFromWeights`.
 *
 * The classifier is constructed with the v4.4.0 ship config by default (gazetteer lexicon + postcode anchor when their
 * assets resolve, `suppressGazetteerNearPostcode: true`, `addressSystemConventions: "auto"`, `bridgePunctuationGaps:
 * true`) — every knob is inert on bundles that predate the corresponding channel, so older versions keep decoding
 * unchanged.
 */
export async function loadNeuralClassifierFromURLs(opts: LoadFromURLsOptions): Promise<LoadResult> {
	const fetchImpl = opts.fetchImpl ?? globalThis.fetch

	if (!fetchImpl) {
		throw new Error("no fetch implementation available — pass fetchImpl in non-fetch environments")
	}

	const gazetteerLexiconURL =
		opts.gazetteerLexiconURL === null ? null : (opts.gazetteerLexiconURL ?? defaultGazetteerLexiconURL(opts.modelURL))
	const countryLexiconURL =
		opts.countryLexiconURL === null ? null : (opts.countryLexiconURL ?? defaultCountryLexiconURL(opts.modelURL))

	const [modelBytes, tokenizerBytes, labels, gazetteerLexicon, countryLexicon] = await Promise.all([
		fetchBytes(opts.modelURL, fetchImpl),
		fetchBytes(opts.tokenizerURL, fetchImpl),
		opts.modelCardURL ? fetchLabelsFromModelCard(opts.modelCardURL, fetchImpl) : Promise.resolve(null),
		gazetteerLexiconURL ? fetchGazetteerLexicon(gazetteerLexiconURL, fetchImpl) : Promise.resolve(null),
		countryLexiconURL ? fetchCountryLexicon(countryLexiconURL, fetchImpl) : Promise.resolve(null),
	])

	const [tokenizer, runner, postcodeAnchorLookup, pairIndexes] = await Promise.all([
		MailwomanTokenizer.loadFromBase64(toBase64(tokenizerBytes)),
		WebONNXRunner.fromBytes(modelBytes, opts.runner),
		opts.postcodeBinaryURLs?.length
			? loadPostcodeAnchorLookup(opts.postcodeBinaryURLs, fetchImpl)
			: Promise.resolve<AnchorLookup | undefined>(undefined),
		opts.pairIndexURLs?.length
			? loadPairIndexes(opts.pairIndexURLs, resolvePairGateCountry(opts.country), fetchImpl)
			: Promise.resolve<LoadedPairIndex[]>([]),
	])

	// Placetype-pair prior (#1278): wire the FIRST country-matched index, exactly the node `loadFromWeights`
	// construction — `{ index }` alone, so the probe chain defaults to "auto" and `delta`/`transitionBeta` come from the
	// index header via the resolver's own getters. No match (or no URLs) = no `placetypePair` key at all — the
	// byte-stable pre-prior decode, asserted in loader.pair-prior-decode.test.ts.
	const matchedPairIndex = pairIndexes.find((index) => index.resolver !== null)?.resolver ?? undefined

	const conventions = opts.addressSystemConventions === null ? undefined : (opts.addressSystemConventions ?? "auto")
	const classifier = new NeuralAddressClassifier({
		tokenizer,
		runner,
		...(labels ? { labels } : {}),
		...(postcodeAnchorLookup ? { postcodeAnchorLookup } : {}),
		...(gazetteerLexicon ? { gazetteerLexicon } : {}),
		...(countryLexicon ? { countryLexicon } : {}),
		...(matchedPairIndex ? { placetypePair: { index: matchedPairIndex } } : {}),
		suppressGazetteerNearPostcode: opts.suppressGazetteerNearPostcode ?? true,
		...(conventions ? { addressSystemConventions: conventions } : {}),
		bridgePunctuationGaps: opts.bridgePunctuationGaps ?? true,
	})
	await runner.infer([0])
	warnOnUnfedTrainedChannels(runner, {
		gazetteerLexicon,
		gazetteerLexiconURL,
		countryLexicon,
		countryLexiconURL,
		postcodeAnchorLookup,
	})

	return { classifier, diagnostics: runner.diagnostics, labels, pairIndexes }
}

/**
 * Loud degrade (#464): the warmup `infer([0])` above forced session creation, so the graph's declared inputs are now
 * known. A gazetteer/anchor-TRAINED model running on the zero-filled fallback is a measured failure mode
 * (train/inference mismatch — "the zero-fill trap"), not a quality-neutral default; without this check the only symptom
 * would be silently degraded parses. (Pre-fix, the symptom was worse still: ORT's cryptic `input 'gazetteer_features'
 * is missing in 'feeds'`.) The loader still returns a working classifier — structural fallback, loud console.
 */
function warnOnUnfedTrainedChannels(
	runner: WebONNXRunner,
	fed: {
		gazetteerLexicon: GazetteerLexicon | null
		gazetteerLexiconURL: string | null
		countryLexicon: CountryLexicon | null
		countryLexiconURL: string | null
		postcodeAnchorLookup: AnchorLookup | undefined
	}
): void {
	const inputNames = runner.inputNames

	if (!inputNames) return

	if (inputNames.includes("country_features") && !fed.countryLexicon) {
		console.error(
			"[mailwoman/neural-web] This model is country-channel-trained (its ONNX declares `country_features`) " +
				"but no country lexicon was loaded" +
				(fed.countryLexiconURL
					? ` — \`country-surface-lexicon-v1.json\` could not be fetched from ${fed.countryLexiconURL}. ` +
						"Upload the lexicon next to model.onnx, or pass `countryLexiconURL` explicitly."
					: " — `countryLexiconURL` was explicitly disabled (null). ") +
				" Running with zero-filled country clues: country tagging will be degraded (train/inference mismatch)."
		)
	}

	if (inputNames.includes("gazetteer_features") && !fed.gazetteerLexicon) {
		console.error(
			"[mailwoman/neural-web] This model is gazetteer-anchor-trained (its ONNX declares `gazetteer_features`) " +
				"but no gazetteer lexicon was loaded" +
				(fed.gazetteerLexiconURL
					? ` — \`anchor-lexicon-v1.json\` could not be fetched from ${fed.gazetteerLexiconURL}. ` +
						"Upload the lexicon next to model.onnx, or pass `gazetteerLexiconURL` explicitly."
					: " — `gazetteerLexiconURL` was explicitly disabled (null). ") +
				" Running with zero-filled gazetteer clues: parses will be degraded (train/inference mismatch)."
		)
	}

	if (inputNames.includes("anchor_features") && !fed.postcodeAnchorLookup) {
		console.error(
			"[mailwoman/neural-web] This model is postcode-anchor-trained (its ONNX declares `anchor_features`) " +
				"but no `postcodeBinaryURLs` were provided (postcode-<cc>.bin). " +
				"Running with zero-filled anchor features: the anchor-off identity, degraded vs the ship config."
		)
	}
}

/**
 * Fetch + parse `anchor-lexicon-v1.json`. A missing file (404 or network failure) returns null — the caller decides
 * whether that matters (it does iff the model declares the gazetteer inputs; see `warnOnUnfedTrainedChannels`). A
 * PRESENT-but-malformed lexicon throws loudly via `parseGazetteerLexicon`'s validation — never silently zero-fill off
 * bad data.
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
 * Fetch + parse `country-surface-lexicon-v1.json` (#1104). Same contract as `fetchGazetteerLexicon`: a missing file
 * returns null (matters iff the model declares `country_features`); a present-but-malformed lexicon throws via
 * `parseCountryLexicon`'s validation.
 */
async function fetchCountryLexicon(url: string, fetchImpl: typeof fetch): Promise<CountryLexicon | null> {
	let res: Response

	try {
		res = await fetchImpl(url)
	} catch {
		return null
	}

	if (!res.ok) return null

	return parseCountryLexicon((await res.json()) as Parameters<typeof parseCountryLexicon>[0])
}

/**
 * Browser-side analogue of `weights.readLabelsFromModelCard`. Same shape contract: returns the `labels` array only when
 * the card has a non-empty string array, throws on a present-but-malformed field, returns `null` when the field is
 * simply absent (legacy pre-v0.4.0 card).
 *
 * A 404 on the model-card itself is treated as "no card provided" — we tolerate older bundles that shipped without one
 * and let the classifier fall back to its compile-time default.
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
 * Base64-encode a Uint8Array. Browsers + Node 18+ both have `btoa(String.fromCharCode(...))` but String.fromCharCode
 * chokes on long arrays (call-stack overflow on a few MB of bytes). The chunked loop avoids that — kept here rather
 * than imported because both browser and Node need it and adding a dep for ~5 lines is silly.
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
