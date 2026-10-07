/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import type { StageSource } from "@mailwoman/core/pipeline"

import { parseAddressSystemTable } from "#address-system"
import { type AnchorLookup, mergeAnchorLookups } from "#anchor-inference"
import { type EncoderDescriptor, encoderDescriptorFromCard, parseCharVocabulary } from "#char-encoder"
import { type AddressSystemConventions, NeuralAddressClassifier } from "#classifier"
import { type CountryLexicon, parseCountryLexicon } from "#country-inference"
import { type GazetteerLexicon, parseGazetteerLexicon } from "#gazetteer-inference"
import { inferRequiredChannelsFromInputs } from "#ort-feeds"
import type { PairIndexResolver } from "#pair/index/resolver"
import type { PlacetypePairPriorOpts } from "#placetype/pair-prior"
import { PostcodeBinaryResolver } from "#postcode/binary-resolver"
import { MailwomanTokenizer } from "#tokenizer"
import { fetchBytes, WebONNXRunner, type WebONNXRunnerDiagnostics, type WebONNXRunnerOpts } from "#web/onnx-runner"
import { loadPairIndexes, resolvePairIndexCountry, resolvePairIndexForText } from "#web/pair-index"

/**
 * Re-exports the runner diagnostics type, because {@link LoadResult.diagnostics} exposes it.
 */
export { type WebONNXRunnerDiagnostics } from "#web/onnx-runner"
/**
 * Re-exports the pair-index selection helpers so browser callers can choose
 * from {@link LoadResult.pairIndexes}.
 */
export { detectPairIndexCountry, resolvePairIndexCountry, resolvePairIndexForText } from "#web/pair-index"

const HTTP_NOT_FOUND = 404

/**
 * A pair index that loaded successfully, with the country from its header.
 */
export interface LoadedPairIndex {
	/**
	 * The URL the binary was fetched from.
	 */
	url: string

	/**
	 * The header's ISO country code.
	 * Per-parse selection compares it with the detected country.
	 */
	country: string

	/**
	 * The resolver passed to the classifier.
	 */
	resolver: PairIndexResolver
}

/**
 * The classifier that {@link loadNeuralClassifierFromURLs} built, with its loaded assets.
 */
export interface LoadResult {
	classifier: NeuralAddressClassifier
	diagnostics: WebONNXRunnerDiagnostics | null

	/**
	 * Frees the model's native memory in the wasm heap or on the GPU.
	 * Garbage collection cannot reclaim this memory.
	 *
	 * A host that loads a new bundle during a page's lifetime must release the old one,
	 * or each load leaks a model.
	 */
	release: () => Promise<void>

	/**
	 * The labels from the model card, or `null` when the classifier uses its built-in labels.
	 */
	labels: readonly string[] | null

	/**
	 * The anchor lookup merged from the loaded postcode binaries, for consumers that reuse its centroids.
	 */
	postcodeAnchorLookup?: AnchorLookup

	/**
	 * Every pair index that fetched and parsed.
	 *
	 * It is empty when `pairIndexURLs` was omitted or every fetch failed.
	 */
	pairIndexes: readonly LoadedPairIndex[]

	/**
	 * Returns a `placetypePair` option for the loaded index whose country matches the
	 * country detected from `text`, or `null` when none matches.
	 *
	 * A locale or country code in `opts.country` skips detection for that call.
	 */
	selectPairIndexForText: (text: string, opts?: { country?: string }) => PlacetypePairPriorOpts | null
}

/**
 * Options for {@link loadNeuralClassifierFromURLs}.
 *
 * An undefined lexicon URL defaults to a file beside `modelURL`, and `null` disables that lexicon.
 */
export interface LoadFromURLsOptions {
	/**
	 * The URL of the ONNX model file.
	 */
	modelURL: string

	/**
	 * The URL of the SentencePiece tokenizer model.
	 *
	 * It is required unless the model card declares a character encoder.
	 */
	tokenizerURL?: string

	/**
	 * The URL of the character vocabulary.
	 *
	 * By default, the loader uses the card's `char_vocab` file beside `modelURL`.
	 */
	charVocabURL?: string

	/**
	 * The URL of `model-card.json`.
	 *
	 * Its `labels` and encoder declaration configure the classifier.
	 *
	 * Without this file, the classifier uses its built-in labels.
	 * Those labels may differ from a bundle trained with another label set.
	 */
	modelCardURL?: string

	/**
	 * Runner options include the WebGPU toggle, fixed sequence length and wasm path.
	 */
	runner?: WebONNXRunnerOpts

	/**
	 * URLs of PCB1 postcode binaries.
	 *
	 * The loader merges them into the anchor lookup required by anchor-trained models.
	 *
	 * A binary that fails to load is skipped with a warning.
	 */
	postcodeBinaryURLs?: readonly string[]

	/**
	 * URLs of PIX1 pair indexes.
	 *
	 * The loader reads each index so {@link LoadResult.selectPairIndexForText} can pick one per parse.
	 *
	 * An index that fails to fetch or parse is skipped with a warning.
	 */
	pairIndexURLs?: readonly string[]

	/**
	 * A locale or country code.
	 *
	 * Its matching pair index becomes the classifier's default `placetypePair` prior.
	 *
	 * When omitted, the prior comes only from per-parse selection.
	 */
	country?: string

	/**
	 * The URL of the gazetteer lexicon.
	 *
	 * `"auto"` (the default) uses `anchor-lexicon-v1.json` beside `modelURL`,
	 * `"none"` skips the fetch and `{ url }` names the file.
	 * A failed fetch does not throw.
	 *
	 * A model trained with this channel then runs on zero-filled features.
	 * The loader logs an error.
	 */
	gazetteerLexicon?: LexiconSource

	/**
	 * The URL of the country-surface lexicon.
	 *
	 * `"auto"` (the default) uses `country-surface-lexicon-v1.json` beside `modelURL`,
	 * `"none"` skips the fetch and `{ url }` names the file.
	 * A failed fetch does not throw.
	 *
	 * A model trained with this channel then runs without it.
	 * The loader logs an error.
	 */
	countryLexicon?: LexiconSource

	/**
	 * The URL of the street-type evidence lexicon.
	 *
	 * `"auto"` (the default) uses the card's declared file beside `modelURL`,
	 * `"none"` skips the fetch and `{ url }` names the file.
	 * A failed fetch does not throw.
	 *
	 * A model trained with this channel then runs without it.
	 * The loader logs an error.
	 */
	streetTypeLexicon?: LexiconSource

	/**
	 * The URL of the locality-surface evidence lexicon.
	 *
	 * Its defaults and failure behavior match {@link streetTypeLexicon}.
	 */
	localitySurfaceLexicon?: LexiconSource

	/**
	 * Whether to zero the gazetteer channel next to postcode-anchor hits.
	 * The default is `true`.
	 */
	suppressGazetteerNearPostcode?: boolean

	/**
	 * The address-system conventions mode.
	 * The default is `"auto"`.
	 */
	addressSystemConventions?: AddressSystemConventions

	/**
	 * Whether to merge same-tag spans split by punctuation, as in `P.O. Box`.
	 * It defaults to `true`.
	 */
	bridgePunctuationGaps?: boolean

	/**
	 * The fetch implementation.
	 * The default is `globalThis.fetch`.
	 */
	fetchImpl?: typeof fetch
}

/**
 * Where the loader fetches an evidence lexicon from.
 *
 * - `"auto"` uses the default file beside `modelURL`.
 * - `"none"` skips the fetch.
 * - `{ url }` names the file.
 */
export type LexiconSource = StageSource<{ url: string }>

function lexiconURLFor(source: LexiconSource | undefined, defaultURL: () => string): string | null {
	const resolved = source ?? "auto"

	if (resolved === "none") return null

	return resolved === "auto" ? defaultURL() : resolved.url
}

async function loadPostcodeAnchorLookup(
	urls: readonly string[],
	fetchImpl: typeof fetch
): Promise<AnchorLookup | null> {
	const settled = await Promise.all(
		urls.map(async (url): Promise<AnchorLookup | null> => {
			try {
				return new PostcodeBinaryResolver(await fetchBytes(url, fetchImpl)).toAnchorLookup()
			} catch (error) {
				console.warn(
					`[@mailwoman/neural/web/loader] optional postcode anchor binary skipped: ${url} — ` +
						`${error instanceof Error ? error.message : String(error)}. ` +
						"The postcode anchor is a soft ranking channel; the classifier loads without it (degraded ranking only)."
				)

				return null
			}
		})
	)

	const lookups = settled.filter((lookup): lookup is AnchorLookup => lookup !== null)

	return lookups.length ? mergeAnchorLookups(lookups) : null
}

/**
 * Returns the URL of `anchor-lexicon-v1.json` beside the model file.
 */
export function defaultGazetteerLexiconURL(modelURL: string): string {
	return siblingURL(modelURL, "anchor-lexicon-v1.json")
}

function siblingURL(modelURL: string, basename: string): string {
	return modelURL.slice(0, modelURL.lastIndexOf("/") + 1) + basename
}

/**
 * Returns the URL of `country-surface-lexicon-v1.json` beside the model file.
 */
export function defaultCountryLexiconURL(modelURL: string): string {
	return siblingURL(modelURL, "country-surface-lexicon-v1.json")
}

function defaultStreetTypeLexiconURL(modelURL: string, declaredName: string | null): string {
	return siblingURL(modelURL, declaredName ?? "street-type-lexicon-v3.json")
}

function defaultLocalitySurfaceLexiconURL(modelURL: string, declaredName: string | null): string {
	return siblingURL(modelURL, declaredName ?? "locality-surface-lexicon-v6.json")
}

function declaredLexiconName(card: Record<string, unknown> | null, channel: string): string | null {
	const requires = card?.requires as Record<string, { lexicon?: unknown }> | undefined
	const name = requires?.[channel]?.lexicon

	return typeof name === "string" && name ? name : null
}

/**
 * Fetches a model and its assets over HTTP and builds a browser-safe {@link NeuralAddressClassifier}.
 *
 * Optional assets that fail to load are skipped.
 * The loader logs an error when the model declares an input channel that no loaded asset feeds.
 */
export async function loadNeuralClassifierFromURLs(opts: LoadFromURLsOptions): Promise<LoadResult> {
	const fetchImpl = opts.fetchImpl ?? globalThis.fetch

	if (!fetchImpl) {
		throw new Error("no fetch implementation available — pass fetchImpl in non-fetch environments")
	}

	const modelCard = opts.modelCardURL ? await fetchModelCardJSON(opts.modelCardURL, fetchImpl) : null
	const labels = modelCard ? labelsFromModelCard(modelCard, opts.modelCardURL!) : null
	const encoder = encoderDescriptorFromCard(modelCard, opts.modelCardURL ?? "(no card)")

	if (encoder.kind === "char") {
		return loadCharClassifierFromURLs(opts, encoder, labels, fetchImpl)
	}

	if (!opts.tokenizerURL) {
		throw new Error("loadNeuralClassifierFromURLs: the card declares no char encoder, so tokenizerURL is required")
	}

	const gazetteerLexiconURL = lexiconURLFor(opts.gazetteerLexicon, () => defaultGazetteerLexiconURL(opts.modelURL))
	const countryLexiconURL = lexiconURLFor(opts.countryLexicon, () => defaultCountryLexiconURL(opts.modelURL))

	const streetTypeLexiconURL = lexiconURLFor(opts.streetTypeLexicon, () =>
		defaultStreetTypeLexiconURL(opts.modelURL, declaredLexiconName(modelCard, "street_type"))
	)

	const localitySurfaceLexiconURL = lexiconURLFor(opts.localitySurfaceLexicon, () =>
		defaultLocalitySurfaceLexiconURL(opts.modelURL, declaredLexiconName(modelCard, "locality_surface"))
	)

	const [modelBytes, tokenizerBytes, gazetteerLexicon, countryLexicon, streetTypeLexicon, localitySurfaceLexicon] =
		await Promise.all([
			fetchBytes(opts.modelURL, fetchImpl),
			fetchBytes(opts.tokenizerURL, fetchImpl),
			gazetteerLexiconURL ? fetchGazetteerLexicon(gazetteerLexiconURL, fetchImpl) : Promise.resolve(null),
			countryLexiconURL ? fetchCountryLexicon(countryLexiconURL, fetchImpl) : Promise.resolve(null),

			streetTypeLexiconURL ? fetchGazetteerLexicon(streetTypeLexiconURL, fetchImpl) : Promise.resolve(null),
			localitySurfaceLexiconURL ? fetchGazetteerLexicon(localitySurfaceLexiconURL, fetchImpl) : Promise.resolve(null),
		])

	const [tokenizer, runner, postcodeAnchorLookup, pairIndexes] = await Promise.all([
		MailwomanTokenizer.loadFromBase64(toBase64(tokenizerBytes)),
		WebONNXRunner.fromBytes(modelBytes, opts.runner),
		opts.postcodeBinaryURLs?.length
			? loadPostcodeAnchorLookup(opts.postcodeBinaryURLs, fetchImpl)
			: Promise.resolve<AnchorLookup | null>(null),
		opts.pairIndexURLs?.length
			? loadPairIndexes(opts.pairIndexURLs, fetchImpl)
			: Promise.resolve<LoadedPairIndex[]>([]),
	])

	let configPairIndex: PairIndexResolver | null = null

	if (opts.country && pairIndexes.length) {
		const pinnedCountry = resolvePairIndexCountry(opts.country)
		const pinned = pairIndexes.find((index) => index.country === pinnedCountry)

		if (pinned) {
			configPairIndex = pinned.resolver
		} else {
			console.warn(
				`[@mailwoman/neural/web/loader] country "${pinnedCountry}" was requested as the placetype-pair default posture, but no ` +
					`loaded index matches it — loaded header countries: ${pairIndexes.map((index) => `"${index.country}"`).join(", ")}. ` +
					"No config default is set; per-parse selection (selectPairIndexForText) still works for the countries that DID load."
			)
		}
	}

	const addressSystems = modelCard ? parseAddressSystemTable(modelCard.address_systems, opts.modelCardURL!) : null

	const classifier = new NeuralAddressClassifier({
		tokenizer,
		runner,
		...(labels ? { labels } : {}),
		...(addressSystems ? { addressSystems } : {}),
		...(postcodeAnchorLookup ? { postcodeAnchorLookup } : {}),
		...(gazetteerLexicon ? { gazetteerLexicon } : {}),
		...(countryLexicon ? { countryLexicon } : {}),
		...(streetTypeLexicon ? { streetTypeLexicon } : {}),
		...(localitySurfaceLexicon ? { localitySurfaceLexicon } : {}),
		...(configPairIndex ? { placetypePair: { index: configPairIndex } } : {}),
		suppressGazetteerNearPostcode: opts.suppressGazetteerNearPostcode ?? true,
		addressSystemConventions: opts.addressSystemConventions ?? "auto",
		bridgePunctuationGaps: opts.bridgePunctuationGaps ?? true,
	})

	await runner.infer([0])

	warnOnUnfedTrainedChannels(runner, {
		gazetteerLexicon,
		gazetteerLexiconURL,
		countryLexicon,
		countryLexiconURL,
		streetTypeLexicon,
		streetTypeLexiconURL,
		localitySurfaceLexicon,
		localitySurfaceLexiconURL,
		postcodeAnchorLookup,
	})

	return {
		classifier,
		diagnostics: runner.diagnostics,
		labels,
		pairIndexes,
		selectPairIndexForText: (text, selectOpts) => resolvePairIndexForText(pairIndexes, text, selectOpts),

		release: () => runner.release(),
	}
}

function warnOnUnfedTrainedChannels(
	runner: WebONNXRunner,
	fed: {
		gazetteerLexicon: GazetteerLexicon | null
		gazetteerLexiconURL: string | null
		countryLexicon: CountryLexicon | null
		countryLexiconURL: string | null
		streetTypeLexicon: GazetteerLexicon | null
		streetTypeLexiconURL: string | null
		localitySurfaceLexicon: GazetteerLexicon | null
		localitySurfaceLexiconURL: string | null
		postcodeAnchorLookup: AnchorLookup | null
	}
): void {
	const inputNames = runner.inputNames

	if (!inputNames) return

	const declared = inferRequiredChannelsFromInputs(inputNames)

	const unfedLexiconMessage = (
		trainedAs: string,
		input: string,
		noun: string,
		fileName: string,
		url: string | null,
		urlOption: string,
		degrade: string
	): string =>
		`[@mailwoman/neural/web/loader] This model is ${trainedAs} (its ONNX declares \`${input}\`) ` +
		`but no ${noun} was loaded` +
		(url
			? ` — \`${fileName}\` could not be fetched from ${url}. ` +
				`Upload the lexicon next to model.onnx, or pass \`${urlOption}\` explicitly.`
			: ` — \`${urlOption}\` was explicitly disabled (null). `) +
		` Running with zero-filled ${degrade}`

	const unfedEvidenceMessage = (input: string, fileName: string, url: string | null): string =>
		`[@mailwoman/neural/web/loader] This model is evidence-bundle-trained (its ONNX declares \`${input}\`) ` +
		"but no evidence lexicon was loaded" +
		(url
			? ` — \`${fileName}\` could not be fetched from ${url}. Upload the lexicon next to model.onnx.`
			: " — the URL was explicitly disabled (null).") +
		" Fragmented-register parses run with this channel off (the trained absence identity — degraded fragment lift, structurally valid)."

	const channels: Array<{ required: boolean | undefined; fed: boolean; message: string }> = [
		{
			required: declared.country?.required,
			fed: !!fed.countryLexicon,
			message: unfedLexiconMessage(
				"country-channel-trained",
				"country_features",
				"country lexicon",
				"country-surface-lexicon-v1.json",
				fed.countryLexiconURL,
				"countryLexiconURL",
				"country clues: country tagging will be degraded (train/inference mismatch)."
			),
		},
		{
			required: declared.gazetteer?.required,
			fed: !!fed.gazetteerLexicon,
			message: unfedLexiconMessage(
				"gazetteer-anchor-trained",
				"gazetteer_features",
				"gazetteer lexicon",
				"anchor-lexicon-v1.json",
				fed.gazetteerLexiconURL,
				"gazetteerLexiconURL",
				"gazetteer clues: parses will be degraded (train/inference mismatch)."
			),
		},
		{
			required: declared.street_type?.required,
			fed: !!fed.streetTypeLexicon,
			message: unfedEvidenceMessage("street_type_features", "street-type-lexicon-v3.json", fed.streetTypeLexiconURL),
		},
		{
			required: declared.locality_surface?.required,
			fed: !!fed.localitySurfaceLexicon,
			message: unfedEvidenceMessage(
				"locality_surface_features",
				"locality-surface-lexicon-v6.json",
				fed.localitySurfaceLexiconURL
			),
		},
		{
			required: declared.anchor?.required,
			fed: !!fed.postcodeAnchorLookup,
			message:
				"[@mailwoman/neural/web/loader] This model is postcode-anchor-trained (its ONNX declares `anchor_features`) " +
				"but no `postcodeBinaryURLs` were provided (postcode-<cc>.bin). " +
				"Running with zero-filled anchor features: the anchor-off identity, degraded vs the ship config.",
		},
	]

	for (const channel of channels) {
		if (channel.required && !channel.fed) {
			console.error(channel.message)
		}
	}
}

async function fetchTolerantJSON<T>(
	url: string,
	fetchImpl: typeof fetch,
	parse: (raw: unknown) => T
): Promise<T | null> {
	let res: Response

	try {
		res = await fetchImpl(url)
	} catch {
		return null
	}

	if (!res.ok) return null

	return parse(await res.json())
}

async function fetchGazetteerLexicon(url: string, fetchImpl: typeof fetch): Promise<GazetteerLexicon | null> {
	return fetchTolerantJSON(url, fetchImpl, (raw) =>
		parseGazetteerLexicon(raw as Parameters<typeof parseGazetteerLexicon>[0])
	)
}

async function fetchCountryLexicon(url: string, fetchImpl: typeof fetch): Promise<CountryLexicon | null> {
	return fetchTolerantJSON(url, fetchImpl, (raw) =>
		parseCountryLexicon(raw as Parameters<typeof parseCountryLexicon>[0])
	)
}

async function fetchModelCardJSON(url: string, fetchImpl: typeof fetch): Promise<Record<string, unknown> | null> {
	const res = await fetchImpl(url)

	if (!res.ok) {
		if (res.status === HTTP_NOT_FOUND) return null
		throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`)
	}

	return (await res.json()) as Record<string, unknown>
}

function labelsFromModelCard(card: Record<string, unknown>, url: string): readonly string[] | null {
	const labels = card.labels

	if (labels === undefined) return null

	if (!Array.isArray(labels) || !labels.length || !labels.every((l) => typeof l === "string")) {
		throw new Error(
			`model-card at ${url} has a malformed \`labels\` field — ` +
				`expected a non-empty array of strings, got ${stringifyJSON(labels)}.`
		)
	}

	return Object.freeze(labels.slice())
}

function toBase64(bytes: Uint8Array): string {
	const chunkSize = 0x80_00
	let binary = ""

	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize)
		binary += String.fromCharCode(...chunk)
	}

	if (typeof btoa === "function") return btoa(binary)

	return Buffer.from(binary, "binary").toString("base64")
}

async function loadCharClassifierFromURLs(
	opts: LoadFromURLsOptions,
	encoder: Extract<EncoderDescriptor, { kind: "char" }>,
	labels: readonly string[] | null,
	fetchImpl: typeof fetch
): Promise<LoadResult> {
	const charVocabURL = opts.charVocabURL ?? new URL(encoder.charVocab, opts.modelURL).toString()

	const [modelBytes, vocabularyJSON] = await Promise.all([
		fetchBytes(opts.modelURL, fetchImpl),
		fetchImpl(charVocabURL).then(async (response) => {
			if (!response.ok) {
				throw new Error(`failed to fetch char vocabulary ${charVocabURL}: HTTP ${response.status}`)
			}

			return response.json() as Promise<unknown>
		}),
	])

	const runner = await WebONNXRunner.fromBytes(modelBytes, opts.runner)

	const classifier = new NeuralAddressClassifier({
		charEncoder: {
			vocabulary: parseCharVocabulary(vocabularyJSON, charVocabURL),
			interface: { maxUnits: encoder.maxUnits, maxUnitWidth: encoder.maxUnitWidth, ctxChars: encoder.ctxChars },
		},
		runner,
		...(labels ? { labels } : {}),
	})

	return {
		classifier,
		diagnostics: runner.diagnostics,
		labels,
		pairIndexes: [],

		selectPairIndexForText: () => null,

		release: () => runner.release(),
	}
}
