/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The one docs-side per-version asset loader, shared by BOTH demo entry points — the `/demo` page
 *   runtime (`pages/demo/_runtime.ts`) and the MDX-embed context (`contexts/DemoEmbed.tsx`). It loads
 *   the classifier + calibration table + FST gazetteer + WOF HTTP-VFS lookup for one release, reporting
 *   staged progress through the injected {@link DemoAssetsLoadContext}. `useDemoRuntime` (in
 *   `@mailwoman/react`) owns the terminal ready/error state and reveals the returned bundle atomically.
 *
 *   Both entry points previously carried near-identical copies of this sequence, and they had drifted:
 *   the embed context inlined the classifier URLs and dropped the postcode-anchor centroid lookup the
 *   `/demo` page kept. Consolidating here restores the anchor capture on both paths and gives the two a
 *   single load contract that can't silently diverge again. The onnxruntime-web + sql.js-httpvfs imports
 *   stay dynamic so they never enter the `@mailwoman/react` package graph.
 */

import type { DemoAssetsLoadContext } from "@mailwoman/react"

import type { Calibrator, ReleaseInfo, SelectPairIndex } from "./demo-helpers.ts"
import { createCalibrator, DEFAULT_LOCALE } from "./demo-helpers.ts"
import type { FSTMatcherLike, FSTProvenanceLike, MailwomanClassifierLike, MailwomanLookupLike } from "./resources.tsx"
import {
	adminGazetteerURL,
	assetURL,
	loadFSTGazetteer,
	neuralClassifierLoadURLs,
	pairIndexStagedURLs,
} from "./resources.tsx"

/**
 * The docs-side asset bundle `useDemoRuntime` loads + holds for the selected version (opaque to the package). The map
 * runtime reads every field; the MDX-embed context re-projects only the subset its flat `DemoEmbedState` exposes (it
 * ignores `anchorLookup`, which has no dead-end fallback in the embed's admin-only cascade — but loading it is free,
 * since the anchor binaries are already fetched by the classifier load for any anchor-trained bundle).
 */
export interface DocsDemoAssets {
	classifier: MailwomanClassifierLike
	/** Postcode-anchor centroid lookup (US ZIP → real centroid), for the postcode-only dead-end fallback. */
	anchorLookup: Map<string, { lat: number; lon: number }> | null
	fstMatcher: FSTMatcherLike | null
	fstProvenance: FSTProvenanceLike | null
	lookup: MailwomanLookupLike | null
	calibrator: Calibrator | null
	/**
	 * Per-parse placetype-pair prior selection (placetype-pair-prior arc, #1278). Runs locale-gate over the input text
	 * and returns the loaded index whose header country matches (or `undefined` → byte-stable no-prior). Both demo parse
	 * paths thread this into `runClassifyStage` so a GB/NZ input gets its dependent_locality-resurrecting prior. `null`
	 * when no pair index was staged/loaded for this release (older bundles) — the seam then behaves exactly as before.
	 */
	selectPairIndex: SelectPairIndex | null
}

/**
 * Load the classifier + calibration + FST + WOF bundle for one release. Reports staged progress via `ctx`;
 * `useDemoRuntime` owns the terminal ready/error state and reveals the returned bundle atomically.
 *
 * @param release The selected release descriptor (drives which optional assets are fetched).
 * @param ctx The runtime-injected progress/abort surface owned by `useDemoRuntime`.
 * @param sqljsBaseURL Same-origin base for the sql.js-httpvfs worker + wasm (e.g. `/mailwoman/sqljs`).
 */
export async function loadDemoAssets(
	release: ReleaseInfo,
	ctx: DemoAssetsLoadContext,
	sqljsBaseURL: string
): Promise<DocsDemoAssets> {
	ctx.setProgress(`Loading ${release.version} model (~${release.modelSize ?? "?"})…`)

	// Build staged step labels based on what this release includes.
	const steps: string[] = ["Loading classifier"]

	if (release.hasFST) {
		steps.push("Loading FST gazetteer")
	}

	if (release.hasWOFDb) {
		steps.push("Loading WOF database")
	}
	ctx.setStepLabels(steps)

	// Same-origin base for the staged placetype-pair indexes (#1278) — mirrors how `sqljsBaseURL` names the sql.js
	// worker dir (`…/mailwoman/sqljs`); the plugin stages the pair binaries as its sibling (`…/mailwoman/pair-index`).
	const pairIndexBaseURL = sqljsBaseURL.replace(/sqljs\/?$/, "pair-index")

	// Dynamic import @mailwoman/neural-web — the webpack alias resolves this to the browser-safe entry. The runtime
	// API is wider than its TS types (the bundle ships `postcodeAnchorLookup` the declaration omits), so we reach the
	// runtime shape through `unknown`.
	const neuralWeb = await import("@mailwoman/neural-web")
	const { classifier, diagnostics, postcodeAnchorLookup, selectPairIndexForText } =
		(await neuralWeb.loadNeuralClassifierFromURLs({
			...neuralClassifierLoadURLs(DEFAULT_LOCALE, release.version, {
				hasAnchor: release.hasAnchor,
				forceWASM: ctx.forceWASM,
			}),
			// Placetype-pair prior (#1278): the GB/NZ dependent_locality retrieval channel. Staged SAME-ORIGIN by the
			// demo-assets plugin (the `pair-index-<cc>.bin` files are not on R2 yet — that's the release-train repoint).
			// Load ALL of them; the loader keeps each live and `selectPairIndexForText` picks per parse via locale-gate.
			// Fetched tolerantly — a 404 (e.g. a build with no staged binary) is skipped, so this is byte-stable when absent.
			pairIndexURLs: pairIndexStagedURLs(pairIndexBaseURL),
		})) as unknown as {
			classifier: MailwomanClassifierLike
			diagnostics?: { backend: string; modelBytes: number } | null
			postcodeAnchorLookup?: Map<string, { lat: number; lon: number }> | null
			selectPairIndexForText?: SelectPairIndex | null
		}

	ctx.setBackend(
		diagnostics ? `${diagnostics.backend} (${(diagnostics.modelBytes / 1024 / 1024).toFixed(0)} MB int8)` : "unknown"
	)

	// Step 0 complete: classifier loaded.
	ctx.setStepIndex(0)

	// Isotonic confidence calibration (#59): turns the version's `calibration.json` table into a (raw)=>calibrated map.
	// Tolerate a 404 — pre-v4.0.0 bundles ship no table, in which case the demo shows raw softmax scores (and says so).
	// The table is the model's OWN held-out reliability, so it must match the loaded version.
	let calibrator: Calibrator | null = null

	try {
		const calRes = await fetch(assetURL(DEFAULT_LOCALE, release.version, "calibration.json"))

		if (calRes.ok) {
			calibrator = createCalibrator(await calRes.json())
		}
	} catch {
		// No calibration table for this version — raw scores it is.
	}

	let fstMatcher: FSTMatcherLike | null = null
	let fstProvenance: FSTProvenanceLike | null = null

	if (release.hasFST) {
		try {
			const fstResult = await loadFSTGazetteer(DEFAULT_LOCALE, release.version)
			fstMatcher = fstResult.matcher
			fstProvenance = fstResult.provenance ?? null
		} catch {
			// FST not available for this version.
		}
	}

	// Step 1 complete: FST loaded (or skipped).
	ctx.setStepIndex(1)

	let lookup: MailwomanLookupLike | null = null

	if (release.hasWOFDb) {
		try {
			const { loadHTTPVFSDatabase, WOFCandidateTableLookup } = await import("./httpvfs-resolver")
			const worker = await loadHTTPVFSDatabase(adminGazetteerURL(), sqljsBaseURL)

			if (!ctx.signal.aborted) {
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

	// Step 2 complete: all assets loaded.
	ctx.setStepIndex(2)

	return {
		classifier,
		anchorLookup: postcodeAnchorLookup ?? null,
		fstMatcher,
		fstProvenance,
		lookup,
		calibrator,
		selectPairIndex: selectPairIndexForText ?? null,
	}
}
