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

import { detectLocaleSync } from "@mailwoman/locale-gate"
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
	type PlacetypePairPriorOpts,
	PostcodeBinaryResolver,
} from "@mailwoman/neural/browser"
import { computeQueryShape } from "@mailwoman/query-shape"

import { WebONNXRunner, type WebONNXRunnerDiagnostics, type WebONNXRunnerOpts } from "./web-onnx-runner.ts"

export type { WebONNXRunnerDiagnostics }

/**
 * One fetched PIX1 placetype-pair index (placetype-pair-prior arc, #1278 browser wiring) as the loader retained it.
 *
 * Phase 2 (#1278 locale-gate wiring) changed the load contract: because locale-gate detects the country PER PARSE from
 * the input text (a US and a GB address in the same session need DIFFERENT indexes), the loader can no longer pick one
 * live resolver at load time. So EVERY successfully-fetched index is now constructed into a live
 * {@link PairIndexResolver} and retained here, tagged by its header country — the per-parse selection (see
 * {@link LoadResult.selectPairIndexForText}) chooses among them at decode time. (#1300's load-time country gate —
 * construct only the one matching index — is superseded; the `country` load-option survives as an optional
 * CONFIG-DEFAULT posture pin, see {@link LoadFromURLsOptions.country}.)
 */
export interface LoadedPairIndex {
	/** URL the binary was fetched from. */
	url: string
	/** The header's ISO country code — the key the per-parse selection matches a detected country against. */
	country: string
	/**
	 * The constructed, live resolver. The SAME instance the per-parse selection returns (and, for a posture-pinned load,
	 * the classifier's config default).
	 */
	resolver: PairIndexResolver
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
	 * Every placetype-pair index that fetched + parsed, each with its header country and a live resolver — see
	 * {@link LoadedPairIndex}. Empty when `pairIndexURLs` was omitted or every fetch failed. Exposed so consumers (the
	 * demo's preset lighting) can see which countries' indexes are loaded and available to the per-parse selection.
	 */
	pairIndexes: readonly LoadedPairIndex[]
	/**
	 * Per-parse placetype-pair selection (#1278 phase 2) — the primary path. Runs `@mailwoman/query-shape` +
	 * `@mailwoman/locale-gate` over `text` to derive a country subtag from its STRUCTURAL shape (postcode format /
	 * script; never place-name dictionaries — bitter-lesson-safe), then returns the {@link LoadedPairIndex} resolver
	 * whose header country matches, wrapped as a ready-to-spread `placetypePair` option. No matching index (or no indexes
	 * loaded) → `undefined`, which a caller spreads as `placetypePair: undefined` → the classifier's `opts?.placetypePair
	 * ?? this.cfg.placetypePair` resolution falls through to the config default (see {@link LoadFromURLsOptions.country})
	 * or, when none, the byte-stable no-prior decode.
	 *
	 * Intended call site (the demo, its own next step):
	 *
	 * ```ts
	 * const tree = await classifier.parse(text, { ...baseOpts, placetypePair: result.selectPairIndexForText(text) })
	 * ```
	 *
	 * `opts.country` (a locale "en-gb" or bare "gb") pins the selection for one call, bypassing detection — the escape
	 * hatch for a preset that knows its own posture regardless of the text shape.
	 */
	selectPairIndexForText: (text: string, opts?: { country?: string }) => PlacetypePairPriorOpts | undefined
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
	 * blocks the classifier load — older HF release versions ship no pair indexes at all.
	 *
	 * **Phase 2 (#1278 locale-gate wiring) — load ALL, select per parse.** Every fetched index is constructed into a live
	 * {@link PairIndexResolver} and retained ({@link LoadResult.pairIndexes}), tagged by its header country. The
	 * selection of WHICH index biases a given parse is a per-parse decision — see
	 * {@link LoadResult.selectPairIndexForText}, which runs locale-gate over the input text — because one loaded
	 * classifier serves inputs from multiple countries and the country is a property of the text, not the load. (#1300's
	 * load-time single-index country gate is superseded; the `country` load-option below survives as an optional
	 * config-default posture pin.)
	 */
	pairIndexURLs?: readonly string[]
	/**
	 * OPTIONAL default posture for the placetype-pair prior — a locale ("en-gb") or bare ISO country code ("gb"),
	 * case-insensitive (reduced to its country subtag via {@link resolvePairGateCountry}, the node `localeCountry`
	 * derivation). When provided AND a fetched index carries a matching header country, that index becomes the
	 * classifier's CONFIG-LEVEL `placetypePair` default — the posture a parse falls back to when the per-parse
	 * {@link LoadResult.selectPairIndexForText} returns nothing (or the demo never calls it). This is the single-posture
	 * "default/override" path: it pins one country the way #1300's demo did.
	 *
	 * OMITTED (the recommended shape for the multi-locale demo) sets NO config default — every parse's prior comes solely
	 * from the per-parse selection, and an input that matches no loaded index decodes byte-stable (no prior). Note the
	 * behavior change from #1300: omission no longer defaults to `"us"`/gates loading — it means "detect per parse."
	 *
	 * There is still no browser-side AUTO-detection at LOAD time (nothing here knows a locale before any text arrives);
	 * detection happens per parse, on the actual input, in {@link LoadResult.selectPairIndexForText}.
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
 * Fetch + construct the PIX1 placetype-pair indexes TOLERANTLY (the {@link loadPostcodeAnchorLookup} contract): each
 * `pair-index-<cc>.bin` is OPTIONAL, so a 404/network failure/corrupt binary (bad magic, truncated header) is skipped
 * with a loud `console.warn` naming the URL — never a rejection that blocks the classifier load. Older HF release
 * versions ship no pair indexes at all, and the prior is a soft decode channel, not a load-bearing model input.
 *
 * **Phase 2 (#1278): NO load-time country gate.** Every successfully-fetched index is constructed into a live
 * {@link PairIndexResolver} and retained, tagged by its header country. The per-parse selection
 * ({@link resolvePairIndexForText}) chooses among them at decode time from the input text's detected country — a load
 * that serves a US and a GB address in one session needs BOTH resolvers live. (#1300 constructed only the single
 * gate-matching index; that peek-before-construct economy is dropped deliberately — the multi-locale demo needs them
 * all, and a handful of small pair maps is cheap.)
 */
async function loadPairIndexes(urls: readonly string[], fetchImpl: typeof fetch): Promise<LoadedPairIndex[]> {
	const settled = await Promise.all(
		urls.map(async (url): Promise<LoadedPairIndex | null> => {
			try {
				const resolver = new PairIndexResolver(await fetchBytes(url, fetchImpl))

				return { url, country: resolver.header.country, resolver }
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

	return settled.filter((index): index is LoadedPairIndex => index !== null)
}

/**
 * Detect the placetype-pair country subtag for one input from its STRUCTURAL shape (#1278 phase 2). Runs the two
 * browser-safe Stage-2 modules the runtime pipeline uses — `@mailwoman/query-shape`'s `computeQueryShape` then
 * `@mailwoman/locale-gate`'s `detectLocaleSync` — and reduces the resulting `LocaleHint.locale` (e.g. "en-GB") to its
 * country subtag ("gb") via {@link resolvePairGateCountry}.
 *
 * The detection is bitter-lesson-safe by construction: locale-gate keys ONLY off universal cues (postcode format,
 * script class), never place-name dictionaries. So "10 Downing St, London SW1A 2AA" detects `gb` (UK postcode), but a
 * bare "Shoreditch London" — no postcode, Latin script — falls through to locale-gate's `en-US` fallback → `us`. The
 * pair prior is a soft, additive channel, so a conservative miss (no bias) is the safe failure mode.
 */
export function detectPairIndexCountry(text: string): string {
	const shape = computeQueryShape(text)
	const hint = detectLocaleSync({ raw: text, normalized: text }, shape)

	return resolvePairGateCountry(hint.locale)
}

/**
 * Select the placetype-pair prior for one parse (#1278 phase 2). Derives a country subtag — from an explicit
 * `opts.country` override when given, else {@link detectPairIndexCountry} over `text` — and returns the loaded index
 * whose header country matches, wrapped as a `placetypePair` option (`{ index }` alone: probe chain defaults to "auto",
 * `delta`/`transitionBeta` ride the resolver's header getters, exactly the node construction). No matching index →
 * `undefined` (the caller spreads `placetypePair: undefined` → byte-stable no-prior decode, or fall-through to a config
 * default). See {@link LoadResult.selectPairIndexForText} for the bound convenience + call-site example.
 */
export function resolvePairIndexForText(
	pairIndexes: readonly LoadedPairIndex[],
	text: string,
	opts?: { country?: string }
): PlacetypePairPriorOpts | undefined {
	if (pairIndexes.length === 0) return undefined
	const country = opts?.country != null ? resolvePairGateCountry(opts.country) : detectPairIndexCountry(text)
	const match = pairIndexes.find((index) => index.country === country)

	return match ? { index: match.resolver } : undefined
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
			? loadPairIndexes(opts.pairIndexURLs, fetchImpl)
			: Promise.resolve<LoadedPairIndex[]>([]),
	])

	// Placetype-pair prior (#1278 phase 2): the loaded indexes are ALL live (see loadPairIndexes) and the WHICH-index
	// choice is per parse (`selectPairIndexForText`, below). The `country` load-option survives only as an optional
	// CONFIG-DEFAULT posture pin: when the caller passed one AND a loaded index matches it, that index becomes the
	// classifier's config-level `placetypePair` default a parse falls back to when the per-parse selection returns nothing.
	// Omitted country = no config default → the byte-stable no-prior decode when nothing is selected per parse.
	let configPairIndex: PairIndexResolver | undefined

	if (opts.country != null && pairIndexes.length > 0) {
		const pinnedCountry = resolvePairGateCountry(opts.country)
		const pinned = pairIndexes.find((index) => index.country === pinnedCountry)

		if (pinned) {
			configPairIndex = pinned.resolver
		} else {
			console.warn(
				`[mailwoman/neural-web] country "${pinnedCountry}" was requested as the placetype-pair default posture, but no ` +
					`loaded index matches it — loaded header countries: ${pairIndexes.map((index) => `"${index.country}"`).join(", ")}. ` +
					"No config default is set; per-parse selection (selectPairIndexForText) still works for the countries that DID load."
			)
		}
	}

	const conventions = opts.addressSystemConventions === null ? undefined : (opts.addressSystemConventions ?? "auto")
	const classifier = new NeuralAddressClassifier({
		tokenizer,
		runner,
		...(labels ? { labels } : {}),
		...(postcodeAnchorLookup ? { postcodeAnchorLookup } : {}),
		...(gazetteerLexicon ? { gazetteerLexicon } : {}),
		...(countryLexicon ? { countryLexicon } : {}),
		...(configPairIndex ? { placetypePair: { index: configPairIndex } } : {}),
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

	return {
		classifier,
		diagnostics: runner.diagnostics,
		labels,
		pairIndexes,
		selectPairIndexForText: (text, selectOpts) => resolvePairIndexForText(pairIndexes, text, selectOpts),
	}
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
