/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `SubjectPanel` — renders the detected POI subject. For a CATEGORY: the category chip, the optional
 *   build-local badge + note. For a BRAND: the brand-name chip + a Wikidata QID chip (linked). Both
 *   share the match-detail list (matched phrase, confidence, anchor). Presentational.
 */

import type { ReactNode } from "react"

import type { POISubject } from "./types.ts"

export interface SubjectPanelProps {
	subject: POISubject
}

/** The shared match-detail list (matched phrase, confidence, anchor) — identical for category + brand subjects. */
function MatchDetail({ subject }: SubjectPanelProps): ReactNode {
	return (
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
	)
}

export function SubjectPanel({ subject }: SubjectPanelProps): ReactNode {
	if (subject.kind === "brand") {
		return (
			<>
				<div className="mw-subject__row">
					<span className="mw-subject__chip">{subject.name}</span>
					<span className="mw-subject__badge mw-subject__badge--brand">brand</span>
					{subject.wikidata ? (
						<a
							className="mw-subject__qid"
							href={`https://www.wikidata.org/wiki/${subject.wikidata}`}
							target="_blank"
							rel="noreferrer"
						>
							{subject.wikidata}
						</a>
					) : null}
				</div>

				<MatchDetail subject={subject} />

				<p className="mw-subject__note">
					Matched as a chain brand — resolved by Wikidata QID against the layer's brand index.
				</p>
			</>
		)
	}

	return (
		<>
			<div className="mw-subject__row">
				<span className="mw-subject__chip">{subject.category.label}</span>
				{subject.buildLocal ? <span className="mw-subject__badge">build-local</span> : null}
			</div>

			<MatchDetail subject={subject} />

			{subject.buildLocal ? (
				<p className="mw-subject__note">
					Requires the locally-built OSM layer (ODbL) — mailwoman ships the builder, not the data.
				</p>
			) : null}
		</>
	)
}
