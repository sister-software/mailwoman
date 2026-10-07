/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The evidence the selection links to: each selected building's part of the dossier report, the text of the
 *   building's `reportLines` records, and the cost and value report that `renderScenarioReport` writes for the
 *   selection. Both are shown as the model writes them, so the page and the reports cannot disagree.
 */

import type { EntityID } from "@mailwoman/dossier"
import type { ReactNode } from "react"

import { COST_AND_VALUE_ANCHOR, dossierAnchor } from "#evidence"
import type { Result } from "#view"

export interface EvidenceSectionProps {
	selection: readonly EntityID[]
	labels: ReadonlyMap<EntityID, string>
	dossierParts: ReadonlyMap<EntityID, string>
	costAndValue: Result<string>
}

export function EvidenceSection({ selection, labels, dossierParts, costAndValue }: EvidenceSectionProps): ReactNode {
	return (
		<section className="panel panel--evidence" aria-labelledby="evidence-heading">
			<h2 id="evidence-heading">Evidence for the selection</h2>
			{selection.length ? null : <p className="panel__note">No building is selected.</p>}
			{selection.map((building) => {
				const anchor = dossierAnchor(building)

				return (
					<article key={building} id={anchor} tabIndex={-1} aria-labelledby={`${anchor}-heading`}>
						<h3 id={`${anchor}-heading`}>Dossier part: {labels.get(building) ?? building}</h3>
						<pre>{dossierParts.get(building)}</pre>
					</article>
				)
			})}
			{selection.length ? (
				<article id={COST_AND_VALUE_ANCHOR} tabIndex={-1} aria-labelledby={`${COST_AND_VALUE_ANCHOR}-heading`}>
					<h3 id={`${COST_AND_VALUE_ANCHOR}-heading`}>Cost and value report for the selection</h3>
					{costAndValue.status === "computed" ? <pre>{costAndValue.value}</pre> : null}
					{costAndValue.status === "refused" ? <p className="refusal">{costAndValue.message}</p> : null}
				</article>
			) : null}
		</section>
	)
}
