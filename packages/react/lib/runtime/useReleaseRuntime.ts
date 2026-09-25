/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

/**
 * Describes the minimal fields a release-manifest entry needs, which hosts extend with their own.
 */
export interface ReleaseBase {
	/**
	 * Identifies the entry when a version is selected.
	 */
	version: string

	/**
	 * Sets the version picker's display label, which falls back to `version`.
	 */
	label?: string
}

/**
 * The releases manifest the host fetches — the default version plus the selectable release entries.
 */
export interface ReleaseManifest<TRelease extends ReleaseBase = ReleaseBase> {
	/**
	 * Names the version selected when the manifest first loads.
	 */
	defaultVersion: string

	releases: TRelease[]
}

/**
 * Provides the abort signal and progress setters passed to a host's `loadAssets`.
 *
 * The setters become no-ops once the load is aborted or superseded, and the hook
 * itself sets the final ready or error state.
 */
export interface AssetsLoadContext {
	/**
	 * Aborts when a version or backend switch supersedes this load, or when the component unmounts.
	 */
	signal: AbortSignal

	/**
	 * Says whether this load should use the CPU WASM backend instead of WebGPU.
	 */
	forceWASM: boolean

	/**
	 * Sets the human-readable progress line, such as `Loading v7 model (~28 MB)…`.
	 */
	setProgress: (progress: string) => void

	/**
	 * Sets the labels of the staged loader's steps.
	 */
	setStepLabels: (labels: string[]) => void

	/**
	 * Sets the zero-based index of the current loader step.
	 */
	setStepIndex: (index: number) => void

	/**
	 * Reports the backend the neural runtime resolved to, such as `webgpu (27 MB int8)`.
	 */
	setBackend: (backend: string) => void

	/**
	 * Reports the fraction, in [0, 1], of the current download received so far, or `null`
	 * when nothing is downloading or the response declares no length.
	 *
	 * The step index cannot show this because the model is fetched before the first step begins.
	 */
	setByteFraction: (fraction: number | null) => void
}

/**
 * Supplies the host's manifest loader, asset loader and optional asset disposer
 * to {@link useReleaseRuntime}.
 */
export interface ReleaseRuntimeConfig<TAssets, TRelease extends ReleaseBase = ReleaseBase> {
	/**
	 * Fetches the releases manifest once on mount, returning `null` when none is
	 * available so nothing is selectable.
	 * A rejection is reported through `errorMessage`.
	 */
	loadManifest: (signal: AbortSignal) => Promise<ReleaseManifest<TRelease> | null>

	/**
	 * Loads the asset bundle for one release, reporting progress through `ctx`;
	 * it runs on every version or `forceWASM` change.
	 *
	 * A rejection is reported through `errorMessage`, and the hook discards
	 * and disposes a result that resolves after `ctx.signal` aborts.
	 */
	loadAssets: (release: TRelease, ctx: AssetsLoadContext) => Promise<TAssets>

	/**
	 * Releases resources the garbage collector does not own, such as an ONNX
	 * session's WASM heap or a GPU buffer.
	 *
	 * The hook calls it for a replaced bundle, for a bundle that resolved after its load
	 * was aborted, and on unmount; without it, every reload leaves a model resident.
	 */
	disposeAssets?: (assets: TAssets) => void | Promise<void>

	/**
	 * Sets the progress line shown before the manifest arrives, defaulting to `Loading releases…`.
	 */
	initialProgress?: string
}

/**
 * Describes the release-loading state {@link useReleaseRuntime} returns,
 * which a host pairs with its map surface to build a `GeocoderRuntime`.
 */
export interface ReleaseLoaderState<TAssets, TRelease extends ReleaseBase = ReleaseBase> {
	/**
	 * Holds the releases manifest, which is `null` until it loads or when none is available.
	 */
	manifest: ReleaseManifest<TRelease> | null

	/**
	 * Names the selected version, which is `null` before the manifest loads.
	 */
	selectedVersion: string | null

	/**
	 * Holds the manifest entry matching `selectedVersion`, or `null` when none matches.
	 */
	selectedRelease: TRelease | null

	/**
	 * Holds the asset bundle for the selected version, which is `null` while it loads.
	 */
	assets: TAssets | null

	ready: boolean

	/**
	 * Describes load progress for display, and is empty once loading finishes or fails.
	 */
	loadingProgress: string

	/**
	 * Gives the zero-based loader step index, which is `-1` before the first step.
	 */
	loadingStepIndex: number

	loadingStepLabels: string[]

	/**
	 * Gives the fraction, in [0, 1], of the current download received so far, or `null`
	 * when nothing is downloading or the length is unknown.
	 */
	loadingByteFraction: number | null

	/**
	 * Holds a manifest or asset load error, separate from any parse error a consumer tracks.
	 */
	errorMessage: string | null

	/**
	 * Names the backend the neural runtime resolved to, such as `webgpu (27 MB int8)`,
	 * or is `""` before it is known.
	 */
	activeBackend: string

	/**
	 * Says whether the CPU WASM backend is forced instead of WebGPU.
	 */
	forceWASM: boolean

	/**
	 * Switches to another version, clearing any error and reloading the asset bundle.
	 */
	selectVersion: (version: string) => void

	/**
	 * Forces or releases the CPU WASM backend, which reloads the asset bundle.
	 */
	setForceWASM: (forceWASM: boolean) => void
}

/**
 * Loads the release manifest on mount, then loads the selected release's assets
 * whenever the version or `forceWASM` changes.
 *
 * Each reload aborts the previous load and disposes the old assets, and `ready`
 * becomes true only once the new assets have fully loaded.
 */
export function useReleaseRuntime<TAssets, TRelease extends ReleaseBase = ReleaseBase>(
	config: ReleaseRuntimeConfig<TAssets, TRelease>
): ReleaseLoaderState<TAssets, TRelease> {
	const { initialProgress = "Loading releases…" } = config

	const [manifest, setManifest] = useState<ReleaseManifest<TRelease> | null>(null)
	const [selectedVersion, setSelectedVersion] = useState<string | null>(null)
	const [assets, setAssets] = useState<TAssets | null>(null)
	const [loadingProgress, setLoadingProgress] = useState<string>(initialProgress)
	const [loadingStepIndex, setLoadingStepIndex] = useState(-1)
	const [loadingStepLabels, setLoadingStepLabels] = useState<string[]>([])
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const [activeBackend, setActiveBackend] = useState<string>("")
	const [loadingByteFraction, setLoadingByteFraction] = useState<number | null>(null)
	const [forceWASM, setForceWASMState] = useState(false)

	const loadManifestRef = useRef(config.loadManifest)
	const loadAssetsRef = useRef(config.loadAssets)
	const disposeAssetsRef = useRef(config.disposeAssets)

	const liveAssetsRef = useRef<TAssets | null>(null)

	const manifestRef = useRef<ReleaseManifest<TRelease> | null>(null)

	useEffect(() => {
		loadManifestRef.current = config.loadManifest
		loadAssetsRef.current = config.loadAssets
		disposeAssetsRef.current = config.disposeAssets
		manifestRef.current = manifest
	}, [config.disposeAssets, config.loadAssets, config.loadManifest, manifest])

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
				const outgoing = liveAssetsRef.current

				liveAssetsRef.current = null

				if (outgoing) {
					await disposeAssetsRef.current?.(outgoing)
				}

				setAssets(null)
				setLoadingStepIndex(-1)
				setLoadingStepLabels([])
				setActiveBackend("")
				setLoadingByteFraction(null)

				const ctx: AssetsLoadContext = {
					signal,
					forceWASM,
					setProgress: (progress) => guard(() => setLoadingProgress(progress)),
					setStepLabels: (labels) => guard(() => setLoadingStepLabels(labels)),
					setStepIndex: (index) => guard(() => setLoadingStepIndex(index)),
					setBackend: (backend) => guard(() => setActiveBackend(backend)),
					setByteFraction: (fraction) => guard(() => setLoadingByteFraction(fraction)),
				}

				const loaded = await loadAssetsRef.current(release, ctx)

				if (signal.aborted) {
					await disposeAssetsRef.current?.(loaded)

					return
				}

				liveAssetsRef.current = loaded
				setAssets(loaded)
				setLoadingProgress("")
				setLoadingByteFraction(null)
			} catch (error) {
				if (signal.aborted) return
				setErrorMessage(error instanceof Error ? error.message : String(error))
				setLoadingProgress("")
			}
		})()

		return () => controller.abort()
	}, [selectedVersion, forceWASM])

	useEffect(() => {
		return () => {
			const live = liveAssetsRef.current

			liveAssetsRef.current = null

			if (live) {
				void disposeAssetsRef.current?.(live)
			}
		}
	}, [])

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
		loadingByteFraction,
		errorMessage,
		activeBackend,
		forceWASM,
		selectVersion,
		setForceWASM,
	}
}
