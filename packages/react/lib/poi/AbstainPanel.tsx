/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `AbstainPanel` — shown when the query carries no POI intent (it parses as an address). Names the
 *   classifier's kind so the abstention is legible. Presentational.
 */

import type { ReactNode } from "react"

export interface AbstainPanelProps {
	kind: string
}

export function AbstainPanel({ kind }: AbstainPanelProps): ReactNode {
	return (
		<p className="mw-muted">
			No POI intent detected — parses as an address (kind <code>{kind}</code>).
		</p>
	)
}
