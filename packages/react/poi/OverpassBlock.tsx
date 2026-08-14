/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `OverpassBlock` — the OverpassQL export panel: a header with a copy button and the query in a code
 *   block. Renders the emitter error instead when the export failed. Presentational.
 */

import type { ReactNode } from "react"

import { CopyButton } from "../common/CopyButton.tsx"

export interface OverpassBlockProps {
	overpassQL?: string
	overpassError?: string
}

export function OverpassBlock({ overpassQL, overpassError }: OverpassBlockProps): ReactNode {
	if (overpassQL) {
		return (
			<div className="mw-overpass">
				<div className="mw-panel__header">
					<h3>OverpassQL export</h3>
					<CopyButton value={overpassQL} className="mw-btn" />
				</div>
				<pre className="mw-overpass__code">
					<code>{overpassQL}</code>
				</pre>
			</div>
		)
	}

	if (overpassError) return <p className="mw-error">{overpassError}</p>

	return null
}
