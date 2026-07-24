/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   PipelineExplorer — the docs-site wrapper around `@mailwoman/react`'s `PipelineExplorer`. The
 *   package owns the UI state machine + the core result presentation (kind badge, component table,
 *   resolved place, candidate picker); this file supplies the docs-specific runtime: it reads the
 *   shared DemoEmbed context (classifier / FST / WOF lookup, all loaded browser-side) and implements
 *   `runParse` (the compute-shape → classify → resolve cascade). The heavy domain visualizers
 *   (SpanHighlight, TreeView, TimingPanel, …) are injected as `panels`, rendered from the parse result
 *   — so onnxruntime-web + httpvfs + those Docusaurus components stay out of the package's graph.
 *
 *   Usage in MDX (unchanged):
 *
 *   ```mdx
 *   import { DemoEmbedProvider } from "@site/src/contexts/DemoEmbed"
 *   import { PipelineExplorer } from "@site/src/components/PipelineExplorer/PipelineExplorer"
 *
 *   <DemoEmbedProvider sqljsBaseURL="/mailwoman/sqljs">
 *     <PipelineExplorer />
 *   </DemoEmbedProvider>
 * ```
 */

import { PipelineExplorer as ReactPipelineExplorer } from "@mailwoman/react"
import type { ParseResult, PipelinePanels, PipelineRuntime, ResolvedPlaceView } from "@mailwoman/react"
import { useMemo } from "react"

import "@mailwoman/react/styles.css"

import { useDemoEmbed } from "../../contexts/DemoEmbed.tsx"
import { DEFAULT_ADDRESS, resolveDualRoles, runCascade, runClassifyStage } from "../../shared/demo-helpers.ts"
import { AboutDemo } from "../AboutDemo/AboutDemo.tsx"
import { BIOHighlight } from "../BIOHighlight/BIOHighlight.tsx"
import { ClassifierOverlay } from "../ClassifierOverlay/ClassifierOverlay.tsx"
import { CRFDiff } from "../CRFDiff/CRFDiff.tsx"
import { FailureDiagnostic } from "../FailureDiagnostic/FailureDiagnostic.tsx"
import { FSTWalker } from "../FSTWalker/FSTWalker.tsx"
import { GuidedTour } from "../GuidedTour/GuidedTour.tsx"
import { SpanHighlight } from "../SpanHighlight/SpanHighlight.tsx"
import { SubwordExplorer } from "../SubwordExplorer/SubwordExplorer.tsx"
import { TimingPanel } from "../TimingPanel/TimingPanel.tsx"
import { TreeView } from "../TreeView/TreeView.tsx"

import styles from "./styles.module.css"

export interface PipelineExplorerProps {
	/** Address to pre-fill in the input. */
	defaultAddress?: string
}

/** The docs demo context, mapped to the package's injected `PipelineRuntime` + `panels`. */
function useDocsPipeline(): { runtime: PipelineRuntime; panels: PipelinePanels } {
	const ctx = useDemoEmbed()
	const {
		manifest,
		selectedVersion,
		classifier,
		fstMatcher,
		fstProvenance,
		lookup,
		selectPairIndex,
		loadingProgress,
		loadingStepIndex,
		loadingStepLabels,
		errorMessage,
		ready,
		activeBackend,
		selectVersion,
		setForceWASM,
		forceWASM,
	} = ctx

	const runtime = useMemo<PipelineRuntime>(() => {
		const parseStageLabels = lookup
			? ["Analyzing input shape…", "Running neural classifier…", "Resolving in gazetteer…"]
			: ["Analyzing input shape…", "Running neural classifier…"]

		return {
			ready,
			parseStageLabels,
			loading: loadingProgress
				? { progress: loadingProgress, stepLabels: loadingStepLabels, stepIndex: loadingStepIndex }
				: null,
			errorMessage,
			async runParse(input, { onStage }): Promise<ParseResult> {
				if (!classifier) throw new Error("classifier not ready")

				// Shared classify front-half (#861 / #1278 seam) — identical to the `/demo` map path, minus the
				// map-only street tier / bias. `onStage(1)` fires between shape and classify, as before.
				const { tree, nodes, kindResult, timing } = await runClassifyStage(
					input,
					{ classifier, fst: fstMatcher, selectPairIndex },
					{ onClassifierStart: () => onStage(1) }
				)

				if (!lookup) {
					return {
						input,
						tree,
						nodes,
						resolved: null,
						candidates: [],
						kindResult,
						fstActive: fstMatcher !== null,
						fstProvenance,
						timing,
					}
				}

				onStage(2)

				const tBeforeResolve = performance.now()
				const cascadeHits = await runCascade(lookup, tree as { roots: unknown[] }, input)
				const tResolve = performance.now()
				const candidates: ResolvedPlaceView[] = cascadeHits.map((c) => ({
					id: c.id,
					name: c.name,
					placetype: c.placetype,
					lat: c.lat,
					lon: c.lon,
					score: c.score,
				}))

				// Dual-role (#402), shared with the `/demo` map path.
				const dualRoles = await resolveDualRoles(lookup, candidates[0])

				return {
					input,
					tree,
					nodes,
					resolved: candidates[0] ?? null,
					candidates,
					kindResult,
					fstActive: fstMatcher !== null,
					fstProvenance,
					timing: { ...timing, resolve: tResolve - tBeforeResolve },
					dualRoles,
				}
			},
		}
	}, [
		ready,
		classifier,
		fstMatcher,
		fstProvenance,
		lookup,
		selectPairIndex,
		loadingProgress,
		loadingStepIndex,
		loadingStepLabels,
		errorMessage,
	])

	const currentRelease = manifest?.releases.find((r) => r.version === selectedVersion)

	const panels = useMemo<PipelinePanels>(
		() => ({
			header: <AboutDemo />,
			footer: <GuidedTour />,
			releaseInfo: currentRelease ? (
				<p className={styles.releaseInfo}>
					<strong>{currentRelease.version}</strong> — {currentRelease.description} ({currentRelease.modelSize},{" "}
					{currentRelease.tokenizerVocab.toLocaleString()} vocab, {currentRelease.steps.toLocaleString()} steps)
				</p>
			) : null,
			versionControl:
				manifest && manifest.releases.length > 1 ? (
					<div className={styles.versionRow}>
						<label htmlFor="pe-version-select">Model version</label>
						<select
							id="pe-version-select"
							value={selectedVersion ?? ""}
							onChange={(e) => selectVersion(e.target.value)}
							disabled={!ready}
						>
							{manifest.releases.map((r) => (
								<option key={r.version} value={r.version}>
									{r.label}
								</option>
							))}
						</select>
					</div>
				) : null,
			backendControl: (
				<div className={styles.backendRow}>
					{activeBackend ? (
						<span>
							Backend: <code>{activeBackend}</code>
						</span>
					) : null}
					<label className={styles.wasmToggle}>
						<input type="checkbox" checked={forceWASM} onChange={(e) => setForceWASM(e.target.checked)} />
						Force WASM
					</label>
				</div>
			),
			extras: (result: ParseResult) => (
				<>
					{result.fstActive ? (
						<details className={styles.fstDetails}>
							<summary>
								<strong>FST prior:</strong> <code>active</code>{" "}
								<span>
									(
									{result.fstProvenance
										? `${result.fstProvenance.placeCount.toLocaleString()} places`
										: "94K US places"}
									)
								</span>
							</summary>
							{result.fstProvenance ? (
								<ul>
									<li>Built: {new Date(result.fstProvenance.builtAt).toLocaleDateString()}</li>
									<li>States: {result.fstProvenance.stateCount.toLocaleString()}</li>
									<li>Importance matches: {result.fstProvenance.importanceMatches.toLocaleString()}</li>
								</ul>
							) : null}
						</details>
					) : null}

					{result.fstActive ? (
						<details className={styles.hierarchyDetails}>
							<summary>FST walker</summary>
							<FSTWalker input={result.input} />
						</details>
					) : null}

					<SpanHighlight input={result.input} nodes={result.nodes} />

					<details className={styles.hierarchyDetails}>
						<summary>Subword tokens & pipeline stages</summary>
						<SubwordExplorer
							input={result.input}
							nodes={result.nodes}
							tree={result.tree}
							kindResult={result.kindResult}
							timing={result.timing}
						/>
					</details>

					<details className={styles.hierarchyDetails}>
						<summary>BIO labels</summary>
						<BIOHighlight input={result.input} nodes={result.nodes} />
					</details>

					<details className={styles.hierarchyDetails}>
						<summary>Classification origin</summary>
						<ClassifierOverlay tree={result.tree} nodes={result.nodes} fstActive={result.fstActive} />
					</details>

					<details className={styles.hierarchyDetails}>
						<summary>CRF: argmax vs Viterbi</summary>
						<CRFDiff />
					</details>

					{result.timing ? <TimingPanel timing={result.timing} /> : null}

					{(result.tree as { roots?: unknown[] } | null)?.roots?.length ? (
						<details className={styles.hierarchyDetails}>
							<summary>Hierarchy</summary>
							<TreeView tree={result.tree} />
						</details>
					) : null}
				</>
			),
			failure: (result: ParseResult) => <FailureDiagnostic nodes={result.nodes} />,
		}),
		[manifest, currentRelease, selectedVersion, selectVersion, ready, activeBackend, forceWASM, setForceWASM]
	)

	return { runtime, panels }
}

function PipelineExplorerInner({ defaultAddress }: { defaultAddress: string }) {
	const { runtime, panels } = useDocsPipeline()

	return <ReactPipelineExplorer runtime={runtime} defaultAddress={defaultAddress} panels={panels} />
}

export function PipelineExplorer({ defaultAddress = DEFAULT_ADDRESS }: PipelineExplorerProps) {
	return <PipelineExplorerInner defaultAddress={defaultAddress} />
}
