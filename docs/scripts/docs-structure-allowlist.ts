/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Allowlists for `check-docs-structure.ts`. Every entry carries a reason — an allowance without
 *   one is a bug, not a policy. Adding an entry here is a reviewable act: prefer fixing the page,
 *   and allowlist only when the collision/orphan is deliberate or belongs to another workstream.
 */

/** A known-intentional exact `title:` collision. */
export interface DuplicateTitleAllowance {
	title: string
	reason: string
}

/** A page deliberately reachable by URL but absent from every sidebar. */
export interface OrphanAllowance {
	/** The Docusaurus doc id (see `DocPage.id`). */
	id: string
	reason: string
}

export const allowedDuplicateTitles: DuplicateTitleAllowance[] = [
	{
		title: "Retrospectives",
		reason:
			"evals/retrospectives/index.mdx and retrospectives/README.mdx — the landing pages of two sections owned by the delegated evals/retrospectives workstream (baseline inventory §4). Resolving the collision is theirs; this gate only keeps it from growing.",
	},
]

export const allowedOrphans: OrphanAllowance[] = [
	{
		id: "sotm-2026-talk-proposal",
		reason:
			"Deliberately un-navved conference proposal — shared by URL, kept out of every sidebar on purpose (named as such in sidebars.ts's startHere comment).",
	},
	{
		id: "plan/migrate-v7-rules-excision",
		reason:
			"v7.0.0 rules-parser migration guide — reachable by URL (linked from the v7.0.0 releases row) and kept out of the sidebar on purpose: it's a point-in-time upgrade note for consumers pinned to @6.x, not evergreen navigation.",
	},
]
