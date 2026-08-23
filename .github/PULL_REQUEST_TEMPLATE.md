<!-- Lead with the result: what changed and the observed effect. No greetings. -->

Closes #<issue>.

## Summary

One factual paragraph: the change, the observed result, and the tradeoff. No
judgment word stands where a fact belongs
([`.claude/output-styles/mailwoman-development.md`](../.claude/output-styles/mailwoman-development.md)).

## Evidence

- The measured quantity with its denominator, threshold, artifact, and comparison arm.
- The addresses that changed, named. Link the full failure list when the board is large.
- The tool or command that produced each number.

## Why chain

When the PR fixes a defect: the compressed chain, or "cause direct: <one line>".
Delete this section when the change is not a fix.

## Completion assertions

- [ ] A test fails without this change (revert the fix and confirm, when the PR is a fix).
- [ ] CI green — `yarn ci:test` passes.
- [ ] D-rule: no known regression on any tier-1 locale vs shipped, or stated with its per-locale gate
      (`docs/engineering/CONTRIBUTING_MODEL_WORK.mdx`).
- [ ] The linked issue's task list is fully checked.
- [ ] Every number in this description has its denominator; every WOF id has its entity name.

## Docs pages touched? Confirm each line — delete this section if the PR doesn't touch docs/articles

- [ ] The reader question this serves is named above — and no canonical page already owns it ([docs policy](https://github.com/sister-software/mailwoman/blob/main/docs/records/site-2026-08/contributing-docs.mdx)).
- [ ] Canonical pages were updated in place; any new page answers a distinct reader question.
- [ ] Factual claims name their source: a code path, a schema, an eval report — not recollection.
- [ ] Captured outputs were executed, not hand-typed; release-bound numbers cite the shipped npm model.
- [ ] Frontmatter matches the policy: `role:` where required, `status:`/`superseded-by:` on retired pages, `review-by:` considered for concept pages.
