/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared React context for the explainers that run the browser runtime inline. Manages classifier / FST / WOF
 *   lookup loading so multiple PipelineExplorer instances on the same page share one set of loaded assets instead
 *   of re-fetching on mount.
 *
 *   The load ORCHESTRATION — the version-selection state machine, the per-version load sequencing, the
 *   ready / loading / error state — is owned by `@mailwoman/react`'s `useReleaseRuntime`. This provider
 *   supplies the DOCS-SIDE fetchers as injected async functions: the releases manifest, the ONNX
 *   classifier (onnxruntime-web; WASM SIMD with WebGPU fallback), the FST gazetteer, the WOF HTTP-VFS
 *   lookup, and the calibration table. Keeping the fetchers here (not in the package) is what holds
 *   onnxruntime-web + sql.js-httpvfs out of `@mailwoman/react`'s import graph. The provider then
 *   re-projects the loaded bundle onto the flat `RuntimeEmbedState` its consumers read.
 */

import type { Calibrator } from "@mailwoman/core/decoder/calibration"
import type { AssetsLoadContext, ReleaseManifest } from "@mailwoman/react"
import { useReleaseRuntime } from "@mailwoman/react"
import type { MailwomanLookupLike } from "@mailwoman/resolver-wof-wasm/browser-cascade"
import type { SelectPairIndex } from "mailwoman/browser-runtime/classify"
import type { ReleaseAssets } from "mailwoman/browser-runtime/load-assets"
import { loadReleaseAssets } from "mailwoman/browser-runtime/load-assets"
import type { ReleaseInfo, ReleasesManifest } from "mailwoman/browser-runtime/manifest"
import { fetchReleasesManifest } from "mailwoman/browser-runtime/manifest"
import type { FSTMatcherLike, FSTProvenanceLike, MailwomanClassifierLike } from "mailwoman/browser-runtime/types"
import type React from "react"
import { createContext, useCallback, useContext, useMemo } from "react"

//#region Types

export interface RuntimeEmbedState {
	/**
	 * The releases manifest (fetched once on mount).
	 */
	manifest: ReleasesManifest | null
	/**
	 * Currently selected version string.
	 */
	selectedVersion: string | null
	/**
	 * The loaded neural classifier (onnxruntime-web).
	 */
	classifier: MailwomanClassifierLike | null
	/**
	 * The loaded FST gazetteer matcher.
	 */
	fstMatcher: FSTMatcherLike | null
	/**
	 * Provenance metadata for the FST binary.
	 */
	fstProvenance: FSTProvenanceLike | null
	/**
	 * The street-morphology matcher (#1315 street-context check) — `null` when the release ships no
	 * `fst-street-morphology.bin`. `PipelineExplorer` threads it into `runClassifyStage` beside `fstMatcher`.
	 */
	streetMorphologyMatcher: FSTMatcherLike | null
	/**
	 * The instantiated, cached WOF HTTP-VFS lookup. Loaded eagerly by the provider.
	 */
	lookup: MailwomanLookupLike | null
	/**
	 * Per-parse placetype-pair prior selector (#1278) — locale-hint over the input picks the GB/NZ dependent_locality
	 * index. `null` when this release staged no pair index. `PipelineExplorer` threads it into `runClassifyStage`.
	 */
	selectPairIndex: SelectPairIndex | null
	/**
	 * Maps a raw span confidence → its calibrated probability of correctness, built from the version's `calibration.json`
	 * (isotonic table). `null` while loading or for a release that ships no calibration table. The explainers apply it so
	 * a displayed "97%" means ~97% correct — the capability a search index can't offer
	 * (`docs/articles/evals/calibration/*-calibration-*.md`).
	 */
	calibrator: Calibrator | null
	/**
	 * Human-readable loading progress string.
	 */
	loadingProgress: string
	/**
	 * Current loading step index (0-based). Used by staged LoadingIndicator.
	 */
	loadingStepIndex: number
	/**
	 * Step labels for the staged loading indicator.
	 */
	loadingStepLabels: string[]
	/**
	 * Error message if loading failed.
	 */
	errorMessage: string | null
	/**
	 * Whether ALL selected-version assets (classifier + FST) are loaded and ready.
	 */
	ready: boolean
	/**
	 * Backend diagnostic string (e.g. "webgpu (27 MB int8)").
	 */
	activeBackend: string
	/**
	 * Switch to a different version. Triggers asset reload.
	 */
	selectVersion: (version: string) => void
	/**
	 * Force CPU WASM backend instead of WebGPU.
	 */
	setForceWASM: (v: boolean) => void
	/**
	 * Whether WASM is forced.
	 */
	forceWASM: boolean
}

const RuntimeEmbedContext = createContext<RuntimeEmbedState | null>(null)

//#endregion

//#region Hook

export function useRuntimeEmbed(): RuntimeEmbedState {
	const ctx = useContext(RuntimeEmbedContext)

	if (!ctx) {
		throw new Error("useRuntimeEmbed must be used within a <RuntimeEmbedProvider>")
	}

	return ctx
}

//#endregion

//#region Provider

export interface RuntimeEmbedProviderProps {
	/**
	 * Base URL for the sql.js-httpvfs worker + wasm (same-origin, e.g. `/mailwoman/sqljs`).
	 */
	sqljsBaseURL: string
	children: React.ReactNode
}

export const RuntimeEmbedProvider: React.FC<RuntimeEmbedProviderProps> = ({ sqljsBaseURL, children }) => {
	// Fetch + normalize the releases manifest. `useReleaseRuntime` runs this once on mount, then selects
	// its `defaultVersion`. Returns the full `ReleasesManifest` (a structural superset of the package's
	// `ReleaseManifest` — it also carries `locale`), so the value below can re-expose it as `ReleasesManifest`.
	const loadManifest = useCallback(async (): Promise<ReleaseManifest<ReleaseInfo> | null> => {
		try {
			return await fetchReleasesManifest()
		} catch (error) {
			console.error("Failed to load releases manifest", error)

			throw error
		}
	}, [])

	// The embed keeps the gazetteer: the explainers resolve through `wofLookup`. `useReleaseRuntime` owns the terminal
	// ready/error state; the try/catch keeps this path's diagnostic console log on a load failure.
	const loadAssets = useCallback(
		async (release: ReleaseInfo, ctx: AssetsLoadContext): Promise<ReleaseAssets> => {
			try {
				return await loadReleaseAssets(release, ctx, { gazetteer: { sqljsBaseURL } })
			} catch (error) {
				console.error("Error loading resources", error)

				throw error
			}
		},
		[sqljsBaseURL]
	)

	const rt = useReleaseRuntime<ReleaseAssets, ReleaseInfo>({ loadManifest, loadAssets })

	const value = useMemo<RuntimeEmbedState>(
		() => ({
			// The runtime object is the `ReleasesManifest` `loadManifest` returned (the package stores it
			// verbatim), so re-widening the type here is sound — it carries `locale` at run time.
			manifest: rt.manifest as ReleasesManifest | null,
			selectedVersion: rt.selectedVersion,
			classifier: rt.assets?.classifier ?? null,
			fstMatcher: rt.assets?.fstMatcher ?? null,
			fstProvenance: rt.assets?.fstProvenance ?? null,
			streetMorphologyMatcher: rt.assets?.streetMorphologyMatcher ?? null,
			lookup: rt.assets?.lookup ?? null,
			calibrator: rt.assets?.calibrator ?? null,
			selectPairIndex: rt.assets?.selectPairIndex ?? null,
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

	return <RuntimeEmbedContext.Provider value={value}>{children}</RuntimeEmbedContext.Provider>
}

//#endregion
