/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

/**
 * The minimal fields of a release-manifest entry.
 * Hosts extend it with their own fields.
 */
export interface ReleaseBase {
	/**
	 * The version string that identifies the entry.
	 */
	version: string

	/**
	 * The version picker's display label.
	 * The picker falls back to `version` when it is absent.
	 */
	label?: string
}

/**
 * The releases manifest that the host fetches.
 */
export interface ReleaseManifest<TRelease extends ReleaseBase = ReleaseBase> {
	/**
	 * The version that the hook selects when the manifest first loads.
	 */
	defaultVersion: string

	releases: TRelease[]
}

/**
 * The abort signal and progress setters that the hook passes to a host's `loadAssets`.
 *
 * The setters do nothing once the load is aborted or superseded.
 * The hook sets the final ready or error state itself.
 */
export interface AssetsLoadContext {
	/**
	 * The signal aborts when a version or backend switch supersedes this load or when the component unmounts.
	 */
	signal: AbortSignal

	/**
	 * Whether this load should use the CPU WASM backend instead of WebGPU.
	 */
	forceWASM: boolean

	/**
	 * Sets the progress line, such as `Loading v7 model (~28 MB)…`.
	 */
	setProgress: (progress: string) => void

	/**
	 * Sets the labels of the loader's steps.
	 */
	setStepLabels: (labels: string[]) => void

	/**
	 * Sets the zero-based index of the current loader step.
	 */
	setStepIndex: (index: number) => void

	/**
	 * Reports the backend that the neural runtime resolved to, such as `webgpu (27 MB int8)`.
	 */
	setBackend: (backend: string) => void

	/**
	 * Reports the fraction of the current download received so far, in [0, 1].
	 *
	 * The value is `null` when nothing is downloading or the response declares no length.
	 *
	 * The step index cannot show this progress because the model is fetched before the first step begins.
	 */
	setByteFraction: (fraction: number | null) => void
}

/**
 * The host's manifest loader, asset loader and optional asset disposer for {@link useReleaseRuntime}.
 */
export interface ReleaseRuntimeConfig<TAssets, TRelease extends ReleaseBase = ReleaseBase> {
	/**
	 * Fetches the releases manifest once on mount.
	 *
	 * It returns `null` when no manifest is available.
	 * The hook reports a rejection through `errorMessage`.
	 */
	loadManifest: (signal: AbortSignal) => Promise<ReleaseManifest<TRelease> | null>

	/**
	 * Loads the asset bundle for one release and reports progress through `ctx`.
	 * The hook calls it on every version or `forceWASM` change.
	 *
	 * The hook reports a rejection through `errorMessage`.
	 * It disposes a result that resolves after `ctx.signal` aborts.
	 */
	loadAssets: (release: TRelease, ctx: AssetsLoadContext) => Promise<TAssets>

	/**
	 * Releases resources that the garbage collector does not own, such as an ONNX
	 * session's WASM heap or a GPU buffer.
	 *
	 * The hook calls it for a replaced bundle, for a bundle that resolved
	 * after its load was aborted, and on unmount.
	 * Without it, every reload leaves a model resident.
	 */
	disposeAssets?: (assets: TAssets) => void | Promise<void>

	/**
	 * The progress line shown before the manifest arrives.
	 * It defaults to `Loading releases…`.
	 */
	initialProgress?: string
}

/**
 * The release-loading state that {@link useReleaseRuntime} returns.
 *
 * A host pairs it with its map surface to build a `GeocoderRuntime`.
 */
export interface ReleaseLoaderState<TAssets, TRelease extends ReleaseBase = ReleaseBase> {
	/**
	 * The releases manifest.
	 * It is `null` until it loads or when none is available.
	 */
	manifest: ReleaseManifest<TRelease> | null

	/**
	 * The selected version.
	 * It is `null` before the manifest loads.
	 */
	selectedVersion: string | null

	/**
	 * The manifest entry that matches `selectedVersion`, or `null` when none matches.
	 */
	selectedRelease: TRelease | null

	/**
	 * The asset bundle for the selected version.
	 * It is `null` while the bundle loads.
	 */
	assets: TAssets | null

	ready: boolean

	/**
	 * The load progress line.
	 * It is empty once loading finishes or fails.
	 */
	loadingProgress: string

	/**
	 * The zero-based loader step index.
	 * It is `-1` before the first step.
	 */
	loadingStepIndex: number

	loadingStepLabels: string[]

	/**
	 * The fraction of the current download received so far, in [0, 1].
	 *
	 * It is `null` when nothing is downloading or the length is unknown.
	 */
	loadingByteFraction: number | null

	/**
	 * A manifest or asset load error.
	 * It is separate from any parse error that a consumer tracks.
	 */
	errorMessage: string | null

	/**
	 * The backend that the neural runtime resolved to, such as `webgpu (27 MB int8)`.
	 * It is `""` before the backend is known.
	 */
	activeBackend: string

	/**
	 * Whether the CPU WASM backend is forced instead of WebGPU.
	 */
	forceWASM: boolean

	/**
	 * Switches to another version.
	 * It clears any error and reloads the asset bundle.
	 */
	selectVersion: (version: string) => void

	/**
	 * Forces or releases the CPU WASM backend.
	 * Either change reloads the asset bundle.
	 */
	setForceWASM: (forceWASM: boolean) => void
}

/**
 * Loads the release manifest on mount.
 *
 * It then loads the selected release's assets whenever the version or `forceWASM` changes.
 *
 * Each reload aborts the previous load and disposes the old assets.
 * `ready` becomes true only after the new assets have fully loaded.
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
