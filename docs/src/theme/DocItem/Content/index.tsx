/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Adds a status notice above each document title, so readers can tell current decisions from
 *   superseded ones without authors adding banners by hand.
 *
 *   Documents with `status: active-decision` or `status: superseded` show a notice. If
 *   `superseded-by` is set, the notice links to that URL. Other status values show no notice.
 *
 *   The old historical-record banner was removed when archived pages moved outside the published
 *   docs tree. Restore it only if archived pages are published again.
 */

import Link from "@docusaurus/Link"
import { useDoc } from "@docusaurus/plugin-content-docs/client"
import Content from "@theme-original/DocItem/Content"
import type { Props } from "@theme/DocItem/Content"
import clsx from "clsx"
import type { ReactNode } from "react"

import styles from "./styles.module.css"

/**
 * Labels for recognized document statuses.
 * Other values are ignored.
 */
const STATUS_LABELS: Record<string, string> = {
	"active-decision": "Active decision",
	superseded: "Superseded",
}

/**
 * Extra text shown after a status label.
 */
const STATUS_TAGLINES: Record<string, string> = {
	"active-decision": "An open design decision — current until a successor supersedes it.",
}

function DocRecordChrome(): ReactNode {
	const { frontMatter } = useDoc()
	// `DocFrontMatter` types only the Docusaurus-owned fields.
	// The record-class fields are site-specific pass-throughs, so they're read as `unknown` and narrowed.
	const status: unknown = (frontMatter as Record<string, unknown>).status

	if (typeof status !== "string" || !(status in STATUS_LABELS)) return null

	const supersededBy: unknown = (frontMatter as Record<string, unknown>)["superseded-by"]
	const tagline = STATUS_TAGLINES[status]

	return (
		<aside className={clsx("alert", "alert--info", styles.recordChrome)} role="note">
			<strong>{STATUS_LABELS[status]}.</strong>
			{tagline ? <> {tagline}</> : null}
			{typeof supersededBy === "string" && supersededBy.length ? (
				<>
					{" "}
					Superseded by <Link to={supersededBy}>{supersededBy}</Link>.
				</>
			) : null}
		</aside>
	)
}

export default function ContentWrapper(props: Props): ReactNode {
	return (
		<>
			<DocRecordChrome />
			<Content {...props} />
		</>
	)
}
