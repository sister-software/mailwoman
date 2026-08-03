/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Allowlists for `check-docs-structure.ts`. Every entry carries a reason — an allowance without
 *   one is a bug, not a policy. Adding an entry here is a reviewable act: prefer fixing the page,
 *   and allowlist only when the collision/orphan is deliberate or belongs to another workstream.
 *
 *   NOT emptied on 2026-08-03 (docs-reorg Phase 0 task 2), despite that task's brief calling for it:
 *   all three entries below still reference pages that are PRESENT in the current tree, so emptying
 *   this file turns `check-docs-structure.ts` red in legacy (no-flag) mode against the tree as it
 *   stands today — `duplicate title \`Retrospectives\`` plus two orphans. Per
 *   `docs/superpowers/plans/2026-08-03-docs-reorg.md`, Task 4 moves `evals/` and `retrospectives/`
 *   out of `docs/articles/` (resolving the duplicate title and one orphan by taking both pages out of
 *   `collectDocPages()`'s scan) and Task 5 moves the remaining old tree — including
 *   `plan/migrate-v7-rules-excision.md` and `sotm-2026-talk-proposal.mdx` — under `docs/records/`
 *   (resolving the second orphan the same way). Empty this file once one of those tasks lands; see
 *   task-2-report.md for the full evidence (both check-docs-structure.ts invocations, before/after).
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
export const allowedDuplicateTitles: DuplicateTitleAllowance[] = [
	{
		title: "Retrospectives",
		reason:
			"evals/retrospectives/index.mdx and retrospectives/README.mdx — the landing pages of two sections owned by the delegated evals/retrospectives workstream (baseline inventory §4). Resolving the collision is theirs; this gate only keeps it from growing.",
	},
]

/**
 * Pages allowed to sit outside the sidebar tree, e.g. ones reached only by direct link.
 */
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
