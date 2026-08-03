/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Allowlists for `check-docs-structure.ts`. Every entry carries a reason — an allowance without
 *   one is a bug, not a policy. Adding an entry here is a reviewable act: prefer fixing the page,
 *   and allowlist only when the collision/orphan is deliberate or belongs to another workstream.
 *
 *   BOTH LISTS ARE EMPTY, and that is the intended steady state — the docs-reorg site has no
 *   orphans and no duplicate titles by construction. The three entries carried since 2026-08-03
 *   (docs-reorg Phase 0 task 2) were retired by tree surgery, not by allowance: Task 4 moved
 *   `evals/` and `retrospectives/` to `docs/records/`, taking both `Retrospectives`-titled landing
 *   pages and the `plan/migrate-v7-rules-excision` orphan out of `collectDocPages()`'s scan (it only
 *   ever walks `docs/articles`); Task 5's skeleton cutover moved `sotm-2026-talk-proposal.mdx` there
 *   too, so the un-navved conference proposal is no longer a published page needing an exemption.
 *   See task-2-report.md, task-4-report.md and task-5-report.md for the before/after evidence.
 *
 *   Adding an entry back is a reviewable act, and the gate guards against rot in the other
 *   direction as well: an allowance whose subject no longer exists is itself a failure.
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
export const allowedOrphans: OrphanAllowance[] = []
