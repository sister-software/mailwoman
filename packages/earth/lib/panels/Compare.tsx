/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<Compare>` — the host-side compare panel, injected into the geocoder via `GeocoderPanels.compare`. The package owns
 *   only the compare TOGGLE + version selection (`useCompareState`); the SECOND parse stays host-side by design, so
 *   this component loads its own compare classifier and re-parses the current input whenever the primary result
 *   changes — then renders the `<VersionCompare>` diff.
 */

import type { ParseResult } from "@mailwoman/core/pipeline/client-result"
import { DEFAULT_LOCALE, runClassifyStage } from "mailwoman/browser-runtime/classify"
import { fetchWithRetry } from "mailwoman/browser-runtime/fetch"
import type { ReleaseInfo } from "mailwoman/browser-runtime/manifest"
import { neuralClassifierLoadURLs } from "mailwoman/browser-runtime/resources"
import type { MailwomanClassifierLike } from "mailwoman/browser-runtime/types"
import type React from "react"
import { useEffect, useState } from "react"

import { VersionCompare } from "./VersionCompare/VersionCompare.tsx"

export interface CompareProps {
	/**
	 * The primary (left) parse result from the package's compare context.
	 */
	primary: ParseResult | null
	/**
	 * Whether compare mode is on.
	 */
	compareMode: boolean
	/**
	 * The version selected to compare against, or `null`.
	 */
	compareVersion: string | null
	/**
	 * The primary version label.
	 */
	primaryVersion: string
	/**
	 * The selectable releases (for the compare release's `hasAnchor`).
	 */
	releases: ReleaseInfo[]
	/**
	 * Whether the CPU/WASM backend is forced.
	 */
	forceWASM: boolean
}

/**
 * Load a compare classifier + re-parse the current input, rendering the side-by-side `<VersionCompare>`.
 */
export const Compare: React.FC<CompareProps> = ({
	primary,
	compareMode,
	compareVersion,
	primaryVersion,
	releases,
	forceWASM,
}) => {
	const [classifier, setClassifier] = useState<MailwomanClassifierLike | null>(null)
	const [backend, setBackend] = useState<string>("")
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [compareResult, setCompareResult] = useState<ParseResult | null>(null)

	// Load the compare classifier when compare mode + a compare version are active.
	// Resetting the load state is the lifecycle boundary for a different requested classifier.

	useEffect(() => {
		if (!compareMode || !compareVersion) {
			// oxlint-disable-next-line react/set-state-in-effect -- A disabled comparison must release its version-scoped classifier immediately.
			setClassifier(null)
			setCompareResult(null)
			setError(null)
			setBackend("")

			return
		}

		let cancelled = false
		const release = releases.find((r) => r.version === compareVersion)

		void (async () => {
			try {
				setClassifier(null)
				setCompareResult(null)
				setError(null)
				setLoading(true)
				setBackend("")

				const { loadNeuralClassifierFromURLs } = await import("@mailwoman/neural/web-loader")

				const { classifier: cls, diagnostics } = await loadNeuralClassifierFromURLs({
					...neuralClassifierLoadURLs(DEFAULT_LOCALE, compareVersion, { hasAnchor: release?.hasAnchor, forceWASM }),
					fetchImpl: fetchWithRetry,
				})

				if (cancelled) return

				setBackend(
					diagnostics
						? `${diagnostics.backend} (${(diagnostics.modelBytes / 1024 / 1024).toFixed(0)} MB int8)`
						: "unknown"
				)

				setClassifier(cls as MailwomanClassifierLike)
			} catch (caught) {
				if (cancelled) return
				setError(caught instanceof Error ? caught.message : String(caught))
			} finally {
				if (!cancelled) {
					setLoading(false)
				}
			}
		})()

		return () => {
			cancelled = true
		}
	}, [compareMode, compareVersion, releases, forceWASM])

	// Re-parse the current input through the compare classifier whenever the primary result changes.
	const primaryInput = primary?.input ?? null

	useEffect(() => {
		const cls = classifier

		if (!compareMode || !cls || !primaryInput) {
			// oxlint-disable-next-line react/set-state-in-effect -- The prior result belongs to a classifier or input that is no longer active.
			setCompareResult(null)

			return
		}

		let cancelled = false

		void (async () => {
			try {
				// The shared classify front-half — the compare arm loads only a classifier, so the FST /
				// street-morphology / pair-index deps stay unset and the stage parses as a bare load.
				const { tree, nodes, kindResult, timing } = await runClassifyStage(primaryInput, { classifier: cls })

				if (cancelled) return

				setCompareResult({
					input: primaryInput,
					tree,
					nodes,
					resolved: null,
					candidates: [],
					kindResult,
					fstActive: false,
					timing,
				})
			} catch (caught) {
				if (cancelled) return
				setError(caught instanceof Error ? caught.message : String(caught))
			}
		})()

		return () => {
			cancelled = true
		}
	}, [compareMode, primaryInput, classifier])

	if (!compareMode) return null

	return (
		<div>
			{loading ? <p className="mw-status">Loading {compareVersion} model…</p> : null}
			{backend && !loading ? (
				<span style={{ fontSize: "0.8rem", opacity: 0.7 }}>
					Compare backend: <code>{backend}</code>
				</span>
			) : null}
			{error ? <p className="mw-error">{error}</p> : null}
			{compareResult && primary ? (
				<VersionCompare
					primary={primary as ParseResult}
					compare={compareResult}
					primaryVersion={primaryVersion}
					compareVersion={compareVersion ?? "?"}
				/>
			) : null}
		</div>
	)
}
