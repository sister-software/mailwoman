import { buildParsePayload, CandidatePicker, ConfidenceCell, KindBadge, useClipboard } from "@mailwoman/react"
import CodeBlock from "@theme/CodeBlock"
import { Fragment, useCallback, useState } from "react"

import { FailureDiagnostic } from "#components/FailureDiagnostic/FailureDiagnostic"
import { SpanHighlight } from "#components/SpanHighlight/SpanHighlight"
import { TimingPanel } from "#components/TimingPanel/TimingPanel"
import { TreeView } from "#components/TreeView/TreeView"
import type { DemoResult } from "#shared/resources"

import styles from "./styles.module.css"

export interface ResultPanelProps {
	result: DemoResult
	selectedCandidateIndex: number
	onSelectCandidate: (index: number) => void
}

export const ResultPanel: React.FC<ResultPanelProps> = ({ result, selectedCandidateIndex, onSelectCandidate }) => {
	const [showXml, setShowXml] = useState(false)
	const [xml, setXml] = useState<string | null>(null)
	const { copied, copy } = useClipboard()
	const selected = result.candidates[selectedCandidateIndex] ?? result.candidates[0] ?? null

	const onToggle = useCallback(async () => {
		if (xml) {
			setShowXml((v) => !v)

			return
		}

		const { decodeAsXML } = await import("@mailwoman/core/decoder")
		setXml(decodeAsXML(result.tree as Parameters<typeof decodeAsXML>[0]))
		setShowXml(true)
	}, [xml, result.tree])

	// Copy the parse + resolve as a clean JSON object — the thing a developer actually wants to paste
	// into an issue or a test.
	const onCopy = useCallback(() => copy(buildParsePayload(result, selected)), [copy, result, selected])

	return (
		<div className={styles.resultPanel}>
			<div className={styles.resultHeader}>
				<h2>Parsed components</h2>
				<div className={styles.resultActions}>
					<button type="button" className={styles.debugBtn} onClick={onCopy}>
						{copied ? "✓ Copied" : "Copy JSON"}
					</button>
					<button type="button" className={styles.debugBtn} onClick={onToggle}>
						{showXml ? "Hide XML" : "Show XML"}
					</button>
				</div>
			</div>
			{result.kindResult ? <KindBadge kindResult={result.kindResult} /> : null}
			{result.fstActive ? (
				<details style={{ marginBottom: "0.5rem", fontSize: "0.9rem" }}>
					<summary style={{ cursor: "pointer", userSelect: "none" }}>
						<strong>FST prior:</strong> <code>active</code>{" "}
						<span style={{ opacity: 0.7 }}>
							({result.fstProvenance ? `${result.fstProvenance.placeCount.toLocaleString()} places` : "94K US places"})
						</span>
					</summary>
					{result.fstProvenance ? (
						<ul style={{ margin: "0.25rem 0 0 1rem", padding: 0, listStyle: "disc", opacity: 0.7 }}>
							<li>Built: {new Date(result.fstProvenance.builtAt).toLocaleDateString()}</li>
							<li>States: {result.fstProvenance.stateCount.toLocaleString()}</li>
							<li>Importance matches: {result.fstProvenance.importanceMatches.toLocaleString()}</li>
						</ul>
					) : null}
				</details>
			) : null}
			{showXml && xml ? <CodeBlock language="xml">{xml}</CodeBlock> : null}
			<SpanHighlight input={result.input} nodes={result.nodes} />
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
							{selected.tier ? (
								<>
									<dt>precision</dt>
									<dd>
										{selected.tier === "address_point"
											? "📍 exact address point (≤10 m)"
											: `≈ interpolated · ±${selected.uncertaintyM} m`}
									</dd>
								</>
							) : (
								<>
									<dt>WOF id</dt>
									<dd>{selected.id}</dd>
								</>
							)}
							<dt>coords</dt>
							<dd>
								{selected.lat.toFixed(4)}, {selected.lon.toFixed(4)}
							</dd>
							<dt>score</dt>
							<dd>{selected.score.toFixed(3)}</dd>
						</dl>
						{result.dualRoles && result.dualRoles.length ? (
							<p
								style={{
									margin: "0.5rem 0 0",
									padding: "0.4rem 0.6rem",
									borderRadius: "6px",
									background: "var(--ifm-color-info-contrast-background, rgba(54, 122, 246, 0.1))",
									fontSize: "0.9rem",
								}}
							>
								🏛️ <strong>Dual-role place.</strong> {selected.name} also resolves as{" "}
								{result.dualRoles.map((r, i) => (
									<Fragment key={`${r.role}-${r.id}`}>
										{i > 0 ? ", " : ""}a <strong>{r.role}</strong> ({r.relationshipType.replaceAll("-", " ")})
									</Fragment>
								))}
								.
							</p>
						) : null}
					</div>
					{result.candidates.length > 1 ? (
						<CandidatePicker
							candidates={result.candidates}
							selectedIndex={selectedCandidateIndex}
							onSelect={onSelectCandidate}
						/>
					) : null}
				</>
			) : (
				<FailureDiagnostic nodes={result.nodes} />
			)}
		</div>
	)
}
