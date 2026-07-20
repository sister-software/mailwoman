/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `KindBadge` — compact display of the Stage 2.5 kind-classifier verdict: the top kind + confidence
 *   as a pill, expanding to the alternatives on click. Shared by both explorers. The result type is
 *   kept structural (`kind: string`) so both the POI query classifier's `QueryKindResult` and the
 *   pipeline's projection satisfy it without a hard type dependency.
 */

import type { ReactNode } from "react"

export interface KindBadgeResult {
	kind: string
	confidence: number
	alternatives: ReadonlyArray<{ kind: string; confidence: number }>
}

export interface KindBadgeProps {
	kindResult: KindBadgeResult
}

const formatPct = (n: number): string => `${Math.round(n * 100)}%`

export function KindBadge({ kindResult }: KindBadgeProps): ReactNode {
	return (
		<details className="mw-kind">
			<summary className="mw-kind__summary">
				<strong>Kind:</strong> <code>{kindResult.kind}</code>{" "}
				<span className="mw-kind__confidence">({formatPct(kindResult.confidence)})</span>
			</summary>
			{kindResult.alternatives.length > 0 ? (
				<ul className="mw-kind__alternatives">
					{kindResult.alternatives.map((alt) => (
						<li key={alt.kind}>
							<code>{alt.kind}</code> <span className="mw-kind__confidence">({formatPct(alt.confidence)})</span>
						</li>
					))}
				</ul>
			) : null}
		</details>
	)
}
