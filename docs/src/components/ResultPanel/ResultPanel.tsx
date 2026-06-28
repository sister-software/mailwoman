import CodeBlock from "@theme/CodeBlock"
import { Fragment, useCallback, useState } from "react"

import { DemoResult } from "../../shared/resources.tsx"
import { CandidatePicker } from "../CandidatePicker/CandidatePicker.tsx"
import { FailureDiagnostic } from "../FailureDiagnostic/FailureDiagnostic.tsx"
import { KindBadge } from "../KindBadge/KindBadge.tsx"
import { SpanHighlight } from "../SpanHighlight/SpanHighlight.tsx"
import { TimingPanel } from "../TimingPanel/TimingPanel.tsx"
import { TreeView } from "../TreeView/TreeView.tsx"

import styles from "./styles.module.css"

export interface ConfidenceCellProps {
	confidence?: number
}

/**
 * Render confidence as a horizontal bar (0–1 → 0–100% width) + numeric value. Color shifts from red→amber→green at .5 /
 * .8 thresholds so eyeballing the table surfaces low-confidence predictions without reading every number.
 */
export const ConfidenceCell: React.FC<ConfidenceCellProps> = ({ confidence }) => {
	if (confidence == null) return <span className={styles.confDash}>—</span>
	const pct = Math.max(0, Math.min(1, confidence)) * 100
	const tier = confidence >= 0.8 ? "high" : confidence >= 0.5 ? "mid" : "low"

	return (
		<div className={styles.confCell}>
			<div className={`${styles.confBar} ${styles[`conf_${tier}`]}`} style={{ width: `${pct}%` }} />
			<span className={styles.confValue}>{confidence.toFixed(2)}</span>
		</div>
	)
}

export interface ResultPanelProps {
	result: DemoResult
	selectedCandidateIndex: number
	onSelectCandidate: (index: number) => void
}

export const ResultPanel: React.FC<ResultPanelProps> = ({ result, selectedCandidateIndex, onSelectCandidate }) => {
	const [showXml, setShowXml] = useState(false)
	const [xml, setXml] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)
	const selected = result.candidates[selectedCandidateIndex] ?? result.candidates[0] ?? null

	const onToggle = useCallback(async () => {
		if (xml) {
			setShowXml((v) => !v)

			return
		}
		const { decodeAsXml } = await import("@mailwoman/core/decoder")
		setXml(decodeAsXml(result.tree as Parameters<typeof decodeAsXml>[0]))
		setShowXml(true)
	}, [xml, result.tree])

	// Copy the parse + resolve as a clean JSON object — the thing a developer actually wants to paste
	// into an issue or a test. Mirrors PermalinkButton's clipboard-with-textarea-fallback + 1.5s tick.
	const onCopy = useCallback(async () => {
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
				/* nothing more we can do */
			}
			document.body.removeChild(ta)
		}
		setCopied(true)
		window.setTimeout(() => setCopied(false), 1500)
	}, [result, selected])

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
						{result.dualRoles && result.dualRoles.length > 0 ? (
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
										{i > 0 ? ", " : ""}a <strong>{r.role}</strong> ({r.relationshipType.replace(/-/g, " ")})
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
