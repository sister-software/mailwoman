/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ResultNode } from "../../shared/resources.tsx"
import styles from "./styles.module.css"

/**
 * Surfacing why the WOF cascade returned no hit — saves the operator from guessing whether the
 * problem is the parser (didn't extract a locality / postcode), the WOF slim subset (entry not
 * indexed), or a known data quirk (postcode in WOF's 22%-placeholder bucket). The hints are
 * inferred from the parser output alone — no extra resolver round-trips.
 */
export interface FailureDiagnosticProps {
	nodes: ResultNode[]
}

export const FailureDiagnostic: React.FC<FailureDiagnosticProps> = ({ nodes }) => {
	const hasLocality = nodes.some((n) => n.tag === "locality" || n.tag === "city")
	const hasPostcode = nodes.some((n) => n.tag === "postcode" || n.tag === "postal_code")
	const hasRegion = nodes.some((n) => n.tag === "region" || n.tag === "state")

	const hints: string[] = []
	if (!hasLocality && !hasPostcode) {
		hints.push(
			"Parser didn't find a city or ZIP code in this input. Try adding one — e.g. append ', Chicago, IL 60613'."
		)
	}
	if (hasPostcode && !hasLocality) {
		hints.push(
			"Only a ZIP was extracted. WOF ships placeholder lat/lon (0, 0) for ~22% of US postcodes — known issue, the cascade drops those silently."
		)
	}
	if (hasLocality && !hasRegion) {
		hints.push(
			"No state in the parse. Many US localities share names across states (Springfield, Portland, …) — add a state to disambiguate."
		)
	}
	if (hints.length === 0) {
		hints.push(
			"The parsed components look reasonable, but the WOF slim subset (~35 MB, top-1k US localities + all postcodes) doesn't index this entry. The full WOF gazetteer (~1.5 GB) would likely resolve it."
		)
	}

	return (
		<div className={styles.failureDiagnostic}>
			<h2>No WOF hit</h2>
			<ul>
				{hints.map((h, i) => (
					<li key={i}>{h}</li>
				))}
			</ul>
		</div>
	)
}
