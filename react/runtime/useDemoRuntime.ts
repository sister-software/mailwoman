/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `useDemoRuntime` — the headless load-orchestration hook shared by every mailwoman demo surface (the
 *   inline doc-embeds via `DemoEmbed`, and the geocoder map page). It owns the version-selection state
 *   machine, the per-version load SEQUENCING, cancellation, and the ready / loading / error state — but
 *   NOTHING model- or map-specific. The actual asset fetchers (the ONNX classifier factory, the httpvfs
 *   WOF opener, the FST fetch, the releases.json fetch) are INJECTED by the host as async functions, so
 *   this module imports only React: no `onnxruntime-web`, no `sql.js-httpvfs`, no `maplibre-gl`, no
 *   `fetch`-specific plumbing. That keeps it node-import-safe and root-exportable from
 *   `@mailwoman/react` — the exact seam `PipelineRuntime` established, generalized to the loader itself.
 *
 *   The hook is generic over `TAssets` (the opaque bundle the host's `loadAssets` returns — classifier,
 *   FST, WOF lookup, calibrator, …) and `TRelease` (the host's release-manifest entry). The package
 *   never inspects either; it just holds, reveals, and re-loads them across version/backend switches.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

/** The minimal contract a release-manifest entry must satisfy. Hosts extend this with their own fields. */
export interface DemoReleaseBase {
	/** The version tag this entry describes (matched against `selectedVersion`). */
	version: string
	/** Optional display label a version picker shows; falls back to `version`. */
	label?: string
}

/** The releases manifest the host fetches — the default version plus the selectable release entries. */
export interface DemoManifest<TRelease extends DemoReleaseBase = DemoReleaseBase> {
	/** The version selected on first load (before the user picks another). */
	defaultVersion: string
	/** Every selectable release. */
	releases: TRelease[]
}

/**
 * The progress channel handed to the host's `loadAssets`. The host reports load progress + the resolved backend + the
 * staged step labels/index THROUGH these setters (all no-op once the load is superseded/aborted), while the hook owns
 * the terminal state (revealing the assets + clearing progress on success, surfacing the error on failure).
 */
export interface DemoAssetsLoadContext {
	/** Aborts when this load is superseded (version/backend switch) or the provider unmounts. */
	signal: AbortSignal
	/** Whether the host should force the CPU/WASM backend (opt out of WebGPU) for this load. */
	forceWASM: boolean
	/** Set the human-readable progress line (e.g. `Loading v7 model (~28 MB)…`). */
	setProgress: (progress: string) => void
	/** Set the staged-loader step labels (e.g. `["Loading classifier", "Loading FST gazetteer"]`). */
	setStepLabels: (labels: string[]) => void
	/** Advance the staged-loader step index (0-based). */
	setStepIndex: (index: number) => void
	/** Report the backend the neural runtime resolved to (e.g. `webgpu (27 MB int8)`). */
	setBackend: (backend: string) => void
}

/** The injected loaders the hook orchestrates. Nothing here is model- or map-aware — the host owns all that. */
export interface DemoRuntimeConfig<TAssets, TRelease extends DemoReleaseBase = DemoReleaseBase> {
	/**
	 * Fetch + normalize the releases manifest. Returns `null` when no manifest is available (the demo then shows nothing
	 * selectable). Rejecting surfaces `errorMessage`. Runs once on mount.
	 */
	loadManifest: (signal: AbortSignal) => Promise<DemoManifest<TRelease> | null>
	/**
	 * Load the full asset bundle for one release — the classifier, FST, WOF lookup, calibrator, whatever the host needs.
	 * Runs on every version or `forceWASM` change. Report progress via `ctx`; return the bundle. Rejecting surfaces
	 * `errorMessage`. Bail early when `ctx.signal.aborted` — the hook discards a superseded result regardless.
	 */
	loadAssets: (release: TRelease, ctx: DemoAssetsLoadContext) => Promise<TAssets>
	/** The progress line shown before the manifest arrives. @default "Loading releases…" */
	initialProgress?: string
}

/** The state `useDemoRuntime` produces — the load orchestration a demo surface renders + re-projects. */
export interface UseDemoRuntime<TAssets, TRelease extends DemoReleaseBase = DemoReleaseBase> {
	/** The releases manifest, once fetched. */
	manifest: DemoManifest<TRelease> | null
	/** The currently-selected version, or `null` before the manifest resolves. */
	selectedVersion: string | null
	/** The release entry matching `selectedVersion` (convenience over `manifest.releases.find`). */
	selectedRelease: TRelease | null
	/** The loaded asset bundle for the selected version, or `null` while (re)loading. */
	assets: TAssets | null
	/** Whether the asset bundle is loaded and ready to use. */
	ready: boolean
	/** Human-readable load progress (`""` when idle/ready). */
	loadingProgress: string
	/** Staged-loader step index (0-based; `-1` before the first step). */
	loadingStepIndex: number
	/** Staged-loader step labels. */
	loadingStepLabels: string[]
	/** A load error (manifest or asset), distinct from any per-parse error a consumer tracks separately. */
	errorMessage: string | null
	/** The backend the neural runtime resolved to (e.g. `webgpu (27 MB int8)`), or `""` before it's known. */
	activeBackend: string
	/** Whether the CPU/WASM backend is currently forced. */
	forceWASM: boolean
	/** Switch to a different version (clears any error, then reloads the asset bundle). */
	selectVersion: (version: string) => void
	/** Force (or unforce) the CPU/WASM backend — reloads the asset bundle. */
	setForceWASM: (forceWASM: boolean) => void
}

/**
 * Drive the shared version → asset-bundle load state machine over a host-injected loader.
 *
 * Sequence: on mount `loadManifest` runs and its `defaultVersion` becomes the selection; each version (or `forceWASM`)
 * change reloads the bundle via `loadAssets`, the previous load aborted first. The assets are revealed ATOMICALLY when
 * `loadAssets` resolves (so `ready` flips exactly once per load), and consumers gate on `ready`.
 */
export function useDemoRuntime<TAssets, TRelease extends DemoReleaseBase = DemoReleaseBase>(
	config: DemoRuntimeConfig<TAssets, TRelease>
): UseDemoRuntime<TAssets, TRelease> {
	const { initialProgress = "Loading releases…" } = config

	const [manifest, setManifest] = useState<DemoManifest<TRelease> | null>(null)
	const [selectedVersion, setSelectedVersion] = useState<string | null>(null)
	const [assets, setAssets] = useState<TAssets | null>(null)
	const [loadingProgress, setLoadingProgress] = useState<string>(initialProgress)
	const [loadingStepIndex, setLoadingStepIndex] = useState(-1)
	const [loadingStepLabels, setLoadingStepLabels] = useState<string[]>([])
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const [activeBackend, setActiveBackend] = useState<string>("")
	const [forceWASM, setForceWASMState] = useState(false)

	// Latest-ref the injected loaders: a host that re-creates them each render (an inline arrow) must NOT retrigger the
	// load effects, which key ONLY on version/backend. The effects read `.current` at run time.
	const loadManifestRef = useRef(config.loadManifest)
	loadManifestRef.current = config.loadManifest
	const loadAssetsRef = useRef(config.loadAssets)
	loadAssetsRef.current = config.loadAssets

	// Latest manifest for the version-load effect, so it can resolve the release WITHOUT depending on `manifest`
	// identity — which would double-fire the load the instant the manifest first arrives (the selection transition
	// null → defaultVersion already fires it once).
	const manifestRef = useRef<DemoManifest<TRelease> | null>(null)
	manifestRef.current = manifest

	// Mount: fetch the manifest, then select the default version.
	useEffect(() => {
		const controller = new AbortController()

		void (async () => {
			try {
				const data = await loadManifestRef.current(controller.signal)

				if (controller.signal.aborted) return

				if (data) {
					setManifest(data)
					setSelectedVersion(data.defaultVersion)
				}
			} catch (error) {
				if (controller.signal.aborted) return
				setErrorMessage(error instanceof Error ? error.message : String(error))
			}
		})()

		return () => controller.abort()
	}, [])

	// Load the per-version asset bundle when the version (or the backend force) changes.
	useEffect(() => {
		if (!selectedVersion) return

		const release = manifestRef.current?.releases.find((r) => r.version === selectedVersion) ?? null

		if (!release) return

		const controller = new AbortController()
		const { signal } = controller
		const guard = (fn: () => void) => {
			if (!signal.aborted) {
				fn()
			}
		}

		void (async () => {
			try {
				setAssets(null)
				setLoadingStepIndex(-1)
				setLoadingStepLabels([])
				setActiveBackend("")

				const ctx: DemoAssetsLoadContext = {
					signal,
					forceWASM,
					setProgress: (progress) => guard(() => setLoadingProgress(progress)),
					setStepLabels: (labels) => guard(() => setLoadingStepLabels(labels)),
					setStepIndex: (index) => guard(() => setLoadingStepIndex(index)),
					setBackend: (backend) => guard(() => setActiveBackend(backend)),
				}

				const loaded = await loadAssetsRef.current(release, ctx)

				if (signal.aborted) return
				setAssets(loaded)
				setLoadingProgress("")
			} catch (error) {
				if (signal.aborted) return
				setErrorMessage(error instanceof Error ? error.message : String(error))
				setLoadingProgress("")
			}
		})()

		return () => controller.abort()
	}, [selectedVersion, forceWASM])

	const selectVersion = useCallback((version: string) => {
		setSelectedVersion(version)
		setErrorMessage(null)
	}, [])

	const setForceWASM = useCallback((next: boolean) => setForceWASMState(next), [])

	const selectedRelease = useMemo(
		() => manifest?.releases.find((r) => r.version === selectedVersion) ?? null,
		[manifest, selectedVersion]
	)

	return {
		manifest,
		selectedVersion,
		selectedRelease,
		assets,
		ready: assets !== null,
		loadingProgress,
		loadingStepIndex,
		loadingStepLabels,
		errorMessage,
		activeBackend,
		forceWASM,
		selectVersion,
		setForceWASM,
	}
}
