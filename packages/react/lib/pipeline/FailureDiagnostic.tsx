/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `FailureDiagnostic` — what to say when nothing resolved. It reads the parsed components and names the missing
 *   piece a person can add (a city, a state), so the answer is a next step rather than "no hit".
 */

import type { ParsedComponent } from "@mailwoman/core/pipeline/client-result"
import type { ReactNode } from "react"

export interface FailureDiagnosticProps {
	nodes: ParsedComponent[]
}

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
