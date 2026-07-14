/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Quarterly docs freshness sweep (docs-architecture cleanup, Phase 4): list maintained pages
 *   whose `review-by:` frontmatter date has passed, as a ready-to-file Markdown issue body on
 *   stdout. Empty output means nothing is due — the workflow
 *   (`.github/workflows/docs-freshness.yml`) files or updates ONE "Docs freshness sweep" issue
 *   only when there's a list to file.
 *
 *   Pages without `review-by:` are skipped by design: the field is the opt-in that marks a page as
 *   maintained. Dated evidence — eval reports, phase plans, retrospectives — never carries it, so
 *   the sweep can't churn archival records.
 *
 *   Run locally: `yarn workspace @mailwoman/docs freshness-report` (or
 *   `node docs/scripts/list-stale-docs.ts` from the repo root).
 */

import { collectDocPages } from "./docs-frontmatter.ts"

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/

interface StalePage {
	relativePath: string
	reviewBy: string
	owner: string | undefined
}

const today = new Date().toISOString().slice(0, 10)
const stalePages: StalePage[] = []

for (const page of await collectDocPages()) {
	const reviewBy = page.frontmatter.get("review-by")

	if (!reviewBy) continue // No `review-by:` = not a maintained page — skipped by design.

	const match = ISO_DATE_PATTERN.exec(reviewBy)

	if (!match) {
		console.error(`warning: ${page.relativePath} has a non-ISO review-by value (\`${reviewBy}\`) — skipping`)
		continue
	}

	const reviewDate = match[0]

	// ISO dates compare correctly as strings.
	if (reviewDate <= today) {
		stalePages.push({
			relativePath: page.relativePath,
			reviewBy: reviewDate,
			owner: page.frontmatter.get("owner") ?? page.frontmatter.get("source-of-truth"),
		})
	}
}

if (stalePages.length > 0) {
	console.log(`${stalePages.length} page(s) are past their \`review-by:\` date as of ${today}.`)
	console.log(
		`For each: re-verify the page against its source of truth, refresh what drifted, then bump \`review-by:\` a quarter out (or retire the page — see [Contributing to the docs](https://mailwoman.sister.software/docs/contributing-docs)).\n`
	)

	for (const page of stalePages) {
		const ownerNote = page.owner ? ` (source of truth: ${page.owner})` : ""
		console.log(`- [ ] \`docs/articles/${page.relativePath}\` — review-by ${page.reviewBy}${ownerNote}`)
	}

	console.log(`\n_Filed by the quarterly docs-freshness workflow. Updating this issue in place is expected._`)
}
