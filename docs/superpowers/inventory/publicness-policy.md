# Archive/publicness policy — draft for agreement

_Phase 0 deliverable of the documentation-architecture cleanup. Status: **draft — needs operator sign-off** before any page moves. Once agreed, Phase 4 promotes this into the contributor-facing documentation policy._

## Principles

1. **Reorganization never changes publicness.** Moving a page into the Archive section changes its navigation, not its visibility. Nothing currently excluded from the build becomes public — and nothing currently public gets unpublished — as a side effect of the cleanup. Every publicness change is its own explicit decision, recorded in the inventory.
2. **Existing exclusions stand.** `reviews/**`, eval postmortems, and night-shift session reports stay excluded (`docs/docusaurus.config.ts`). They are internal working records, excluded deliberately.
3. **Dated records stay published and permalink-stable.** Anything already public under `plan/phases/`, `evals/`, or the `research/` blog keeps its URL and its point-in-time content. Archive pages are visibly dated and out of the default reader path, but searchable.
4. **Promotion (excluded → public) requires all of:** no internal references (private repos, funding, unreleased work, third-party names in unflattering contexts); no security-sensitive detail; evidentiary value — a maintained page wants to cite it. Operator signs off per page.
5. **Demotion (public → excluded) is for mistakes, not age.** A page leaves the public site only if it should never have been public. Age alone is an Archive matter, never a deletion or exclusion matter (plan non-goal).
6. **Delegated sections decide within this frame.** The evals/retrospectives workstream expresses its publicness recommendations against these principles; conflicts surface to the operator rather than being resolved unilaterally.

## What this unblocks

With this agreed, Phase 1+ can move pages between navigation sections freely, because the moves are publicness-neutral by construction. The only decisions that ever come back to the operator are per-page promotions/demotions, which the inventory lists explicitly under `action` notes.
