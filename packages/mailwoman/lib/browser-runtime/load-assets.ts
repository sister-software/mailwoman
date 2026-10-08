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
import type { FSTProvenance } from "@mailwoman/core/pipeline/client-result"
import type { MailwomanLookupLike } from "@mailwoman/resolver-wof-wasm/browser-cascade"

import type { SelectPairIndex } from "#browser-runtime/classify"
import { DEFAULT_LOCALE } from "#browser-runtime/classify"
import { fetchWithProgress, fetchWithRetry } from "#browser-runtime/fetch"
import type { ReleaseInfo } from "#browser-runtime/manifest"
import {
	adminGazetteerURL,
	assetURL,
	loadFSTGazetteer,
	loadStreetMorphologyFST,
	neuralClassifierLoadURLs,
	PAIR_INDEX_VERSION,
	pairIndexBaseURL,
	pairIndexURLs,
} from "#browser-runtime/resources"
import type { AssetLoadProgress, FSTMatcherLike, MailwomanClassifierLike } from "#browser-runtime/types"

/**
 * What one release loads to, with every field a host may read.
 */
export interface ReleaseAssets {
	classifier: MailwomanClassifierLike
	/**
	 * Postcode-anchor centroid lookup (US ZIP → real centroid), for the postcode-only dead-end fallback.
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
	const gazetteer = release.hasWOFDB ? options.gazetteer : undefined

	progress.setProgress(`Loading ${release.version} model (~${release.modelSize ?? "?"})…`)

	const steps: string[] = ["Loading classifier"]

	if (release.hasFST) {
		steps.push("Loading FST gazetteer")
	}

	if (gazetteer) {
		steps.push("Loading WOF database")
	}

	progress.setStepLabels(steps)

	// The pair indexes live on the public bucket beside every other model asset,
	// under a dated generation: the objects ship an immutable Cache-Control,
	// so a rebuilt index is readable only from a fresh path.
	const pairIndexBase = pairIndexBaseURL(PAIR_INDEX_VERSION)

	// Every fetch below starts now, beside the model, rather than when the stage before it finishes.
	// The stages are still awaited in order, so the step labels advance in order.
	const ortWASMURL = options.ortWASMURL

	const wasmBinary = ortWASMURL
		? settleOptional(
				fetchWithRetry(ortWASMURL).then(async (res) => (res.ok ? new Uint8Array(await res.arrayBuffer()) : null))
			)
		: null

	const calibrationLoad = settleOptional(
		fetchWithRetry(assetURL(DEFAULT_LOCALE, release.version, "calibration.json")).then(async (res) =>
			// A release without a table leaves `calibrator` null and the host shows raw softmax scores.
			res.ok ? createCalibrator((await res.json()) as CalibrationTable) : null
		)
	)

	// The street-context check needs both matchers, so the morphology matcher is kept only beside the FST.
	// A release that predates the morphology artifact answers null, and the parse runs with the check off.
	const fstLoad = release.hasFST ? settleOptional(loadFSTGazetteer(DEFAULT_LOCALE, release.version)) : null

	const streetMorphologyLoad = release.hasFST
		? settleOptional(loadStreetMorphologyFST(DEFAULT_LOCALE, release.version))
		: null

	// Dynamic so the onnxruntime-web chunk loads only when a release does.
	// The result is narrowed to the structural classifier interface this module exposes,
	// so the neural package's own classifier type never enters a host bundle.
	const { loadNeuralClassifierFromURLs } = await import("@mailwoman/neural/web/loader")

	// The model is the only artifact whose transfer a visitor waits on, tens of megabytes against
	// kilobytes for every lexicon beside it, so it is the only one whose bytes reach the bar.
	// Each smaller asset would move the bar backwards if the loader reported it when loading began.
	const reportBytes = progress.setByteFraction

	const modelFetch = reportBytes
		? fetchWithProgress(
				(received, total) => reportBytes(total ? Math.min(1, received / total) : null),
				(url) => url.endsWith(".onnx")
			)
		: fetchWithRetry

	const {
		classifier,
		diagnostics,
		postcodeAnchorLookup,
		selectPairIndexForText,
		// `release` is the ReleaseInfo parameter in this scope. The classifier's disposer needs its own name.
		release: releaseClassifier,
	} = (await loadNeuralClassifierFromURLs({
		...neuralClassifierLoadURLs(DEFAULT_LOCALE, release.version, {
			hasAnchor: release.hasAnchor,
			splitEmbeddings: release.splitEmbeddings,
		}),
		...(wasmBinary ? { runner: { wasmBinary } } : {}),
		fetchImpl: modelFetch,
		// Every published pair index is loaded.
		// The loader keeps each live and `selectPairIndexForText` picks per parse.
		// Fetched tolerantly: a 404 is skipped, so a missing binary means no prior, never a failed load.
		pairIndexURLs: pairIndexURLs(pairIndexBase),
	})) as {
		classifier: MailwomanClassifierLike
		diagnostics?: { backend: string; modelBytes: number } | null
		postcodeAnchorLookup?: Map<string, { lat: number; lon: number }> | null
		selectPairIndexForText?: SelectPairIndex | null
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
				// The worker serializes queries, so a user query issued mid-warm-up simply
				// queues behind pages it was going to need anyway.
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
		anchorLookup: postcodeAnchorLookup ?? null,
		fstMatcher,
		fstProvenance,
		streetMorphologyMatcher,
		lookup,
		calibrator,
		selectPairIndex: selectPairIndexForText ?? null,
		release: async () => {
			await releaseClassifier?.()
		},
	}
}
