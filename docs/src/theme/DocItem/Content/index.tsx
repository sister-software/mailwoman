/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Wraps `@theme-original/DocItem/Content` to mount the record-class chrome (docs-architecture
 *   cleanup, Phase 3) above every doc title, so a reader can tell a contract from an active
 *   decision from a historical record without the page author hand-editing banners:
 *
 *   - Docs rendered from the `archive` sidebar (see sidebars.ts) get an automatic "Historical
 *     record" banner, dated when a YYYY-MM-DD date is derivable from the doc id
 *     (`plan/2026-06-14-…`) or a `date:` frontmatter field.
 *   - Docs with a `status:` frontmatter field from the maintained vocabulary (`active-decision`,
 *     `superseded` — the content-model table in
 *     docs/superpowers/plans/2026-07-14-documentation-architecture-cleanup.md) render a status
 *     line; an optional `superseded-by:` field (a site-relative URL, e.g. `/docs/plan/SCOPE`)
 *     renders as a link when present. Free-text `status:` values (some dated eval reports carry
 *     them, and evals/retrospectives are a delegated workstream) deliberately render nothing.
 *
 *   Hand-written banners on individual pages (ARCHITECTURE.mdx, how-it-will-work.mdx, …) carry
 *   page specifics and stay in the page body; this chrome only marks the record class, stays a
 *   couple of lines tall, and inherits both color themes through Infima's `alert` classes.
 */

import Link from "@docusaurus/Link"
import { useDoc, useDocsSidebar } from "@docusaurus/plugin-content-docs/client"
import Content from "@theme-original/DocItem/Content"
import type { Props } from "@theme/DocItem/Content"
import clsx from "clsx"
import type { ReactNode } from "react"

import styles from "./styles.module.css"

const ISO_DATE_PATTERN = /(\d{4}-\d{2}-\d{2})/

/** Display labels for the `status:` frontmatter vocabulary. Unknown values render no chrome. */
const STATUS_LABELS: Record<string, string> = {
	"active-decision": "Active decision",
	superseded: "Superseded",
}

/** Taglines rendered after the status label. */
const STATUS_TAGLINES: Record<string, string> = {
	"active-decision": "An open design decision — current until a successor supersedes it.",
}

/**
 * The doc's display date: an explicit `date:` frontmatter field wins, else the dated-id filename convention
 * (`plan/2026-06-14-arbitration-layer-spec`).
 */
function useRecordDate(): string | undefined {
	const { metadata, frontMatter } = useDoc()
	// `DocFrontMatter` types only the Docusaurus-owned fields; the record-class fields are
	// site-specific pass-throughs, so they're read as `unknown` and narrowed.
	const explicit: unknown = (frontMatter as Record<string, unknown>).date

	// YAML parses an unquoted `date: 2026-06-14` into a Date object, a quoted one into a string.
	if (explicit instanceof Date) return explicit.toISOString().slice(0, 10)

	if (typeof explicit === "string" && ISO_DATE_PATTERN.test(explicit)) return explicit

	return ISO_DATE_PATTERN.exec(metadata.id)?.[1]
}

function DocRecordChrome(): ReactNode {
	const { frontMatter } = useDoc()
	const sidebar = useDocsSidebar()
	const date = useRecordDate()

	// Archive-sidebar docs are historical records by construction — no frontmatter required.
	if (sidebar?.name === "archive") {
		return (
			<aside className={clsx("alert", "alert--warning", styles.recordChrome)} role="note">
				<strong>Historical record{date ? ` · ${date}` : ""}.</strong> Preserved as written, not maintained. For the
				current state, see <Link to="/docs/plan/SCOPE">Current scope &amp; roadmap</Link>.
			</aside>
		)
	}

	const status: unknown = (frontMatter as Record<string, unknown>).status

	if (typeof status !== "string" || !(status in STATUS_LABELS)) return null

	const supersededBy: unknown = (frontMatter as Record<string, unknown>)["superseded-by"]
	const tagline = STATUS_TAGLINES[status]

	return (
		<aside className={clsx("alert", "alert--info", styles.recordChrome)} role="note">
			<strong>{STATUS_LABELS[status]}.</strong>
			{tagline ? <> {tagline}</> : null}
			{typeof supersededBy === "string" && supersededBy.length > 0 ? (
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
