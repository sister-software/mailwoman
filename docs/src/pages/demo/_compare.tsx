/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<DemoCompare>` — the host-side compare panel for `/demo`, injected into `<GeocoderDemo>` via
 *   `DemoPanels.compare`. The package owns only the compare TOGGLE + version selection (`useCompareState`);
 *   the SECOND parse stays host-side by design, so this component loads its own compare classifier and
 *   re-parses the current input whenever the primary result changes — then renders the docs
 *   `<VersionCompare>` diff. It mirrors the compare branch of the live demo's `_app.tsx` onSubmit, kept
 *   here so the staging route exercises the compare seam without touching `_app.tsx`.
 */

import type { ParseResult } from "@mailwoman/react"
import type React from "react"
import { useEffect, useRef, useState } from "react"

import { VersionCompare } from "../../components/VersionCompare/VersionCompare.tsx"
import type { ReleaseInfo } from "../../shared/demo-helpers.ts"
import { DEFAULT_LOCALE, flattenTree } from "../../shared/demo-helpers.ts"
import type { DemoResult, MailwomanClassifierLike, ResultNode } from "../../shared/resources.tsx"
import { neuralClassifierLoadURLs } from "../../shared/resources.tsx"

export interface DemoCompareProps {
	/** The primary (left) parse result from the package's compare context. */
	primary: ParseResult | null
	/** Whether compare mode is on. */
	compareMode: boolean
	/** The version selected to compare against, or `null`. */
	compareVersion: string | null
	/** The primary version label. */
	primaryVersion: string
	/** The selectable releases (for the compare release's `hasAnchor`). */
	releases: ReleaseInfo[]
	/** Whether the CPU/WASM backend is forced. */
	forceWASM: boolean
}

/** Load a compare classifier + re-parse the current input, rendering the side-by-side `<VersionCompare>`. */
export const DemoCompare: React.FC<DemoCompareProps> = ({
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
	const [compareResult, setCompareResult] = useState<DemoResult | null>(null)
	// The classifier is a ref too so the parse effect can read the latest without depending on identity churn.
	const classifierRef = useRef<MailwomanClassifierLike | null>(null)
	classifierRef.current = classifier

	// Load the compare classifier when compare mode + a compare version are active.
	useEffect(() => {
		if (!compareMode || !compareVersion) {
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

				const neuralWeb = await import("@mailwoman/neural-web")
				const { classifier: cls, diagnostics } = await neuralWeb.loadNeuralClassifierFromURLs(
					neuralClassifierLoadURLs(DEFAULT_LOCALE, compareVersion, { hasAnchor: release?.hasAnchor, forceWASM })
				)

				if (cancelled) return
				setBackend(
					diagnostics
						? `${diagnostics.backend} (${(diagnostics.modelBytes / 1024 / 1024).toFixed(0)} MB int8)`
						: "unknown"
				)
				setClassifier(cls as unknown as MailwomanClassifierLike)
			} catch (err) {
				if (cancelled) return
				setError(err instanceof Error ? err.message : String(err))
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
		const cls = classifierRef.current

		if (!compareMode || !cls || !primaryInput) {
			setCompareResult(null)

			return
		}
		let cancelled = false

		void (async () => {
			try {
				const [{ computeQueryShape }, { classifyKindSync }, { runPipeline }, { groupPhrases }] = await Promise.all([
					import("@mailwoman/query-shape"),
					import("@mailwoman/kind-classifier"),
					import("@mailwoman/core/pipeline"),
					import("@mailwoman/phrase-grouper"),
				])
				const cStart = performance.now()
				const cQueryShape = computeQueryShape(primaryInput)
				const cKindResult = classifyKindSync({ raw: primaryInput, normalized: primaryInput }, cQueryShape)
				const cShapeTime = performance.now() - cStart

				const cPipelineResult = await runPipeline(primaryInput, {
					computeQueryShape,
					groupPhrases,
					classifier: cls as unknown as Parameters<typeof runPipeline>[1]["classifier"],
				})
				const cClassifyTime = performance.now() - cStart - cShapeTime
				const cNodes = flattenTree(cPipelineResult.tree) as ResultNode[]

				if (cancelled) return
				setCompareResult({
					input: primaryInput,
					tree: cPipelineResult.tree,
					nodes: cNodes,
					resolved: null,
					candidates: [],
					kindResult: cKindResult,
					fstActive: false,
					timing: { shape: cShapeTime, classify: cClassifyTime },
				})
			} catch (err) {
				if (cancelled) return
				setError(err instanceof Error ? err.message : String(err))
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
					primary={primary as unknown as DemoResult}
					compare={compareResult}
					primaryVersion={primaryVersion}
					compareVersion={compareVersion ?? "?"}
				/>
			) : null}
		</div>
	)
}
