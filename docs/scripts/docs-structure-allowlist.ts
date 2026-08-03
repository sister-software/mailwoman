/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Allowlists for `check-docs-structure.ts`. Every entry carries a reason — an allowance without
 *   one is a bug, not a policy. Adding an entry here is a reviewable act: prefer fixing the page,
 *   and allowlist only when the collision/orphan is deliberate or belongs to another workstream.
 *
 *   Two of the three entries carried since 2026-08-03 (docs-reorg Phase 0 task 2) were resolved by
 *   Task 4's tree surgery: `evals/` and `retrospectives/` moved to `docs/records/`, taking both
 *   `Retrospectives`-titled landing pages and the `plan/migrate-v7-rules-excision` orphan out of
 *   `collectDocPages()`'s scan (it only ever walks `docs/articles`). `sotm-2026-talk-proposal` stays
 *   — it's still published at `docs/articles/sotm-2026-talk-proposal.mdx`, deliberately un-navved
 *   (Task 5 is expected to resolve or re-confirm it when the site skeleton is rebuilt). See
 *   task-2-report.md and task-4-report.md for the before/after evidence.
 */

/**
 * A known-intentional exact `title:` collision.
 */
export interface DuplicateTitleAllowance {
	title: string
	reason: string
}

/**
 * A page deliberately reachable by URL but absent from every sidebar.
 */
export interface OrphanAllowance {
	/**
	 * The Docusaurus doc id (see `DocPage.id`).
	 */
	id: string
	reason: string
}

/**
 * Titles allowed to appear on more than one page. Each entry needs a reason — the check exists to catch accidental
 * duplicates, and an unexplained allowance defeats it.
 */
export const allowedDuplicateTitles: DuplicateTitleAllowance[] = []

/**
 * Pages allowed to sit outside the sidebar tree, e.g. ones reached only by direct link.
 */
export const allowedOrphans: OrphanAllowance[] = [
	{
		id: "sotm-2026-talk-proposal",
		reason:
			"Deliberately un-navved conference proposal — shared by URL, kept out of every sidebar on purpose (named as such in sidebars.ts's startHere comment).",
	},
]
