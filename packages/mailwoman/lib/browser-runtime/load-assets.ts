/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The per-release asset loader: the classifier, the calibration table, the FST gazetteer and street-morphology
 *   matchers, the pair indexes, and the byte-range gazetteer lookup for one published release, reporting staged
 *   progress through {@link AssetLoadProgress}. The host owns the terminal ready/error state and reveals the returned
 *   bundle atomically. The onnxruntime-web and sql.js-httpvfs imports stay dynamic so a host that never loads a
 *   release never pays for them.
 */

import type { CalibrationTable, Calibrator } from "@mailwoman/core/decoder/calibration"
import { createCalibrator } from "@mailwoman/core/decoder/calibration"
import type { MailwomanLookupLike } from "@mailwoman/resolver-wof-wasm/browser-cascade"

import type { SelectPairIndex } from "#browser-runtime/classify"
import { DEFAULT_LOCALE } from "#browser-runtime/classify"
import { fetchWithRetry } from "#browser-runtime/fetch"
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
import type {
	AssetLoadProgress,
	FSTMatcherLike,
	FSTProvenanceLike,
	MailwomanClassifierLike,
} from "#browser-runtime/types"

/**
 * What one release loads to: every field a host may read. A host that resolves admin-only ignores `anchorLookup`, and
 * loading it is free because the anchor binaries are already fetched by the classifier load for an anchor-trained
 * bundle.
 */
export interface ReleaseAssets {
	classifier: MailwomanClassifierLike
	/**
	 * Postcode-anchor centroid lookup (US ZIP → real centroid), for the postcode-only dead-end fallback.
	 */
	anchorLookup: Map<string, { lat: number; lon: number }> | null
	fstMatcher: FSTMatcherLike | null
	fstProvenance: FSTProvenanceLike | null
	/**
	 * The street-morphology matcher — the #1315 street-context check's signal source, the node/browser parity fix (SCOPE
	 * invariant 2: node runtimes wire this by default; the browser previously never could). Loaded with the FST gazetteer
	 * because the check needs BOTH (core's `streetContextRequirementFor` only fires when the two stages are present).
	 * `null` when the release ships no `fst-street-morphology.bin` (pre-artifact bundles) — the demo then parses without
	 * the check, byte-identical to before.
	 */
	streetMorphologyMatcher: FSTMatcherLike | null
	/**
	 * The byte-range gazetteer lookup. `null` when the release ships no gazetteer, when the host asked for none, or when
	 * the load failed.
	 */
	lookup: MailwomanLookupLike | null
	calibrator: Calibrator | null
	/**
	 * Per-parse placetype-pair prior selection (placetype-pair-prior arc, #1278). Runs locale-check over the input text
	 * and returns the loaded index whose header country matches (or `undefined` → byte-stable no-prior). Both demo parse
	 * paths thread this into `runClassifyStage` so a GB/NZ input gets its dependent_locality-resurrecting prior. `null`
	 * when no pair index was staged/loaded for this release (older bundles) — the loader then behaves exactly as before.
	 */
	selectPairIndex: SelectPairIndex | null
}

export interface LoadReleaseAssetsOptions {
	/**
	 * Load the byte-range gazetteer lookup, given the same-origin base for the sql.js-httpvfs worker and wasm (for
	 * example `/mailwoman/sqljs`). Omit it and `lookup` is `null` without a gazetteer step.
	 */
	gazetteer?: { sqljsBaseURL: string }
}

/**
 * Load the classifier, calibration, FST and gazetteer bundle for one release. Reports staged progress through
 * `progress`; the host owns the terminal ready/error state and reveals the returned bundle atomically.
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

	// Build staged step labels based on what this release includes.
	const steps: string[] = ["Loading classifier"]

	if (release.hasFST) {
		steps.push("Loading FST gazetteer")
	}

	if (gazetteer) {
		steps.push("Loading WOF database")
	}

	progress.setStepLabels(steps)

	// The pair indexes live on the public bucket beside every other model asset, under a dated generation: the objects
	// ship an immutable Cache-Control, so a rebuilt index is readable only from a fresh path.
	const pairIndexBase = pairIndexBaseURL(PAIR_INDEX_VERSION)

	// Dynamic so the onnxruntime-web chunk loads only when a release does. The result is narrowed to the structural
	// classifier contract this module exposes, so the neural package's own classifier type never enters a host bundle.
	const { loadNeuralClassifierFromURLs } = await import("@mailwoman/neural/web-loader")

	const { classifier, diagnostics, postcodeAnchorLookup, selectPairIndexForText } = (await loadNeuralClassifierFromURLs(
		{
			...neuralClassifierLoadURLs(DEFAULT_LOCALE, release.version, {
				hasAnchor: release.hasAnchor,
				forceWASM: progress.forceWASM,
			}),
			fetchImpl: fetchWithRetry,
			// Every published pair index is loaded; the loader keeps each live and `selectPairIndexForText` picks per
			// parse. Fetched tolerantly: a 404 is skipped, so a missing binary means no prior, never a failed load.
			pairIndexURLs: pairIndexURLs(pairIndexBase),
		}
	)) as {
		classifier: MailwomanClassifierLike
		diagnostics?: { backend: string; modelBytes: number } | null
		postcodeAnchorLookup?: Map<string, { lat: number; lon: number }> | null
		selectPairIndexForText?: SelectPairIndex | null
	}

	progress.setBackend(
		diagnostics ? `${diagnostics.backend} (${(diagnostics.modelBytes / 1024 / 1024).toFixed(0)} MB int8)` : "unknown"
	)

	progress.setStepIndex(0)

	// The calibration table is the model's own held-out reliability, so it must match the loaded version. A release
	// without one leaves `calibrator` null and the host shows raw softmax scores.
	let calibrator: Calibrator | null = null

	try {
		const calRes = await fetchWithRetry(assetURL(DEFAULT_LOCALE, release.version, "calibration.json"))

		if (calRes.ok) {
			calibrator = createCalibrator((await calRes.json()) as CalibrationTable)
		}
	} catch {
		// No calibration table for this version — raw scores it is.
	}

	let fstMatcher: FSTMatcherLike | null = null
	let fstProvenance: FSTProvenanceLike | null = null
	let streetMorphologyMatcher: FSTMatcherLike | null = null

	if (release.hasFST) {
		try {
			const fstResult = await loadFSTGazetteer(DEFAULT_LOCALE, release.version)
			fstMatcher = fstResult.matcher
			fstProvenance = fstResult.provenance ?? null
		} catch {
			// FST not available for this version.
		}

		// The street-context check needs both matchers, so the morphology matcher is loaded only once the gazetteer FST
		// is; a release that predates the artifact answers null and the parse runs with the check off.
		if (fstMatcher) {
			try {
				streetMorphologyMatcher = await loadStreetMorphologyFST(DEFAULT_LOCALE, release.version)
			} catch {
				// Corrupt/unfetchable artifact — treat as absent (check off).
			}
		}
	}

	progress.setStepIndex(1)

	let lookup: MailwomanLookupLike | null = null

	if (gazetteer) {
		try {
			const { loadHTTPVFSDatabase, WOFCandidateTableLookup } =
				await import("@mailwoman/resolver-wof-wasm/httpvfs/resolver")

			const worker = await loadHTTPVFSDatabase(adminGazetteerURL(), gazetteer.sqljsBaseURL)

			if (!progress.signal.aborted) {
				const wofLookup = new WOFCandidateTableLookup(worker)
				// Fire-and-forget: pull the schema/FTS/dual-role pages through the VFS now so the first interactive query
				// starts warm. The worker serializes execs, so a user query issued mid-warm-up simply queues behind pages
				// it was going to need anyway.
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
	}
}
