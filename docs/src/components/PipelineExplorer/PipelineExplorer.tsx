/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   PipelineExplorer — a self-contained, embeddable Mailwoman address parser component for Docusaurus
 *   MDX pages. Wraps BrowserOnly (SSR-safe) and consumes the shared DemoEmbed context for
 *   classifier/lookup loading. Renders the full parse result with the existing SpanHighlight,
 *   TreeView, TimingPanel, and related reusable components.
 *
 *   Usage in MDX:
 *
 *   ```mdx
 *   import { DemoEmbedProvider } from "@site/src/contexts/DemoEmbed"
 *   import { PipelineExplorer } from "@site/src/components/PipelineExplorer/PipelineExplorer"
 *
 *   <DemoEmbedProvider sqljsBaseUrl="/mailwoman/sqljs">
 *     <PipelineExplorer />
 *   </DemoEmbedProvider>
 * ```
 */

import BrowserOnly from "@docusaurus/BrowserOnly"
import React, { useCallback, useMemo, useState } from "react"

import { useDemoEmbed } from "../../contexts/DemoEmbed.tsx"
import { DEFAULT_ADDRESS, EXAMPLE_ADDRESSES, flattenTree, runCascade } from "../../shared/demo-helpers.ts"
import type { DemoResult, DualRole, ResolvedHit } from "../../shared/resources.tsx"
import { AboutDemo } from "../AboutDemo/AboutDemo.tsx"
import { BIOHighlight } from "../BIOHighlight/BIOHighlight.tsx"
import { CandidatePicker } from "../CandidatePicker/CandidatePicker.tsx"
import { ClassifierOverlay } from "../ClassifierOverlay/ClassifierOverlay.tsx"
import { CRFDiff } from "../CRFDiff/CRFDiff.tsx"
import { FailureDiagnostic } from "../FailureDiagnostic/FailureDiagnostic.tsx"
import { FSTWalker } from "../FSTWalker/FSTWalker.tsx"
import { GuidedTour } from "../GuidedTour/GuidedTour.tsx"
import { KindBadge } from "../KindBadge/KindBadge.tsx"
import { LoadingIndicator } from "../LoadingIndicator/LoadingIndicator.tsx"
import { SpanHighlight } from "../SpanHighlight/SpanHighlight.tsx"
import { SubwordExplorer } from "../SubwordExplorer/SubwordExplorer.tsx"
import { TimingPanel } from "../TimingPanel/TimingPanel.tsx"
import { TreeView } from "../TreeView/TreeView.tsx"

import styles from "./styles.module.css"

// ---------------------------------------------------------------------------
// Confidence cell (mirrors ResultPanel)
// ---------------------------------------------------------------------------

function tier(confidence?: number): "high" | "mid" | "low" {
	if (confidence == null) return "mid"

	return confidence >= 0.8 ? "high" : confidence >= 0.5 ? "mid" : "low"
}

const ConfidenceCell: React.FC<{ confidence?: number }> = ({ confidence }) => {
	if (confidence == null) return <span className={styles.confDash}>—</span>
	const pct = Math.max(0, Math.min(1, confidence)) * 100
	const t = tier(confidence)

	return (
		<div className={styles.confCell}>
			<div className={`${styles.confBar} ${styles[`conf_${t}`]}`} style={{ width: `${pct}%` }} />
			<span className={styles.confValue}>{confidence.toFixed(2)}</span>
		</div>
	)
}

// ---------------------------------------------------------------------------
// PipelineExplorer props
// ---------------------------------------------------------------------------

export interface PipelineExplorerProps {
	/** Address to pre-fill in the input. */
	defaultAddress?: string
}

// ---------------------------------------------------------------------------
// Inner component (below BrowserOnly boundary)
// ---------------------------------------------------------------------------

const PipelineExplorerInner: React.FC<{ defaultAddress: string }> = ({ defaultAddress }) => {
	const {
		manifest,
		selectedVersion,
		classifier,
		fstMatcher,
		fstProvenance,
		lookup,
		loadingProgress,
		loadingStepIndex,
		loadingStepLabels,
		errorMessage: ctxError,
		ready,
		activeBackend,
		selectVersion,
		setForceWasm,
		forceWasm,
	} = useDemoEmbed()

	const [text, setText] = useState(defaultAddress)
	const [busy, setBusy] = useState(false)
	const [parseStage, setParseStage] = useState(-1)
	const [result, setResult] = useState<DemoResult | null>(null)
	const [selectedCandidateIndex, setSelectedCandidateIndex] = useState(0)
	const [parseError, setParseError] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)

	// Parse stage labels depend on whether WOF lookup is available for the selected release.
	const parseStageLabels = useMemo(
		() =>
			lookup
				? ["Analyzing input shape…", "Running neural classifier…", "Resolving in gazetteer…"]
				: ["Analyzing input shape…", "Running neural classifier…"],
		[lookup]
	)

	const onSubmit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault()

			if (!classifier) return
			setBusy(true)
			setParseStage(0)
			setParseError(null)

			try {
				const [{ computeQueryShape }, { classifyKindSync }, { runPipeline }, { groupPhrases }] = await Promise.all([
					import("@mailwoman/query-shape"),
					import("@mailwoman/kind-classifier"),
					import("@mailwoman/core/pipeline"),
					import("@mailwoman/phrase-grouper"),
				])
				const tStart = performance.now()
				const queryShape = computeQueryShape(text)
				const kindResult = classifyKindSync({ raw: text, normalized: text }, queryShape)
				const tShape = performance.now()

				setParseStage(1)

				const pipelineResult = await runPipeline(text, {
					computeQueryShape,
					groupPhrases,
					classifier: classifier as unknown as Parameters<typeof runPipeline>[1]["classifier"],
					fst: (fstMatcher ?? undefined) as Parameters<typeof runPipeline>[1]["fst"],
				})
				const tClassify = performance.now()
				const tree = pipelineResult.tree
				const nodes = flattenTree(tree)

				const localityNodes = nodes.filter((n) => n.tag === "locality" || n.tag === "city")
				const stateNode = nodes
					.filter((n) => n.tag === "region" || n.tag === "state")
					.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]
				const postcodeNode = nodes.find((n) => n.tag === "postcode" || n.tag === "postal_code")

				const wofLookup = lookup

				if (!wofLookup) {
					setResult({
						input: text,
						tree,
						nodes,
						resolved: null,
						candidates: [],
						stateHint: stateNode?.value as string | undefined,
						kindResult,
						fstActive: fstMatcher !== null,
						fstProvenance,
						timing: { shape: tShape - tStart, classify: tClassify - tShape },
					})

					return
				}

				setParseStage(2)

				const tBeforeResolve = performance.now()
				const cascadeHits = await runCascade(wofLookup, postcodeNode, localityNodes, stateNode, text)
				const tResolve = performance.now()
				const candidates: ResolvedHit[] = cascadeHits.map((c) => ({
					id: c.id,
					name: c.name,
					placetype: c.placetype,
					lat: c.lat,
					lon: c.lon,
					score: c.score,
					bbox: c.bbox,
				}))

				let dualRoles: DualRole[] | undefined
				const primaryHit = candidates[0]

				if (primaryHit && wofLookup.coincidentRolesFor) {
					try {
						const roles = await wofLookup.coincidentRolesFor(primaryHit.id)

						if (roles.length > 0) dualRoles = roles
					} catch {
						/* relation absent → no dual-role badge */
					}
				}

				setSelectedCandidateIndex(0)
				setResult({
					input: text,
					tree,
					nodes,
					resolved: candidates[0] ?? null,
					candidates,
					stateHint: stateNode?.value as string | undefined,
					kindResult,
					fstActive: fstMatcher !== null,
					fstProvenance,
					timing: {
						shape: tShape - tStart,
						classify: tClassify - tShape,
						resolve: tResolve - tBeforeResolve,
					},
					dualRoles,
				})
			} catch (err) {
				console.error("Error parsing input", err)
				setParseError(err instanceof Error ? err.message : String(err))
			} finally {
				setBusy(false)
				setParseStage(-1)
			}
		},
		[classifier, text, fstMatcher, lookup, fstProvenance]
	)

	const onCopy = useCallback(async () => {
		if (!result) return
		const selected = result.candidates[selectedCandidateIndex] ?? result.candidates[0] ?? null
		const payload = {
			input: result.input,
			components: result.nodes.map((n) => ({
				tag: n.tag,
				value: n.value ?? null,
				confidence: n.confidence ?? null,
				start: n.start ?? null,
				end: n.end ?? null,
			})),
			resolved: selected
				? {
						name: selected.name,
						placetype: selected.placetype,
						id: selected.id,
						lat: selected.lat,
						lon: selected.lon,
						score: selected.score,
					}
				: null,
		}
		const json = JSON.stringify(payload, null, 2)

		try {
			await navigator.clipboard.writeText(json)
		} catch {
			const ta = document.createElement("textarea")
			ta.value = json
			ta.style.position = "fixed"
			ta.style.opacity = "0"
			document.body.appendChild(ta)
			ta.select()

			try {
				document.execCommand("copy")
			} catch {
				/* fall through */
			}
			document.body.removeChild(ta)
		}
		setCopied(true)
		window.setTimeout(() => setCopied(false), 1500)
	}, [result, selectedCandidateIndex])

	const currentRelease = manifest?.releases.find((r) => r.version === selectedVersion)
	const selected = result?.candidates[selectedCandidateIndex] ?? result?.candidates[0] ?? null
	const errorMessage = parseError ?? ctxError

	return (
		<div className={styles.pipelineExplorer}>
			<AboutDemo />
			{currentRelease ? (
				<p className={styles.releaseInfo}>
					<strong>{currentRelease.version}</strong> — {currentRelease.description} ({currentRelease.modelSize},{" "}
					{currentRelease.tokenizerVocab.toLocaleString()} vocab, {currentRelease.steps.toLocaleString()} steps)
				</p>
			) : null}

			{manifest && manifest.releases.length > 1 ? (
				<div className={styles.versionRow}>
					<label htmlFor="pe-version-select">Model version</label>
					<select
						id="pe-version-select"
						value={selectedVersion ?? ""}
						onChange={(e) => selectVersion(e.target.value)}
						disabled={busy}
					>
						{manifest.releases.map((r) => (
							<option key={r.version} value={r.version}>
								{r.label}
							</option>
						))}
					</select>
				</div>
			) : null}

			<div className={styles.backendRow}>
				{activeBackend ? (
					<span>
						Backend: <code>{activeBackend}</code>
					</span>
				) : null}
				<label className={styles.wasmToggle}>
					<input type="checkbox" checked={forceWasm} onChange={(e) => setForceWasm(e.target.checked)} />
					Force WASM
				</label>
			</div>

			<form onSubmit={onSubmit} className={styles.form}>
				<label htmlFor="pe-addr-input">Address</label>
				<input
					id="pe-addr-input"
					type="text"
					value={text}
					onChange={(e) => setText(e.target.value)}
					disabled={!ready || busy}
					placeholder={DEFAULT_ADDRESS}
				/>
				<button type="submit" disabled={!ready || busy}>
					{busy ? (
						<>
							<LoadingIndicator mode="spinner" size="small" /> Parsing…
						</>
					) : (
						"Parse + resolve"
					)}
				</button>
			</form>

			<div className={styles.examples}>
				<span className={styles.examplesLabel}>Try:</span>
				{EXAMPLE_ADDRESSES.map((ex) => (
					<button
						key={ex.label}
						type="button"
						className={styles.exampleBtn}
						disabled={!ready || busy}
						onClick={() => {
							setText(ex.address)
							setResult(null)
						}}
						title={ex.address}
					>
						{ex.label}
					</button>
				))}
			</div>

			{loadingProgress && !ready ? (
				<LoadingIndicator
					mode="staged"
					steps={loadingStepLabels.length > 0 ? loadingStepLabels : undefined}
					activeStep={loadingStepIndex}
					label={loadingProgress}
				/>
			) : null}
			{errorMessage ? <p className={styles.error}>{errorMessage}</p> : null}

			{busy ? (
				<div className={styles.resultPanel}>
					<LoadingIndicator mode="staged" steps={parseStageLabels} activeStep={parseStage} />
				</div>
			) : result ? (
				<div className={styles.resultPanel}>
					<div className={styles.resultHeader}>
						<h2>Parsed components</h2>
						<button type="button" className={styles.debugBtn} onClick={onCopy}>
							{copied ? "✓ Copied" : "Copy JSON"}
						</button>
					</div>

					{result.kindResult ? <KindBadge kindResult={result.kindResult} /> : null}

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

					<table className={styles.componentTable}>
						<thead>
							<tr>
								<th>tag</th>
								<th>value</th>
								<th>confidence</th>
							</tr>
						</thead>
						<tbody>
							{result.nodes.map((n, i) => (
								<tr key={i}>
									<td>{n.tag}</td>
									<td>{String(n.value ?? "")}</td>
									<td>
										<ConfidenceCell confidence={n.confidence} />
									</td>
								</tr>
							))}
						</tbody>
					</table>

					{result.timing ? <TimingPanel timing={result.timing} /> : null}

					{(result.tree as { roots?: unknown[] } | null)?.roots?.length ? (
						<details className={styles.hierarchyDetails}>
							<summary>Hierarchy</summary>
							<TreeView tree={result.tree} />
						</details>
					) : null}

					{selected ? (
						<>
							<div className={styles.resolved}>
								<h2>Resolved place</h2>
								<dl>
									<dt>name</dt>
									<dd>{selected.name}</dd>
									<dt>placetype</dt>
									<dd>{selected.placetype}</dd>
									<dt>WOF id</dt>
									<dd>{selected.id}</dd>
									<dt>coords</dt>
									<dd>
										{selected.lat.toFixed(4)}, {selected.lon.toFixed(4)}
									</dd>
									<dt>score</dt>
									<dd>{selected.score.toFixed(3)}</dd>
								</dl>
								{result.dualRoles && result.dualRoles.length > 0 ? (
									<p className={styles.dualRoleNote}>
										🏛️ <strong>Dual-role place.</strong> {selected.name} also resolves as{" "}
										{result.dualRoles.map((r, i) => (
											<React.Fragment key={`${r.role}-${r.id}`}>
												{i > 0 ? ", " : ""}a <strong>{r.role}</strong> ({r.relationshipType.replace(/-/g, " ")})
											</React.Fragment>
										))}
										.
									</p>
								) : null}
							</div>
							{result.candidates.length > 1 ? (
								<CandidatePicker
									candidates={result.candidates}
									selectedIndex={selectedCandidateIndex}
									onSelect={setSelectedCandidateIndex}
								/>
							) : null}
						</>
					) : (
						<FailureDiagnostic nodes={result.nodes} />
					)}
				</div>
			) : null}

			<GuidedTour />
		</div>
	)
}

// ---------------------------------------------------------------------------
// Public component (with BrowserOnly SSR boundary)
// ---------------------------------------------------------------------------

export const PipelineExplorer: React.FC<PipelineExplorerProps> = ({ defaultAddress = DEFAULT_ADDRESS }) => {
	return (
		<BrowserOnly
			fallback={
				<div className={styles.pipelineExplorer}>
					<p>Loading demo embed…</p>
				</div>
			}
		>
			{() => <PipelineExplorerInner defaultAddress={defaultAddress} />}
		</BrowserOnly>
	)
}
