/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   VersionCompare — side-by-side parse comparison of two model versions on the same input. Activated
 *   by the Compare toggle on the demo page. Shows two SpanHighlight ribbons, two component tables
 *   with confidence-delta annotations, and a unified diff of tag changes.
 */

import { useMemo } from "react"

import type { DemoResult, ResultNode } from "../../shared/resources.tsx"
import { ConfidenceCell } from "../ResultPanel/ResultPanel.tsx"
import { SpanHighlight } from "../SpanHighlight/SpanHighlight.tsx"
import { TimingPanel } from "../TimingPanel/TimingPanel.tsx"

import styles from "./styles.module.css"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VersionCompareProps {
	/** The primary (left) parse result. */
	primary: DemoResult
	/** The compare (right) parse result. */
	compare: DemoResult
	/** Version label for the primary side. */
	primaryVersion: string
	/** Version label for the compare side. */
	compareVersion: string
}

interface CompareRow {
	/** Tag label (e.g. "house_number", "street"). */
	tag: string
	/** Primary side node, if present. */
	primaryNode: ResultNode | null
	/** Compare side node, if present. */
	compareNode: ResultNode | null
	/** Confidence delta (compare − primary). Positive = improved, negative = regressed. */
	delta: number | null
	/** How this row relates across versions. */
	diffKind: "match" | "primary-only" | "compare-only" | "tag-changed"
}

// ---------------------------------------------------------------------------
// Diff computation
// ---------------------------------------------------------------------------

/**
 * Build a unified diff table of component rows across two parses. Row identity is by source-order position
 * (primary-first, then interleaving). For each primary node we look for a compare node covering the same character
 * span; when the tag differs, both sides are shown as a "tag-changed" row.
 */
function computeCompareRows(primary: DemoResult, compare: DemoResult): CompareRow[] {
	const rows: CompareRow[] = []
	const pNodes = primary.nodes
	const cNodes = compare.nodes

	// Index compare nodes by (start, end) key for span-based matching.
	// Nodes without a span are collected separately for positional fallback.
	const cBySpan = new Map<string, ResultNode>()
	const cUnspanned: ResultNode[] = []

	for (const n of cNodes) {
		if (typeof n.start === "number" && typeof n.end === "number") {
			cBySpan.set(`${n.start}:${n.end}`, n)
		} else {
			cUnspanned.push(n)
		}
	}

	// Walk primary nodes; paired compare nodes are removed from the map so leftovers
	// surface as compare-only. Unspanned nodes are matched positionally.
	const handledSpans = new Set<string>()
	let cUnspannedIdx = 0

	for (const pn of pNodes) {
		const spanKey = typeof pn.start === "number" && typeof pn.end === "number" ? `${pn.start}:${pn.end}` : null
		let cn: ResultNode | null = null

		if (spanKey) {
			cn = cBySpan.get(spanKey) ?? null

			if (cn) handledSpans.add(spanKey)
		} else {
			// Positional fallback for nodes without character spans.
			cn = cUnspanned[cUnspannedIdx] ?? null

			if (cn) cUnspannedIdx++
		}

		if (!cn) {
			rows.push({
				tag: pn.tag,
				primaryNode: pn,
				compareNode: null,
				delta: null,
				diffKind: "primary-only",
			})
			continue
		}

		if (cn.tag !== pn.tag) {
			// Tag changed — show both sides.
			rows.push({
				tag: `${pn.tag} → ${cn.tag}`,
				primaryNode: pn,
				compareNode: cn,
				delta: diffConfidence(cn.confidence, pn.confidence),
				diffKind: "tag-changed",
			})
			continue
		}

		rows.push({
			tag: pn.tag,
			primaryNode: pn,
			compareNode: cn,
			delta: diffConfidence(cn.confidence, pn.confidence),
			diffKind: "match",
		})
	}

	// Remaining spanned compare nodes not matched by span.
	for (const [spanKey, cn] of cBySpan) {
		if (handledSpans.has(spanKey)) continue
		rows.push({
			tag: cn.tag,
			primaryNode: null,
			compareNode: cn,
			delta: null,
			diffKind: "compare-only",
		})
	}

	// Remaining unspanned compare nodes.
	for (let i = cUnspannedIdx; i < cUnspanned.length; i++) {
		rows.push({
			tag: cUnspanned[i].tag,
			primaryNode: null,
			compareNode: cUnspanned[i],
			delta: null,
			diffKind: "compare-only",
		})
	}

	return rows
}

function diffConfidence(c: number | undefined, p: number | undefined): number | null {
	if (c == null || p == null) return null

	return parseFloat((c - p).toFixed(3))
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const DeltaBadge: React.FC<{ delta: number | null; diffKind: CompareRow["diffKind"] }> = ({ delta, diffKind }) => {
	if (delta === null || diffKind === "primary-only" || diffKind === "compare-only") return null
	const abs = Math.abs(delta)

	if (abs < 0.01) return <span className={styles.deltaNeutral}>≈</span>
	const sign = delta >= 0 ? "+" : "−"
	const cls = delta >= 0 ? styles.deltaUp : styles.deltaDown

	return (
		<span className={cls}>
			{sign}
			{abs.toFixed(3)}
		</span>
	)
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const VersionCompare: React.FC<VersionCompareProps> = ({ primary, compare, primaryVersion, compareVersion }) => {
	const rows = useMemo(() => computeCompareRows(primary, compare), [primary, compare])

	const changedCount = rows.filter((r) => r.diffKind !== "match").length

	return (
		<div className={styles.compareRoot}>
			<div className={styles.compareHeader}>
				<h2>Version Compare</h2>
				<span className={styles.compareMeta}>
					{changedCount} difference{changedCount !== 1 ? "s" : ""} — <code>{primaryVersion}</code> vs{" "}
					<code>{compareVersion}</code>
				</span>
			</div>

			{/* Side-by-side SpanHighlight ribbons */}
			<div className={styles.spanRow}>
				<div className={styles.spanCol}>
					<div className={styles.colLabel}>
						<code>{primaryVersion}</code>
					</div>
					<SpanHighlight input={primary.input} nodes={primary.nodes} />
				</div>
				<div className={styles.spanCol}>
					<div className={styles.colLabel}>
						<code>{compareVersion}</code>
					</div>
					<SpanHighlight input={compare.input} nodes={compare.nodes} />
				</div>
			</div>

			{/* Unified diff table */}
			<table className={styles.compareTable}>
				<thead>
					<tr>
						<th>tag</th>
						<th>value</th>
						<th>confidence</th>
						<th className={styles.deltaHead}>Δ</th>
						<th>confidence</th>
						<th>value</th>
						<th>tag</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row, i) => (
						<tr
							key={i}
							className={
								row.diffKind === "primary-only"
									? styles.rowPrimaryOnly
									: row.diffKind === "compare-only"
										? styles.rowCompareOnly
										: row.diffKind === "tag-changed"
											? styles.rowTagChanged
											: undefined
							}
						>
							{/* Primary (left) side */}
							<td className={styles.tagCell}>{row.primaryNode?.tag ?? "—"}</td>
							<td className={styles.valCell}>{row.primaryNode ? String(row.primaryNode.value ?? "") : "—"}</td>
							<td className={styles.confCell}>
								<ConfidenceCell confidence={row.primaryNode?.confidence} />
							</td>

							{/* Delta */}
							<td className={styles.deltaCell}>
								<DeltaBadge delta={row.delta} diffKind={row.diffKind} />
							</td>

							{/* Compare (right) side */}
							<td className={styles.confCell}>
								<ConfidenceCell confidence={row.compareNode?.confidence} />
							</td>
							<td className={styles.valCell}>{row.compareNode ? String(row.compareNode.value ?? "") : "—"}</td>
							<td className={styles.tagCell}>{row.compareNode?.tag ?? "—"}</td>
						</tr>
					))}
				</tbody>
			</table>

			{/* Side-by-side timing */}
			{primary.timing && compare.timing ? (
				<div className={styles.timingRow}>
					<div className={styles.timingCol}>
						<div className={styles.colLabel}>
							<code>{primaryVersion}</code>
						</div>
						<TimingPanel timing={primary.timing} />
					</div>
					<div className={styles.timingCol}>
						<div className={styles.colLabel}>
							<code>{compareVersion}</code>
						</div>
						<TimingPanel timing={compare.timing} />
					</div>
				</div>
			) : null}
		</div>
	)
}
