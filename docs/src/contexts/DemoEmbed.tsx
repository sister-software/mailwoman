/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared React context for the Mailwoman demo. Manages classifier / FST / WOF lookup loading so
 *   multiple PipelineExplorer instances on the same page (or the main demo page) share one set of
 *   loaded assets instead of re-fetching on mount.
 *
 *   The provider lazy-loads assets from R2 (public.sister.software) when `selectedVersion` changes.
 *   Classifier runs via onnxruntime-web (WASM SIMD with WebGPU fallback); the FST + resolver
 *   HTTP-VFS DBs are optional per-release.
 */

import type React from "react"
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"

import type {
	FstMatcherLike,
	FstProvenanceLike,
	MailwomanClassifierLike,
	MailwomanLookupLike,
} from "../shared/resources.tsx"
import { adminGazetteerUrl, assetUrl, loadFstGazetteer } from "../shared/resources.tsx"

import type { Calibrator, ReleasesManifest } from "../shared/demo-helpers.ts"
import { createCalibrator, DEFAULT_LOCALE } from "../shared/demo-helpers.ts"
import { pruneDbRangeCache, registerRangeCacheServiceWorker } from "../shared/register-range-sw.ts"

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
	fstMatcher: FstMatcherLike | null
	/** Provenance metadata for the FST binary. */
	fstProvenance: FstProvenanceLike | null
	/** The instantiated, cached WOF HTTP-VFS lookup. Loaded eagerly by the provider. */
	lookup: MailwomanLookupLike | null
	/**
	 * Maps a raw span confidence → its calibrated probability of correctness, built from the
	 * version's `calibration.json` (isotonic table). `null` while loading or for a release that ships
	 * no calibration table. The demo applies it so a displayed "97%" means ~97% correct — the
	 * capability a search index can't offer (`docs/articles/evals/*-calibration-*.md`).
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
	setForceWasm: (v: boolean) => void
	/** Whether WASM is forced. */
	forceWasm: boolean
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
	sqljsBaseUrl: string
	children: React.ReactNode
}

export const DemoEmbedProvider: React.FC<DemoEmbedProviderProps> = ({ sqljsBaseUrl, children }) => {
	const [manifest, setManifest] = useState<ReleasesManifest | null>(null)
	const [selectedVersion, setSelectedVersion] = useState<string | null>(null)
	const [loadingProgress, setLoadingProgress] = useState<string>("Loading releases…")
	const [loadingStepIndex, setLoadingStepIndex] = useState(-1)
	const [loadingStepLabels, setLoadingStepLabels] = useState<string[]>([])
	const [classifier, setClassifier] = useState<MailwomanClassifierLike | null>(null)
	const [fstMatcher, setFstMatcher] = useState<FstMatcherLike | null>(null)
	const [fstProvenance, setFstProvenance] = useState<FstProvenanceLike | null>(null)
	const [forceWasm, setForceWasm] = useState(false)
	const [activeBackend, setActiveBackend] = useState<string>("")
	const [lookup, setLookup] = useState<MailwomanLookupLike | null>(null)
	const [calibrator, setCalibrator] = useState<Calibrator | null>(null)
	const [errorMessage, setErrorMessage] = useState<string | null>(null)

	// Mount: register the range-chunk service worker (persists validated DB range chunks across
	// visits; see static/range-cache-sw.js). The provider only receives sqljsBaseUrl
	// (`${baseUrl}mailwoman/sqljs`), so the site base is recovered by stripping the staged suffix.
	useEffect(() => {
		registerRangeCacheServiceWorker(sqljsBaseUrl.replace(/mailwoman\/sqljs\/?$/, ""))
	}, [sqljsBaseUrl])

	// Drop cached range chunks from other (immutable, never-expiring) versions.
	useEffect(() => {
		if (selectedVersion) pruneDbRangeCache(selectedVersion)
	}, [selectedVersion])

	// Mount: fetch the releases manifest.
	useEffect(() => {
		let cancelled = false
		void (async () => {
			try {
				const res = await fetch(assetUrl(DEFAULT_LOCALE, "", "releases.json").replace(/\/\/releases/, "/releases"))
				const data: ReleasesManifest | null = res.ok ? await res.json() : null
				if (cancelled) return
				if (data) {
					setManifest(data)
					setSelectedVersion(data.defaultVersion)
				}
			} catch (error) {
				if (cancelled) return
				console.error("Failed to load releases manifest", error)
				setErrorMessage(error instanceof Error ? error.message : String(error))
			}
		})()
		return () => {
			cancelled = true
		}
	}, [])

	// Load the model + FST + WOF DB when the selected version changes.
	useEffect(() => {
		if (!selectedVersion) return
		let cancelled = false
		const release = manifest?.releases.find((r) => r.version === selectedVersion)

		void (async () => {
			try {
				setClassifier(null)
				setFstMatcher(null)
				setFstProvenance(null)
				setLookup(null)
				setCalibrator(null)
				setLoadingStepIndex(-1)
				setLoadingStepLabels([])
				setLoadingProgress(`Loading ${selectedVersion} model (~${release?.modelSize ?? "?"})…`)

				// Build staged step labels based on what this release includes.
				const steps: string[] = ["Loading classifier"]
				if (release?.hasFst) steps.push("Loading FST gazetteer")
				if (release?.hasWofDb) steps.push("Loading WOF database")
				setLoadingStepLabels(steps)

				// Dynamic import @mailwoman/neural-web — the webpack alias resolves this to the
				// browser-safe entry. TypeScript types are narrower than the runtime API so we cast
				// through unknown (same pattern as the demo page).
				const neuralWeb = await import("@mailwoman/neural-web")
				const { classifier: cls, diagnostics } = (await neuralWeb.loadNeuralClassifierFromUrls({
					modelUrl: assetUrl(DEFAULT_LOCALE, selectedVersion, "model.onnx"),
					tokenizerUrl: assetUrl(DEFAULT_LOCALE, selectedVersion, "tokenizer.model"),
					modelCardUrl: assetUrl(DEFAULT_LOCALE, selectedVersion, "model-card.json"),
					// Gazetteer-anchor lexicon (#464): REQUIRED by gazetteer-trained bundles (v4.2.0+). The
					// loader tolerates a 404 for older bundles (logging loudly when the model needed it).
					gazetteerLexiconUrl: assetUrl(DEFAULT_LOCALE, selectedVersion, "anchor-lexicon-v1.json"),
					runner: { useWebGpu: !forceWasm },
					...(release?.hasAnchor
						? {
								postcodeBinaryUrls: [
									assetUrl(DEFAULT_LOCALE, selectedVersion, "postcode-us.bin"),
									assetUrl(DEFAULT_LOCALE, selectedVersion, "postcode-de.bin"),
									assetUrl(DEFAULT_LOCALE, selectedVersion, "postcode-fr.bin"),
								],
							}
						: {}),
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
				})) as unknown as any as {
					classifier: MailwomanClassifierLike
					diagnostics?: { backend: string; modelBytes: number } | null
				}
				setActiveBackend(
					diagnostics
						? `${diagnostics.backend} (${(diagnostics.modelBytes / 1024 / 1024).toFixed(0)} MB int8)`
						: "unknown"
				)

				// Step 0 complete: classifier loaded.
				setLoadingStepIndex(0)

				if (cancelled) return

				// Isotonic confidence calibration (#59): turns the version's `calibration.json` table
				// into a (raw)=>calibrated map. Tolerate a 404 — pre-v4.0.0 bundles ship no table, in
				// which case the demo shows raw softmax scores (and says so). The table is the model's
				// OWN held-out reliability, so it must match the loaded version.
				try {
					const calRes = await fetch(assetUrl(DEFAULT_LOCALE, selectedVersion, "calibration.json"))
					if (calRes.ok) {
						const calTable = await calRes.json()
						if (!cancelled) setCalibrator(() => createCalibrator(calTable))
					}
				} catch {
					// No calibration table for this version — raw scores it is.
				}

				if (release?.hasFst) {
					try {
						const fstResult = await loadFstGazetteer(DEFAULT_LOCALE, selectedVersion)
						setFstMatcher(fstResult.matcher)
						if (fstResult.provenance) setFstProvenance(fstResult.provenance)
					} catch {
						// FST not available for this version
					}
				}

				// Step 1 complete: FST loaded (or skipped).
				setLoadingStepIndex(1)

				if (release?.hasWofDb) {
					try {
						const { loadHttpvfsDb, WofCandidateTableLookup: WOFCandidateTableLookup } =
							await import("../shared/httpvfs-resolver")
						const worker = await loadHttpvfsDb(adminGazetteerUrl(), sqljsBaseUrl)
						if (cancelled) return
						const wofLookup = new WofCandidateTableLookup(worker)
						// Fire-and-forget: pull the schema/FTS/dual-role pages through the VFS now so the
						// first interactive query starts warm. The worker serializes execs, so a user query
						// issued mid-warm-up simply queues behind pages it was going to need anyway.
						void wofLookup.warmUp().catch(() => {})
						setLookup(wofLookup)
					} catch {
						// WOF DB not available for this version
					}
				}

				// Step 2 complete: all assets loaded.
				setLoadingStepIndex(2)

				setClassifier(cls)
				setLoadingProgress("")
			} catch (error) {
				if (cancelled) return
				console.error("Error loading resources", error)
				setErrorMessage(error instanceof Error ? error.message : String(error))
				setLoadingProgress("")
			}
		})()

		return () => {
			cancelled = true
		}
	}, [selectedVersion, manifest, forceWasm, sqljsBaseUrl])

	const selectVersion = useCallback((version: string) => {
		setSelectedVersion(version)
		setErrorMessage(null)
	}, [])

	const ready = classifier !== null

	const value = useMemo<DemoEmbedState>(
		() => ({
			manifest,
			selectedVersion,
			classifier,
			fstMatcher,
			fstProvenance,
			lookup,
			calibrator,
			loadingProgress,
			loadingStepIndex,
			loadingStepLabels,
			errorMessage,
			ready,
			activeBackend,
			selectVersion,
			setForceWasm,
			forceWasm,
		}),
		[
			manifest,
			selectedVersion,
			classifier,
			fstMatcher,
			fstProvenance,
			lookup,
			calibrator,
			loadingProgress,
			loadingStepIndex,
			loadingStepLabels,
			errorMessage,
			ready,
			activeBackend,
			selectVersion,
			forceWasm,
		]
	)

	return <DemoEmbedContext.Provider value={value}>{children}</DemoEmbedContext.Provider>
}
