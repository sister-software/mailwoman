/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Explains a query that resolved to no place and suggests which component, such as a city or a
 *   state, the visitor could add.
 */

import type { ParsedComponent } from "@mailwoman/core/pipeline/client-result"
import type { ReactNode } from "react"

/**
 * Props for {@link FailureDiagnostic}.
 */
export interface FailureDiagnosticProps {
	nodes: ParsedComponent[]
}

/**
 * Renders hints based on which components the parser found.
 */
export function FailureDiagnostic({ nodes }: FailureDiagnosticProps): ReactNode {
	const hasLocality = nodes.some((n) => n.tag === "locality")
	const hasPostcode = nodes.some((n) => n.tag === "postcode")
	const hasRegion = nodes.some((n) => n.tag === "region")

	const hints: string[] = []

	if (!hasLocality && !hasPostcode) {
		hints.push(
			"The parser found no city or postcode in this input. Try adding one — e.g. append ', Chicago, IL 60613'."
		)
	}

	if (hasPostcode && !hasLocality) {
		hints.push(
			"Only a postcode was extracted. WOF ships placeholder coordinates (0, 0) for about 22% of US postcodes, and the cascade drops those."
		)
	}

	if (hasLocality && !hasRegion) {
		hints.push(
			"No state in the parse. US localities share names across states (Springfield, Portland, …); add a state to disambiguate."
		)
	}

	if (!hints.length) {
		hints.push("The parsed components look reasonable, but the gazetteer does not index this entry.")
	}

	return (
		<div className="mw-failure">
			<h2>No gazetteer hit</h2>
			<ul>
				{hints.map((hint, i) => (
					<li key={i}>{hint}</li>
				))}
			</ul>
		</div>
	)
}
