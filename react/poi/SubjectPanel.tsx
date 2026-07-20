/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `SubjectPanel` — renders the detected POI subject: the category chip, the optional build-local
 *   badge + note, and the match-detail list (matched phrase, confidence, anchor). Presentational.
 */

import type { ReactNode } from "react"

import type { POISubject } from "./types.ts"

export interface SubjectPanelProps {
	subject: POISubject
}

export function SubjectPanel({ subject }: SubjectPanelProps): ReactNode {
	return (
		<>
			<div className="mw-subject__row">
				<span className="mw-subject__chip">{subject.category.label}</span>
				{subject.buildLocal ? <span className="mw-subject__badge">build-local</span> : null}
			</div>

			<dl className="mw-subject__detail">
				<dt>matched phrase</dt>
				<dd>
					<code>{subject.matchedPhrase}</code>
				</dd>
				<dt>confidence</dt>
				<dd>{Math.round(subject.confidence * 100)}%</dd>
				<dt>anchor</dt>
				<dd>{subject.remainder ? subject.remainder : <em>none — global query</em>}</dd>
			</dl>

			{subject.buildLocal ? (
				<p className="mw-subject__note">
					Requires the locally-built OSM layer (ODbL) — mailwoman ships the builder, not the data.
				</p>
			) : null}
		</>
	)
}
