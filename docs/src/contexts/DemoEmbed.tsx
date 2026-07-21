/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared React context for the Mailwoman demo. Manages classifier / FST / WOF lookup loading so
 *   multiple PipelineExplorer instances on the same page (or the main demo page) share one set of
 *   loaded assets instead of re-fetching on mount.
 *
 *   The load ORCHESTRATION — the version-selection state machine, the per-version load sequencing, the
 *   ready / loading / error state — is owned by `@mailwoman/react`'s `useDemoRuntime`. This provider
 *   supplies the DOCS-SIDE fetchers as injected async functions: the releases manifest, the ONNX
 *   classifier (onnxruntime-web; WASM SIMD with WebGPU fallback), the FST gazetteer, the WOF HTTP-VFS
 *   lookup, and the calibration table. Keeping the fetchers here (not in the package) is what holds
 *   onnxruntime-web + sql.js-httpvfs out of `@mailwoman/react`'s import graph. The provider then
 *   re-projects the loaded bundle onto the flat `DemoEmbedState` its consumers have always read — the
 *   public context shape is unchanged.
 */

import type { DemoAssetsLoadContext, DemoManifest } from "@mailwoman/react"
import { useDemoRuntime } from "@mailwoman/react"
import type React from "react"
import { createContext, useCallback, useContext, useEffect, useMemo } from "react"

import type { Calibrator, ReleaseInfo, ReleasesManifest } from "../shared/demo-helpers.ts"
import { createCalibrator, DEFAULT_LOCALE, normalizeReleasesManifest } from "../shared/demo-helpers.ts"
import { pruneDBRangeCache, registerRangeCacheServiceWorker } from "../shared/register-range-sw.ts"
import type {
	FSTMatcherLike,
	FSTProvenanceLike,
	MailwomanClassifierLike,
	MailwomanLookupLike,
} from "../shared/resources.tsx"
import { adminGazetteerURL, assetURL, loadFSTGazetteer } from "../shared/resources.tsx"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { ReleaseInfo, ReleasesManifest } from "../shared/demo-helpers.ts"

export interface DemoEmbedState {
	/** The releases manifest (fetched once on mount). */
	manifest: ReleasesManifest | null
	/** Currently selected version string. */
	selectedVersion: string | null
	/** The loaded neural classifier (onnxruntime-web). */
	classifier: MailwomanClassifierLike | null
	/** The loaded FST gazetteer matcher. */
	fstMatcher: FSTMatcherLike | null
	/** Provenance metadata for the FST binary. */
	fstProvenance: FSTProvenanceLike | null
	/** The instantiated, cached WOF HTTP-VFS lookup. Loaded eagerly by the provider. */
	lookup: MailwomanLookupLike | null
	/**
	 * Maps a raw span confidence → its calibrated probability of correctness, built from the version's `calibration.json`
	 * (isotonic table). `null` while loading or for a release that ships no calibration table. The demo applies it so a
	 * displayed "97%" means ~97% correct — the capability a search index can't offer
	 * (`docs/articles/evals/calibration/*-calibration-*.md`).
	 */
	calibrator: Calibrator | null
	/** Human-readable loading progress string. */
	loadingProgress: string
	/** Current loading step index (0-based). Used by staged LoadingIndicator. */
	loadingStepIndex: number
	/** Step labels for the staged loading indicator. */
	loadingStepLabels: string[]
	/** Error message if loading failed. */
	errorMessage: string | null
	/** Whether ALL selected-version assets (classifier + FST) are loaded and ready. */
	ready: boolean
	/** Backend diagnostic string (e.g. "webgpu (27 MB int8)"). */
	activeBackend: string
	/** Switch to a different version. Triggers asset reload. */
	selectVersion: (version: string) => void
	/** Force CPU WASM backend instead of WebGPU. */
	setForceWASM: (v: boolean) => void
	/** Whether WASM is forced. */
	forceWASM: boolean
}

/**
 * The docs-side asset bundle `useDemoRuntime` loads + holds for the selected version. Opaque to the package (which only
 * sequences the load); this provider re-projects it onto the flat {@link DemoEmbedState} its consumers read.
 */
interface DocsDemoAssets {
	classifier: MailwomanClassifierLike
	fstMatcher: FSTMatcherLike | null
	fstProvenance: FSTProvenanceLike | null
	lookup: MailwomanLookupLike | null
	calibrator: Calibrator | null
}

const DemoEmbedContext = createContext<DemoEmbedState | null>(null)

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDemoEmbed(): DemoEmbedState {
	const ctx = useContext(DemoEmbedContext)

	if (!ctx) {
		throw new Error("useDemoEmbed must be used within a <DemoEmbedProvider>")
	}

	return ctx
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface DemoEmbedProviderProps {
	/** Base URL for the sql.js-httpvfs worker + wasm (same-origin, e.g. `/mailwoman/sqljs`). */
	sqljsBaseURL: string
	children: React.ReactNode
}

export const DemoEmbedProvider: React.FC<DemoEmbedProviderProps> = ({ sqljsBaseURL, children }) => {
	// Fetch + normalize the releases manifest. `useDemoRuntime` runs this once on mount, then selects
	// its `defaultVersion`. Returns the full `ReleasesManifest` (a structural superset of the package's
	// `DemoManifest` — it also carries `locale`), so the value below can re-expose it as `ReleasesManifest`.
	const loadManifest = useCallback(async (): Promise<DemoManifest<ReleaseInfo> | null> => {
		try {
			const res = await fetch(assetURL(DEFAULT_LOCALE, "", "releases.json").replace(/\/\/releases/, "/releases"))

			return res.ok ? normalizeReleasesManifest(await res.json()) : null
		} catch (error) {
			console.error("Failed to load releases manifest", error)
			throw error
		}
	}, [])

	// Load the classifier + calibration + FST + WOF bundle for one release. Reports staged progress via
	// `ctx`; `useDemoRuntime` owns the terminal ready/error state and reveals the returned bundle atomically.
	const loadAssets = useCallback(
		async (release: ReleaseInfo, ctx: DemoAssetsLoadContext): Promise<DocsDemoAssets> => {
			try {
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

				// Dynamic import @mailwoman/neural-web — the webpack alias resolves this to the browser-safe
				// entry. TypeScript types are narrower than the runtime API so we cast through unknown (same
				// pattern as the demo page).
				const neuralWeb = await import("@mailwoman/neural-web")
				const { classifier, diagnostics } = (await neuralWeb.loadNeuralClassifierFromURLs({
					modelURL: assetURL(DEFAULT_LOCALE, release.version, "model.onnx"),
					tokenizerURL: assetURL(DEFAULT_LOCALE, release.version, "tokenizer.model"),
					modelCardURL: assetURL(DEFAULT_LOCALE, release.version, "model-card.json"),
					// Gazetteer-anchor lexicon (#464): REQUIRED by gazetteer-trained bundles (v4.2.0+). The
					// loader tolerates a 404 for older bundles (logging loudly when the model needed it).
					gazetteerLexiconURL: assetURL(DEFAULT_LOCALE, release.version, "anchor-lexicon-v1.json"),
					runner: { useWebGPU: !ctx.forceWASM },
					...(release.hasAnchor
						? {
								postcodeBinaryURLs: [
									assetURL(DEFAULT_LOCALE, release.version, "postcode-us.bin"),
									assetURL(DEFAULT_LOCALE, release.version, "postcode-de.bin"),
									assetURL(DEFAULT_LOCALE, release.version, "postcode-fr.bin"),
								],
							}
						: {}),
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
				})) as unknown as any as {
					classifier: MailwomanClassifierLike
					diagnostics?: { backend: string; modelBytes: number } | null
				}
				ctx.setBackend(
					diagnostics
						? `${diagnostics.backend} (${(diagnostics.modelBytes / 1024 / 1024).toFixed(0)} MB int8)`
						: "unknown"
				)

				// Step 0 complete: classifier loaded.
				ctx.setStepIndex(0)

				// Isotonic confidence calibration (#59): turns the version's `calibration.json` table into a
				// (raw)=>calibrated map. Tolerate a 404 — pre-v4.0.0 bundles ship no table, in which case the
				// demo shows raw softmax scores (and says so). The table is the model's OWN held-out
				// reliability, so it must match the loaded version.
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
						// FST not available for this version
					}
				}

				// Step 1 complete: FST loaded (or skipped).
				ctx.setStepIndex(1)

				let lookup: MailwomanLookupLike | null = null

				if (release.hasWOFDb) {
					try {
						const { loadHTTPVFSDatabase, WOFCandidateTableLookup } = await import("../shared/httpvfs-resolver")
						const worker = await loadHTTPVFSDatabase(adminGazetteerURL(), sqljsBaseURL)

						if (!ctx.signal.aborted) {
							const wofLookup = new WOFCandidateTableLookup(worker)
							// Fire-and-forget: pull the schema/FTS/dual-role pages through the VFS now so the first
							// interactive query starts warm. The worker serializes execs, so a user query issued
							// mid-warm-up simply queues behind pages it was going to need anyway.
							void wofLookup.warmUp().catch(() => {})
							lookup = wofLookup
						}
					} catch {
						// WOF DB not available for this version
					}
				}

				// Step 2 complete: all assets loaded.
				ctx.setStepIndex(2)

				return { classifier, fstMatcher, fstProvenance, lookup, calibrator }
			} catch (error) {
				console.error("Error loading resources", error)
				throw error
			}
		},
		[sqljsBaseURL]
	)

	const rt = useDemoRuntime<DocsDemoAssets, ReleaseInfo>({ loadManifest, loadAssets })

	// Mount: register the range-chunk service worker (docs-only; persists validated DB range chunks
	// across visits; see static/range-cache-sw.js). The provider only receives sqljsBaseURL
	// (`${baseURL}mailwoman/sqljs`), so the site base is recovered by stripping the staged suffix.
	useEffect(() => {
		registerRangeCacheServiceWorker(sqljsBaseURL.replace(/mailwoman\/sqljs\/?$/, ""))
	}, [sqljsBaseURL])

	// Drop cached range chunks from other (immutable, never-expiring) versions.
	useEffect(() => {
		if (rt.selectedVersion) {
			pruneDBRangeCache(rt.selectedVersion)
		}
	}, [rt.selectedVersion])

	const value = useMemo<DemoEmbedState>(
		() => ({
			// The runtime object is the `ReleasesManifest` `loadManifest` returned (the package stores it
			// verbatim), so re-widening the type here is sound — it carries `locale` at run time.
			manifest: rt.manifest as ReleasesManifest | null,
			selectedVersion: rt.selectedVersion,
			classifier: rt.assets?.classifier ?? null,
			fstMatcher: rt.assets?.fstMatcher ?? null,
			fstProvenance: rt.assets?.fstProvenance ?? null,
			lookup: rt.assets?.lookup ?? null,
			calibrator: rt.assets?.calibrator ?? null,
			loadingProgress: rt.loadingProgress,
			loadingStepIndex: rt.loadingStepIndex,
			loadingStepLabels: rt.loadingStepLabels,
			errorMessage: rt.errorMessage,
			ready: rt.ready,
			activeBackend: rt.activeBackend,
			selectVersion: rt.selectVersion,
			setForceWASM: rt.setForceWASM,
			forceWASM: rt.forceWASM,
		}),
		[rt]
	)

	return <DemoEmbedContext.Provider value={value}>{children}</DemoEmbedContext.Provider>
}
