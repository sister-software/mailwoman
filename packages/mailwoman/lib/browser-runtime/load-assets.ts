/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The per-release asset loader: the classifier, the calibration table, the FST gazetteer and street-morphology
 *   matchers, the pair indexes and the byte-range gazetteer lookup for one published release. It reports staged
 *   progress through {@link AssetLoadProgress}. The host owns the terminal ready/error state and reveals the returned
 *   bundle atomically. The onnxruntime-web and range-reader imports stay dynamic so a host that never loads a
 *   release never pays for them.
 */

import type { CalibrationTable, Calibrator } from "@mailwoman/core/decoder/calibration"
import { createCalibrator } from "@mailwoman/core/decoder/calibration"
import type { AnchorRegionLookupLike } from "@mailwoman/core/pipeline"
import type { FSTProvenance } from "@mailwoman/core/pipeline/client-result"
import type { MailwomanLookupLike } from "@mailwoman/resolver-wof-wasm/browser-cascade"

import type { SelectPairIndex } from "#browser-runtime/classify"
import { DEFAULT_LOCALE } from "#browser-runtime/classify"
import { fetchWithProgress, fetchWithRetry, prefetchingFetch } from "#browser-runtime/fetch"
import {
	fetchPairIndexManifest,
	postcodeAnchorFilesOf,
	postcodeCentroidFilesOf,
	postcodePrefixFilesOf,
	type ReleaseInfo,
} from "#browser-runtime/manifest"
import { loadPostcodeCentroids, mergePostcodeCentroids } from "#browser-runtime/postcode-fallback"
import {
	adminGazetteerURL,
	assetURL,
	charClassifierLoadURLs,
	isCharClassifierLoadURLs,
	loadFSTGazetteer,
	loadStreetMorphologyFST,
	neuralClassifierLoadURLs,
	PAIR_INDEX_VERSION,
} from "#browser-runtime/resources"
import type { AssetLoadProgress, FSTMatcherLike, MailwomanClassifierLike } from "#browser-runtime/types"

/**
 * What one release loads to, with every field a host may read.
 */
export interface ReleaseAssets {
	classifier: MailwomanClassifierLike
	/**
	 * The centroid per postcode key the postcode-only dead-end fallback reads.
	 *
	 * It holds the classifier's postcode anchors (the release's `postcodeAnchors`, US ZIP Codes today) and
	 * the fallback-only binaries the release lists under `postcodeCentroids`, such as Japanese postcodes.
	 */
	anchorLookup: Map<string, { lat: number; lon: number }> | null
	fstMatcher: FSTMatcherLike | null
	fstProvenance: FSTProvenance | null
	/**
	 * The street-morphology matcher, the signal source for the street-context check.
	 *
	 * Loaded with the FST gazetteer because the check needs both
	 * (core's `streetContextRequirementFor` only fires when the two stages are present).
	 * `null` when the release ships no `fst-street-morphology.bin`, in
	 * which case the demo parses with the check off.
	 */
	streetMorphologyMatcher: FSTMatcherLike | null
	/**
	 * The anchor-region lookup over the release's postcode-prefix indexes, `null`
	 * when the release lists none or every fetch failed.
	 * The anchor-region prior is then off.
	 */
	anchorRegions: AnchorRegionLookupLike | null
	/**
	 * The byte-range gazetteer lookup, `null` when the release ships no gazetteer,
	 * when the host asked for none, or when the load failed.
	 */
	lookup: MailwomanLookupLike | null
	/**
	 * Give this bundle's native memory back.
	 *
	 * The ONNX session's weights and arenas live in the wasm heap outside the JavaScript heap
	 * and are not reclaimed by dropping this object.
	 *
	 * A host that loads a second bundle over a page's life (a version switch,
	 * a backend-force toggle, compare mode) must call this on the one it is replacing.
	 */
	release: () => Promise<void>
	calibrator: Calibrator | null
	/**
	 * Per-parse placetype-pair prior selection.
	 *
	 * Runs locale-check over the input text and returns the loaded index whose header
	 * country matches, or `undefined` for a byte-stable no-prior result.
	 * Both demo parse paths thread this into `runClassifyStage` so a GB/NZ input
	 * gets its dependent_locality-resurrecting prior.
	 *
	 * `null` when no pair index was staged or loaded for this release.
	 */
	selectPairIndex: SelectPairIndex | null
}

export interface LoadReleaseAssetsOptions {
	/**
	 * Load the byte-range gazetteer lookup, given the same-origin base for the staged
	 * range worker and sqlite-wasm runtime (for example `/mailwoman/sqlite`).
	 *
	 * Omit it and `lookup` is `null` without a gazetteer step.
	 */
	gazetteer?: { sqliteRuntimeBaseURL: string }

	/**
	 * The URL of the onnxruntime-web `.wasm` binary the host's bundle serves.
	 *
	 * Given it, the loader downloads the binary beside the model and hands it to the session.
	 * Without it, onnxruntime-web requests the binary after the model has arrived.
	 */
	ortWASMURL?: string

	/**
	 * The bucket directory the release lives under, `en-us` by default.
	 *
	 * A weights family such as `cjk` publishes its releases under its own directory.
	 */
	locale?: string
}

/**
 * Resolve an optional asset load to its value, or to `null` when it throws.
 *
 * Every optional fetch starts at the top of {@link loadReleaseAssets} and is awaited later.
 * Its failure settles at once, so an earlier stage's await never sees an unhandled rejection.
 */
function settleOptional<T>(load: Promise<T>): Promise<T | null> {
	return load.catch(() => null)
}

/**
 * Load the classifier, calibration, FST and gazetteer bundle for one release,
 * reporting staged progress through `progress`.
 *
 * The host owns the terminal ready/error state and reveals the returned bundle atomically.
 *
 * @param release The selected release descriptor (drives which optional assets are fetched).
 * @param progress The host's progress and abort surface.
 * @param options Which optional assets the host wants beyond the release's own.
 */
export async function loadReleaseAssets(
	release: ReleaseInfo,
	progress: AssetLoadProgress,
	options: LoadReleaseAssetsOptions = {}
): Promise<ReleaseAssets> {
	const gazetteer = release.hasWOFDB ? options.gazetteer : null
	const locale = options.locale ?? DEFAULT_LOCALE

	progress.setProgress(`Loading ${release.version} model (~${release.modelSize ?? "?"})…`)

	const steps: string[] = ["Loading classifier"]

	if (release.hasFST) {
		steps.push("Loading FST gazetteer")
	}

	if (gazetteer) {
		steps.push("Loading WOF database")
	}

	progress.setStepLabels(steps)

	// Every fetch below starts now, beside the model, rather than when the stage before it finishes.
	// The stages are still awaited in order, so the step labels advance in order.
	const ortWASMURL = options.ortWASMURL

	const wasmBinary = ortWASMURL
		? settleOptional(
				fetchWithRetry(ortWASMURL).then(async (res) => (res.ok ? new Uint8Array(await res.arrayBuffer()) : null))
			)
		: null

	// A release without a table leaves `calibrator` null and the host shows raw softmax scores.
	// An entry that declares no table skips the request, so the page logs no 404 for it.
	const calibrationLoad =
		release.hasCalibration === false
			? Promise.resolve(null)
			: settleOptional(
					fetchWithRetry(assetURL(locale, release.version, "calibration.json")).then(async (res) =>
						res.ok ? createCalibrator((await res.json()) as CalibrationTable) : null
					)
				)

	// The street-context check needs both matchers, so the morphology matcher is kept only beside the FST.
	// A release that predates the morphology artifact answers null, and the parse runs with the check off.
	const fstLoad = release.hasFST ? settleOptional(loadFSTGazetteer(locale, release.version)) : null

	const streetMorphologyLoad = release.hasFST ? settleOptional(loadStreetMorphologyFST(locale, release.version)) : null

	// The pair-index generation's manifest lists the countries whose binaries the bucket holds.
	// It is a small fetch that starts here and is awaited only where the URL set is built.
	const pairIndexManifestLoad = settleOptional(fetchPairIndexManifest(PAIR_INDEX_VERSION))

	// The fallback-only postcode binaries are small and independent of the model, so they load beside it.
	// After a failed fetch, the fallback reads the classifier's anchors and no other binary.
	const postcodeCentroidLoad = settleOptional(
		loadPostcodeCentroids(
			postcodeCentroidFilesOf(release).map((file) => assetURL(locale, release.version, file)),
			fetchWithRetry
		)
	)

	// The model is the only artifact whose transfer a visitor waits on, tens of megabytes against
	// kilobytes for every lexicon beside it, so it is the only one whose bytes reach the bar.
	// Each smaller asset would move the bar backwards if the loader reported it when loading began.
	const reportBytes = progress.setByteFraction

	const progressFetch = reportBytes
		? fetchWithProgress(
				(received, total) => reportBytes(total ? Math.min(1, received / total) : null),
				(url) => url.endsWith(".onnx")
			)
		: fetchWithRetry

	const pairIndexManifest = await pairIndexManifestLoad

	// A character-encoder release reads code points through its vocabulary and ships none of
	// the Latin family's retrieval artifacts, so its URL set is the three files of the graph.
	const classifierURLs =
		release.encoder === "char"
			? charClassifierLoadURLs(locale, release.version)
			: neuralClassifierLoadURLs(locale, release.version, {
					postcodeAnchors: postcodeAnchorFilesOf(release),
					pairIndexCountries: pairIndexManifest?.countries ?? [],
					postcodePrefixes: postcodePrefixFilesOf(release),
					splitEmbeddings: release.splitEmbeddings,
				})

	// The card, model, embedding and vocabulary URLs are known now.
	// Their fetches start before the loader chunk arrives.
	// The loader reads each through `modelFetch` and reports a failure with its own message.
	const prefetchURLs = isCharClassifierLoadURLs(classifierURLs)
		? [classifierURLs.modelCardURL, classifierURLs.modelURL, classifierURLs.charVocabURL]
		: [
				classifierURLs.modelCardURL,
				classifierURLs.modelURL,
				...(classifierURLs.embeddings ? [classifierURLs.embeddings.hotURL] : []),
				classifierURLs.tokenizerURL,
			]

	const modelFetch = prefetchingFetch(progressFetch, prefetchURLs)

	// Dynamic so the onnxruntime-web chunk loads only when a release does.
	// The result is narrowed to the structural classifier interface this module exposes,
	// so the neural package's own classifier type never enters a host bundle.
	const { loadNeuralClassifierFromURLs } = await import("@mailwoman/neural/web/loader")

	const {
		classifier,
		diagnostics,
		postcodeAnchorLookup,
		selectPairIndexForText,
		anchorRegions,
		// `release` is the ReleaseInfo parameter in this scope. The classifier's disposer needs its own name.
		release: releaseClassifier,
	} = (await loadNeuralClassifierFromURLs({
		...classifierURLs,
		...(wasmBinary ? { runner: { wasmBinary } } : {}),
		fetchImpl: modelFetch,
	})) as {
		classifier: MailwomanClassifierLike
		diagnostics?: { backend: string; modelBytes: number } | null
		postcodeAnchorLookup?: Map<string, { lat: number; lon: number }> | null
		selectPairIndexForText?: SelectPairIndex | null
		anchorRegions?: AnchorRegionLookupLike | null
		release?: () => Promise<void>
	}

	progress.setBackend(
		diagnostics ? `${diagnostics.backend} (${(diagnostics.modelBytes / 1024 / 1024).toFixed(0)} MB int8)` : "unknown"
	)

	// The model is in, so the byte channel goes quiet rather than holding its last value at 100%.
	progress.setByteFraction?.(null)
	progress.setStepIndex(0)

	// The calibration table is the model's own held-out reliability, so it must match the loaded version.
	const calibrator: Calibrator | null = await calibrationLoad

	const fstResult = fstLoad ? await fstLoad : null
	const fstMatcher: FSTMatcherLike | null = fstResult?.matcher ?? null
	const fstProvenance: FSTProvenance | null = fstResult?.provenance ?? null
	const streetMorphology = streetMorphologyLoad ? await streetMorphologyLoad : null
	const streetMorphologyMatcher: FSTMatcherLike | null = fstMatcher ? streetMorphology : null

	progress.setStepIndex(1)

	let lookup: MailwomanLookupLike | null = null

	if (gazetteer) {
		try {
			const [{ openRangeDatabase }, { WOFCandidateTableLookup }] = await Promise.all([
				import("@mailwoman/resolver-wof-wasm/httpvfs/database"),
				import("@mailwoman/resolver-wof-wasm/httpvfs/resolver"),
			])

			const database = await openRangeDatabase(adminGazetteerURL(), gazetteer.sqliteRuntimeBaseURL)

			if (!progress.signal.aborted) {
				const wofLookup = new WOFCandidateTableLookup(database)
				// Fire-and-forget: pull the schema, code-table and upper B-tree pages through
				// the VFS now so the first interactive query starts warm.
				// The worker serializes queries, so a user query issued mid-warm-up queues
				// behind pages it was going to need anyway.
				void wofLookup.warmUp().catch(() => {})
				lookup = wofLookup
			}
		} catch {
			// WOF DB not available for this version.
		}
	}

	progress.setStepIndex(2)

	return {
		classifier,
		anchorLookup: mergePostcodeCentroids(postcodeAnchorLookup ?? null, await postcodeCentroidLoad),
		fstMatcher,
		fstProvenance,
		streetMorphologyMatcher,
		anchorRegions: anchorRegions ?? null,
		lookup,
		calibrator,
		selectPairIndex: selectPairIndexForText ?? null,
		release: async () => {
			await releaseClassifier?.()
		},
	}
}
