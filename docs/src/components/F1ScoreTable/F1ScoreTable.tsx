/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   F1ScoreTable — a sortable table for the status page that surfaces per-tag F1 scores from the
 *   parity scorecard, with hover tooltips explaining what each score means in context. Click any
 *   column header to sort ascending; click again to reverse.
 *
 *   The data is sourced from the parity-scorecard-2026-06-11.md and the v4.3.0 ship gate. It is
 *   hardcoded here — the scorecard is the single source of truth; this component mirrors it for the
 *   status page.
 */

import BrowserOnly from "@docusaurus/BrowserOnly"
import React, { useMemo, useState } from "react"

import styles from "./styles.module.css"

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

interface F1Row {
	/** Human-readable tag label (e.g. "us.street"). */
	tag: string
	/** Which eval set this was measured against. */
	eval: string
	/** Tooltip explaining this metric in context. */
	tooltip: string
	/** F1 score (0–100). `null` means not measured for this version. */
	v410: number | null
	v420: number | null
	v430: number | null
}

type SortKey = "tag" | "eval" | "v410" | "v420" | "v430"

// ---------------------------------------------------------------------------
// F1 data (sourced from parity-scorecard-2026-06-11.md)
// ---------------------------------------------------------------------------

const F1_DATA: F1Row[] = [
	{
		tag: "street_prefix",
		eval: "real-affix (32-row)",
		tooltip:
			"F1 on 32 real-world street prefix designators (e.g. 'N', 'East') extracted from NAD (National Address Database) addresses. These are out-of-distribution examples the model never saw during training.",
		v410: 0,
		v420: 64.9,
		v430: 93.6,
	},
	{
		tag: "street_suffix",
		eval: "real-affix (32-row)",
		tooltip:
			"F1 on 32 real-world street suffix designators (e.g. 'St', 'Ave') extracted from NAD addresses. Out-of-distribution.",
		v410: 0,
		v420: 48.8,
		v430: 96.6,
	},
	{
		tag: "street_prefix",
		eval: "NAD-native v2 (193-row)",
		tooltip:
			"F1 on 193 NAD-native addresses sourced independently from the training corpus (v2 holdout). This is a larger and more representative street-prefix test.",
		v410: null,
		v420: 18.2,
		v430: 92.2,
	},
	{
		tag: "street_suffix",
		eval: "NAD-native v2 (193-row)",
		tooltip: "F1 on 193 NAD-native addresses for street suffix detection. Independent of the training corpus.",
		v410: null,
		v420: 8.9,
		v430: 90.3,
	},
	{
		tag: "unit",
		eval: "real-designators",
		tooltip:
			"F1 on real-world unit/secondary designators (e.g. 'Apt 3B', 'Suite 100', '#12'). Measured on the real-OOD designator test set.",
		v410: 92.3,
		v420: 90.6,
		v430: 92.1,
	},
	{
		tag: "country",
		eval: "homograph-real",
		tooltip:
			"F1 on homograph-heavy real examples where country names overlap with other components (e.g. 'Mexico, NY'). Measures the gazetteer soft anchor's ability to disambiguate.",
		v410: 27,
		v420: 89.8,
		v430: 85.1,
	},
	{
		tag: "us.street",
		eval: "golden dev",
		tooltip:
			"F1 on the golden development set — curated, hand-labeled US addresses used as the primary training-eval holdout. Folded tag: combines street, street_prefix, and street_suffix.",
		v410: 78.5,
		v420: 76.2,
		v430: 75.5,
	},
	{
		tag: "us.locality",
		eval: "golden dev",
		tooltip:
			"F1 on US locality (city/town) extraction from the golden development set. The large jump from v4.1.0 → v4.2.0 came from the consolidation recipe; v4.3.0 added another +1.5pp.",
		v410: 60.1,
		v420: 72.9,
		v430: 74.4,
	},
	{
		tag: "us.region",
		eval: "golden dev",
		tooltip:
			"F1 on US region/state extraction from the golden development set. The consolidation recipe lifted this from 78.4 → 89.1; stable since.",
		v410: 78.4,
		v420: 89.1,
		v430: 89.1,
	},
	{
		tag: "us.postcode",
		eval: "golden dev",
		tooltip:
			"F1 on US ZIP/postcode extraction from the golden development set. Consistently the highest-scoring tag across all releases.",
		v410: 98.3,
		v420: 97.3,
		v430: 97.8,
	},
	{
		tag: "us.micro",
		eval: "golden dev",
		tooltip:
			"F1 on US micro F1 (macro-averaged across all tags) from the golden development set. A composite measure of overall parser quality.",
		v410: 81.6,
		v420: 84.8,
		v430: 85.1,
	},
	{
		tag: "fr.postcode",
		eval: "golden dev",
		tooltip:
			"F1 on French postcode (e.g. '75001') extraction from the golden development set. The conventions layer mask pins the 5-digit shape for fr-FR.",
		v410: 99.5,
		v420: 99.6,
		v430: 99.7,
	},
	{
		tag: "fr.house_number",
		eval: "golden dev",
		tooltip:
			"F1 on French house number extraction from the golden development set. Improved significantly in v4.3.0 (91.0 → 97.7) thanks to the conventions mask.",
		v410: 91.0,
		v420: 94.6,
		v430: 97.7,
	},
	{
		tag: "fr.region",
		eval: "golden dev",
		tooltip:
			"F1 on French region/département extraction from the golden development set. Currently the weakest link — down to 16.2 in v4.3.0. Needs corpus rows.",
		v410: 30.2,
		v420: 27.6,
		v430: 16.2,
	},
	{
		tag: "de.native_locality",
		eval: "de-order (anchor on)",
		tooltip:
			"F1 on German locality extraction from native-order German addresses ('Musterstraße 1, 10115 Berlin'). Measured with the postcode anchor active.",
		v410: 90.6,
		v420: 90.9,
		v430: 90.1,
	},
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Color a cell based on the score range: red < 30, amber 30–80, green ≥ 80. */
function scoreClass(value: number | null): string {
	if (value == null) return styles.cellNA

	if (value >= 80) return styles.cellHigh

	if (value >= 30) return styles.cellMid

	return styles.cellLow
}

/** Draw an arrow for the sort direction. */
function sortArrow(key: SortKey, current: SortKey, dir: "asc" | "desc"): string {
	if (key !== current) return ""

	return dir === "asc" ? " ▲" : " ▼"
}

// ---------------------------------------------------------------------------
// Tooltip component (pure CSS tooltip — lightweight, works without JS in SSR)
// ---------------------------------------------------------------------------

const Tooltip: React.FC<{ text: string; children: React.ReactNode }> = ({ text, children }) => {
	return (
		<span className={styles.tooltipWrap}>
			{children}
			<span className={styles.tooltip}>{text}</span>
		</span>
	)
}

// ---------------------------------------------------------------------------
// Inner component (below BrowserOnly boundary — sort state is React)
// ---------------------------------------------------------------------------

const F1ScoreTableInner: React.FC = () => {
	const [sortKey, setSortKey] = useState<SortKey>("tag")
	const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")

	const sortedRows = useMemo(() => {
		const rows = [...F1_DATA]
		rows.sort((a, b) => {
			const av = a[sortKey]
			const bv = b[sortKey]

			// Treat null as -Infinity so it sorts to the bottom in both directions.
			if (av == null && bv == null) return 0

			if (av == null) return 1

			if (bv == null) return -1

			if (typeof av === "string" && typeof bv === "string") {
				return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av)
			}

			const an = av as number
			const bn = bv as number

			return sortDir === "asc" ? an - bn : bn - an
		})

		return rows
	}, [sortKey, sortDir])

	const handleSort = (key: SortKey) => {
		if (sortKey === key) {
			setSortDir((d) => (d === "asc" ? "desc" : "asc"))
		} else {
			setSortKey(key)
			setSortDir("asc")
		}
	}

	return (
		<div className={styles.tableWrapper}>
			<table className={styles.f1Table}>
				<thead>
					<tr>
						<th className={styles.sortableHeader} onClick={() => handleSort("tag")}>
							tag{sortArrow("tag", sortKey, sortDir)}
						</th>
						<th className={styles.sortableHeader} onClick={() => handleSort("eval")}>
							eval set{sortArrow("eval", sortKey, sortDir)}
						</th>
						<th className={styles.sortableHeader} onClick={() => handleSort("v410")}>
							v4.1.0{sortArrow("v410", sortKey, sortDir)}
						</th>
						<th className={styles.sortableHeader} onClick={() => handleSort("v420")}>
							v4.2.0{sortArrow("v420", sortKey, sortDir)}
						</th>
						<th className={styles.sortableHeader} onClick={() => handleSort("v430")}>
							v4.3.0{sortArrow("v430", sortKey, sortDir)}
						</th>
					</tr>
				</thead>
				<tbody>
					{sortedRows.map((row, i) => (
						<tr key={i}>
							<td className={styles.tagCell}>
								<code>{row.tag}</code>
							</td>
							<td className={styles.evalCell}>{row.eval}</td>
							<Tooltip text={row.tooltip}>
								<td className={`${styles.f1Cell} ${scoreClass(row.v410)}`}>
									{row.v410 != null ? row.v410.toFixed(1) : "—"}
								</td>
							</Tooltip>
							<Tooltip text={row.tooltip}>
								<td className={`${styles.f1Cell} ${scoreClass(row.v420)}`}>
									{row.v420 != null ? row.v420.toFixed(1) : "—"}
								</td>
							</Tooltip>
							<Tooltip text={row.tooltip}>
								<td className={`${styles.f1Cell} ${scoreClass(row.v430)}`}>
									{row.v430 != null ? row.v430.toFixed(1) : "—"}
								</td>
							</Tooltip>
						</tr>
					))}
				</tbody>
			</table>
			<p className={styles.footnote}>
				Source: <a href="./evals/parity-scorecard-2026-06-11">parity-scorecard-2026-06-11.md</a>. Click any column
				header to sort. Hover over a score to see what it means in context.{" "}
				<span className={styles.colorKey}>
					<span className={styles.keyHigh}>≥ 80 healthy</span> · <span className={styles.keyMid}>30–79 moderate</span> ·{" "}
					<span className={styles.keyLow}>&lt; 30 needs work</span>
				</span>
			</p>
		</div>
	)
}

// ---------------------------------------------------------------------------
// Public component (SSR-safe)
// ---------------------------------------------------------------------------

export const F1ScoreTable: React.FC = () => {
	return <BrowserOnly fallback={<p>Loading F1 score table…</p>}>{() => <F1ScoreTableInner />}</BrowserOnly>
}
