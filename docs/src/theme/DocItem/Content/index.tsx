/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Wraps `@theme-original/DocItem/Content` to mount the record-class chrome (docs-architecture
 *   cleanup, Phase 3) above every doc title, so a reader can tell an active decision from a
 *   superseded one without the page author hand-editing a banner.
 *
 *   Docs with a `status:` frontmatter field from the maintained vocabulary (`active-decision`,
 *   `superseded`) render a status line; an optional `superseded-by:` field (a site-relative URL, or
 *   an external URL such as a GitHub blob link for a page that has left the published tree) renders
 *   as a link when present. Free-text `status:` values deliberately render nothing.
 *
 *   The second branch this file used to carry — an automatic "Historical record" banner for docs in
 *   the `archive` sidebar, dated from the doc id or a `date:` field — went with the sidebar. The
 *   docs-reorg Task 4 tree surgery moved every archived page to `docs/records/`, which is outside
 *   the Docusaurus content root, so no published doc can be in an `archive` sidebar any more and
 *   the branch was unreachable. Task 5 removed it along with the date derivation it was the only
 *   caller of. Bring both back from git history if a published archive door ever returns.
 */

import Link from "@docusaurus/Link"
import { useDoc } from "@docusaurus/plugin-content-docs/client"
import Content from "@theme-original/DocItem/Content"
import type { Props } from "@theme/DocItem/Content"
import clsx from "clsx"
import type { ReactNode } from "react"

import styles from "./styles.module.css"

/**
 * Display labels for the `status:` frontmatter vocabulary. Unknown values render no chrome.
 */
const STATUS_LABELS: Record<string, string> = {
	"active-decision": "Active decision",
	superseded: "Superseded",
}

/**
 * Taglines rendered after the status label.
 */
const STATUS_TAGLINES: Record<string, string> = {
	"active-decision": "An open design decision — current until a successor supersedes it.",
}

function DocRecordChrome(): ReactNode {
	const { frontMatter } = useDoc()
	// `DocFrontMatter` types only the Docusaurus-owned fields; the record-class fields are
	// site-specific pass-throughs, so they're read as `unknown` and narrowed.
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
