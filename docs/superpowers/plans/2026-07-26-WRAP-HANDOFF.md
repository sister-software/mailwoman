# Wrap handoff — close out the FST / comma-free / #1143 arc (2026-07-26)

**For:** DeepSeek (fresh context, executing lead) · **From:** the coordinating lead (Claude) · **Repo:** mailwoman @ `main`
(`426379e4` or later). **About 90% of the arc is done and merged.** This doc covers the remaining
wrap-up and is not a build brief. Read the prior session's report first:
`docs/superpowers/plans/2026-07-25-SESSION-REPORT-fst-arcs.md`. Its verdicts were checked against
main and the ledger and are accurate. The full dated record is `.superpowers/sdd/progress.md`
(pre-registrations #1–#6). The two earlier handoffs (`2026-07-25-LEAD-HANDOFF.md`,
`STALE_FST_HANDOFF.md`) are historical. They were executed, so do not repeat them.

> **Spec-clarity review (DeepSeek pro, 2026-07-26).** A model without repo access reviewed this work
> order adversarially as a spec-clarity test. After repo facts were resolved, the verdict was
> **Tasks 1–3 GREEN**: they can be executed without a human judgment call, and the repo contains all
> the information they need. **Task 4 was the one real gap.** "Reconcile" was too vague and risked
> the executor guessing at roadmap status, so it has been rewritten as an explicit per-item edit list
> (below). The review also led to pinning the Task-1 FST source path and the Task-3 fixture location.
> The spec is now clear enough for an executor with repo access but no other context to finish on
> its own.

---

## Where the arc landed (settled — do not re-open)

- **Comma-free "street + trailing city" cannot be fixed in decode.** This was established with
  evidence. Fork B (trailing-locality prior) passed a curated 33-row board and then went
  net-negative on a 400-row held-out BAN population. No decode-time geometry separates a trailing
  city from a person-name street surname (`Avenue Marceau Julien` ≡ `Rue des Lyonnais Paris`). This
  is the same open-vocabulary limit as #1287/#1288. The fix belongs in training (**#1102**). Do not
  attempt another decode mechanism for it.
- **Shipped and merged, all on unchanged model bytes v385:** #1315 street-context check (inert by
  default). #1317 trailing-locality prior (**opt-in only**: `classifier.ts` imports it, and the
  runtime pipeline never does). #1318 per-locale FST distribution (**default-on**, with the check
  wired at both classify sites and the morphology emission prior zeroed).
- **The fragment board rejected the 768k importance FST reship.** It showed homonym −13 to −28 and
  an "Avenue Montaigne"→`locality:"Avenue"` hazard. The 220k FST stays shipped. The rejected build
  is staged, unshipped, at `$MAILWOMAN_DATA_ROOT/scratch-importance/`. Do not revisit it without a
  new fragment-board improvement.
- **#1143** was re-measured at **0.605 (v385) / 0.777 (v3101)**, and training is closing the gap.
  The roadmap's 0.215 was stale.

---

## Working discipline (still non-negotiable — every one earned with a receipt)

1. **Verify before reaching a verdict.** A report, including this one, can be wrong about a number
   you rely on. Re-run it on the live CLI (`node mailwoman/out/cli.js parse --neural "<input>"`)
   before acting.
2. **Measure in the shipped configuration.** The v3101 cache differs from shipped v385 (bare-street
   0.777 vs 0.605). Board percentages from a candidate cache are candidate numbers. Pin to
   production defaults. When a rerun on an identical artifact disagrees, suspect the cache.
3. **Pre-register bars in writing before measuring** (`.superpowers/sdd/progress.md`, dated). Do not
   tune knobs inside a pre-registration, and do not drop failing rows. A bar revision must be dated,
   ratified by the operator, and carry a retirement condition.
4. **Preserve the operator's uncommitted work across every pull.**
   `corpus-python/modal/train_remote.py` (`sync_latam_br`/`sync_gb`) and
   `corpus-python/src/mailwoman_train/configs/v3.10.0-gb-probe.yaml` are uncommitted and belong to
   the operator. Run `git stash push` on those paths, pull, run `git stash pop`, and verify that
   `grep -c "def sync_latam_br" corpus-python/modal/train_remote.py` returns 1. Never commit them,
   and never run a pathless `git checkout -- .`.
5. **Release and PR mechanics.** Make every change through a PR, branched from `origin/main`.
   Releases go through the two-phase PR flow only (`mailwoman-release` skill / `RELEASING.md`).
   Never run `yarn release` locally.

---

## The remaining wrap-up (ordered by risk)

### 1. ⚠ RELEASE-STAGING GAP for `fst-<locale>.bin` — the next release breaks without this (do first)

#1318 added `fst-en-us.bin` / `fst-fr-fr.bin` / `fst-en-gb.bin` to the `files[]` arrays of the three
weights packages. The release **staging path was left for follow-up**, and it does not materialize
those files yet:

- **`scripts/copy-weights.ts`** materializes `model.onnx`, `postcode-*.bin`, `anchor-lexicon` and
  the pair index, but it has **no case for `fst-<locale>.bin`**. At release time (its `before:init`
  hook), the workspace will hold only the dev symlink from `link-dev-weights.ts`, or no file.
  `yarn pack` rejects a symlink in the tarball (HTTP 415), and the files guard in
  `publish-workspace.ts` refuses to publish a missing `files[]` target. **In either case the next
  release fails or ships a broken package.** The postcode-de.bin outage had the same cause.
- **The `mailwoman-release` skill and `publish-hf.ts`** know only the single legacy
  `fst-en-US.bin` (uppercase, en-us, reused from the prior release). They do not stage the new
  per-locale lowercase FSTs to HF.

**Task:** teach `copy-weights.ts` to materialize `fst-<locale>.bin` per workspace with
unlink-then-copy, as it already does for the postcode binaries. The AGENTS.md pitfall "symlinks in
the publish tarball" explains why. Update Step 2 of the `mailwoman-release` skill and
`publish-hf.ts` to stage all three per-locale FSTs to HF at the next release. **Verify** with a
`yarn pack -o /tmp` dry run per workspace that the tarball contains a real `fst-<locale>.bin` (not a
symlink) and that the files guard passes.

**Source path (pinned):** `$MAILWOMAN_DATA_ROOT/db/wof/fst-per-locale/fst-<locale>.bin`.
`neural-weights-en-us/scripts/link-dev-weights.ts:211` already resolves this path
(`dataRootPath("wof", "fst-per-locale", "fst-en-us.bin")`) to create the dev symlink. **Use
link-dev-weights.ts as the reference implementation.** copy-weights.ts must materialize from the
same source, using unlink-then-copy instead of a symlink. `copy-weights.ts` has zero `fst`
references today, and `link-dev-weights.ts` handles all three locales. The blobs are the 2026-05-28
220k-importance per-locale build (en-us 22MB, fr-fr 10.7MB, en-gb 3.9MB). en-nz has none, so its
package stays byte-stable. This is the one item that can cause an outage, so land it before any
release is published.

### 2. Make the #1318 default-on retirement obligation DURABLE (don't leave it in the ledger)

#1318 shipped default-on behind a dated, operator-ratified bar revision. The v3101 candidate
measured homonym **+13**, and the next promotion is expected to flip the sign. That measurement
justifies the **−6.8pp FR admin-street-homonym** cost on v385. The obligation is recorded only in
`progress.md` line 274, so **it will be missed at the next promotion unless an issue tracks it.**

**Task:** file a GitHub issue titled "Re-run the #1318 FST default-on battery at the next model
promotion — retire or renew the homonym bar revision". Link the ledger entry and the exact battery
(pre-registration #6). If the homonym result turns positive as predicted, the revision is retired.
If it does not, the project has shipped a durable regression and must decide whether to test the
prior harder or revert default-on. This obligation is required.

### 3. ~~Formalize the #1143 waive~~ — ✅ DONE (Claude, 2026-07-26)

The operator delegated the decision ("most long-term accurate parsing rather than a pile of hacks").
#1143 was **waived to training without a decode patch**, and GitHub **#1143 is closed as
not-planned** (https://github.com/sister-software/mailwoman/issues/1143). The disposition comment
gives the re-measured 0.605/0.777, the reason decode cannot fix it, and what #1315 covered. The
stale 0.215 was removed from the title. **#1102 is cross-linked** and carries the residual
bare-street class and the `ban-fragments-fr` board as a training target. The fixture already
existed, so no new fixture was written.

**The only remaining step for the executor:** update `MAILWOMAN_ROAD_TO_V8.md` line ~209 (the
Track-F check) to mark #1143's "waived with named owner + board" condition as satisfied. This is
part of Task 4. §3-F already has the new number, with 0.215 marked stale. The 37-row token-grab
class belongs to the check (live via #1318). The 51-row whole-span class belongs to training
(#1102).

### 4. Reconcile the docs to the resolved state

**Task:** make exactly these edits to `MAILWOMAN_ROAD_TO_V8.md` and no others.

- Mark **#1315 street-context check**, **#1317 trailing-locality prior (opt-in)**, and **#1318
  per-locale FST distribution (default-on)** as complete.
- Remove or close any "future" or "open" entry that treats **decode-time gazetteer** or
  **comma-free trailing-locality** work as a pending build. Decode cannot fix it, and the work
  belongs to training (#1102).
- Make **§3-F read 0.605** instead of 0.215.
- Record the **#1318 default-on bar revision** as tracked by the issue from Task 2, with its
  next-promotion retirement condition.
- **Make no other changes.** Do not restructure or change the status of unrelated roadmap items. If
  something outside the #1315/#1317/#1318 arc looks stale, report it to the operator instead of
  editing it.

---

## Parked on the OPERATOR (awareness only — not yours to decide or force)

- The v8 release decisions: the Track A breaking-batch green light, the Track B overlay rebuild, and
  the demo repoint (strictly after the release). Mention them when relevant, but do not act on them.
- Re-verify the trailing-locality W1 cell **if the model changes** (in the future, tied to a
  promotion).

## Pointers

- `docs/superpowers/plans/2026-07-25-SESSION-REPORT-fst-arcs.md` is the predecessor's report. Start
  here.
- `.superpowers/sdd/progress.md` is the dated ledger, with the pre-registrations, batteries, and the
  bar revision at line 274.
- `scripts/copy-weights.ts`, `mailwoman/release-tools/publish-hf.ts` and
  `.claude/skills/mailwoman-release/` are the release-staging files for task 1.
- The mechanism files are `neural/fst-prior.ts` (check and emission prior),
  `neural/trailing-locality-prior.ts` (opt-in), and `core/pipeline/runtime-pipeline.ts`
  (default-on wiring, emission zeroed).
