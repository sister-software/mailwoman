# Wrap handoff — close out the FST / comma-free / #1143 arc (2026-07-26)

**For:** Kimi (fresh context) · **From:** the coordinating lead (Claude) · **Repo:** mailwoman @ `main`
(`426379e4` or later). **The arc is ~90% done and merged** — this doc is the remaining wrap-up, not a
build brief. Read the prior session's own report first:
`docs/superpowers/plans/2026-07-25-SESSION-REPORT-fst-arcs.md` (your predecessor's verdicts, verified
accurate against main + the ledger). The full dated record is `.superpowers/sdd/progress.md`
(pre-registrations #1–#6). The two earlier handoffs (`2026-07-25-LEAD-HANDOFF.md`,
`STALE_FST_HANDOFF.md`) are now HISTORICAL — they were executed; don't re-do them.

> **Spec-clarity review (DeepSeek pro, 2026-07-26).** This work order was adversarially reviewed by a
> repo-blind model as a spec-clarity test. Verdict after resolving repo facts: **Tasks 1–3 GREEN**
> (autonomously executable — no human judgment call, no information missing from the repo). **Task 4
> was the one genuine gap** — "reconcile" was too vague and risked the executor guessing at roadmap
> status; it has since been rewritten as an explicit per-item edit list (below). The Task-1 FST source
> path and the Task-3 fixture location were also pinned as a result of the review. Net: the spec is
> clear enough for a myopic-but-repo-equipped executor to finish autonomously, with Task 4 now closed.

---

## Where the arc landed (settled — do not re-open)

- **Comma-free "street + trailing city" is a DECODE DEAD END** — confirmed with receipts, not
  abandoned. Fork B (trailing-locality prior) passed a curated 33-row board then went net-negative on
  400-row held-out BAN population: no decode geometry separates a trailing city from a person-name
  street surname (`Avenue Marceau Julien` ≡ `Rue des Lyonnais Paris`). Same open-vocab wall as
  #1287/#1288. The real fix is training (**#1102**). Do not attempt another decode mechanism for it.
- **Shipped, merged, all on unchanged model bytes v385:** #1315 street-context gate (inert-by-default),
  #1317 trailing-locality prior (**opt-in only** — imported by `classifier.ts`, never the runtime
  pipeline), #1318 per-locale FST distribution (**default-on**, gate wired at both classify sites with
  the morphology EMISSION prior zeroed).
- **768k importance FST reship: REJECTED** by the fragment board (homonym −13 to −28 + an
  "Avenue Montaigne"→`locality:"Avenue"` hazard). The 220k FST stays shipped. Staged-but-unshipped at
  `/mnt/playpen/mailwoman-data/scratch-importance/`. Settled — don't revisit without a new fragment win.
- **#1143** re-anchored **0.605 (v385) / 0.777 (v3101)** — training is closing it; the roadmap's 0.215
  was stale.

---

## Working discipline (still non-negotiable — every one earned with a receipt)

1. **Verify before verdict.** A report (even this one) is not truth for a load-bearing number — re-run
   it on the live CLI (`node mailwoman/out/cli.js parse --neural "<input>"`) before acting.
2. **Measure in the SHIPPED configuration.** v3101-cache ≠ shipped v385 (bare-street 0.777 vs 0.605).
   Board percentages from a candidate cache are candidate numbers. Pin to production defaults; when an
   identical-artifact rerun disagrees, suspect the cache.
3. **Pre-register bars in writing before measuring** (`.superpowers/sdd/progress.md`, dated). No knob
   iteration inside a pre-registration; no dropped failing rows. A bar revision is dated,
   operator-ratified, and carries a retirement condition — never silent.
4. **Preserve the operator's WIP across every pull.** `corpus-python/modal/train_remote.py`
   (`sync_latam_br`/`sync_gb`) + `corpus-python/src/mailwoman_train/configs/v3.10.0-gb-probe.yaml` are
   UNCOMMITTED and the OPERATOR'S. `git stash push` those paths → pull → `git stash pop` → verify
   `grep -c "def sync_latam_br" corpus-python/modal/train_remote.py` == 1. Never commit them; never
   pathless `git checkout -- .`.
5. **Release + PR mechanics.** PR everything; branch from `origin/main`. Releases go through the
   two-phase PR flow ONLY (`mailwoman-release` skill / `RELEASING.md`), never local `yarn release`.

---

## The remaining wrap-up (ordered by risk)

### 1. ⚠ RELEASE-STAGING GAP for `fst-<locale>.bin` — the next release breaks without this (do first)

#1318 added `fst-en-us.bin` / `fst-fr-fr.bin` / `fst-en-gb.bin` to the `files[]` arrays of the three
weights packages, but the release **staging path was left for follow-up** and currently does NOT
materialize them:

- **`scripts/copy-weights.ts`** materializes `model.onnx`, `postcode-*.bin`, `anchor-lexicon`,
  pair-index — but has **no case for `fst-<locale>.bin`**. At release (its `before:init` hook), the
  workspace will carry only the dev SYMLINK (from `link-dev-weights.ts`) or nothing. `yarn pack`
  rejects a symlink in the tarball (HTTP 415), and `publish-workspace.ts`'s files-guard refuses to
  publish a `files[]` target that's missing. **Either way the next release fails or ships a broken
  package** — the same class as the postcode-de.bin outage.
- **The `mailwoman-release` skill + `publish-hf.ts`** only know the single legacy `fst-en-US.bin`
  (uppercase, en-us, reused from the prior release). They don't stage the new per-locale lowercase
  FSTs to HF.

**Task:** teach `copy-weights.ts` to materialize `fst-<locale>.bin` per workspace (unlink-then-copy,
mirroring the postcode-binary handling — the AGENTS.md "symlinks in the publish tarball" pitfall is
the reason). Update the `mailwoman-release` skill's Step 2 + `publish-hf.ts` to stage all three
per-locale FSTs to HF at the next release. **Verify** with a `yarn pack -o /tmp` dry-run per workspace
that the tarball contains a REAL `fst-<locale>.bin` (no symlink) and the files-guard passes.

**Source path (pinned):** `$MAILWOMAN_DATA_ROOT/wof/fst-per-locale/fst-<locale>.bin` — this is exactly
what `neural-weights-en-us/scripts/link-dev-weights.ts:211` already resolves
(`dataRootPath("wof", "fst-per-locale", "fst-en-us.bin")`) to create the dev symlink. **link-dev-weights.ts
is your reference implementation** — copy-weights.ts must materialize from the SAME source, just with
unlink-then-copy instead of symlink. (Confirmed: `copy-weights.ts` has zero `fst` references today;
`link-dev-weights.ts` handles all three locales.) Blobs are the 2026-05-28 220k-importance per-locale
build (en-us 22MB / fr-fr 10.7MB / en-gb 3.9MB); en-nz has none → byte-stable. This is the one item
that can cause an outage; land it before any release is cut.

### 2. Make the #1318 default-on retirement obligation DURABLE (don't leave it in the ledger)

#1318 shipped default-on behind a dated, operator-ratified bar revision: the **−6.8pp FR
admin-street-homonym** cost on v385 is justified by the v3101 candidate measuring homonym **+13** (next
promotion expected to flip the sign). Right now that obligation lives only in `progress.md` line 274 —
**it will be missed at the next promotion if it isn't tracked.**

**Task:** file a GitHub issue "Re-run the #1318 FST default-on battery at the next model promotion —
retire or renew the homonym bar revision", linking the ledger entry and the exact battery
(pre-registration #6). If the homonym flips positive as predicted, the revision retires; if it doesn't,
we've shipped a durable regression and must decide whether to gate the prior harder or revert
default-on. This is a standing obligation, not optional.

### 3. Formalize the #1143 waive (owner + board + issue state)

Disposition agreed (predecessor + coordinator concur): **waive-with-owner+board.** Owner = the #1102
training campaign (verifiably closing the gap 0.605→0.777). Board = the bare-street class of
`ban-fragments-fr`, re-scored per candidate.

**Task:** the board **already exists** as a committed fixture —
`mailwoman/eval-harness/fixtures/ban-fragments-fr.surfaces.txt` + `.jsonl` — so nothing needs
authoring. Confirm that fixture is the re-scoring board, then update GitHub #1143 with the waive
rationale, the owner, the re-anchored numbers, and the retest board; set it to the correct state
(waived/deferred, linked to #1102). Correct the roadmap §3-F 0.215→0.605 if the predecessor didn't
already (the report says it did — verify). The 37-row token-grab class is the gate's and is live via
#1318; the 51-row whole-span class is training's.

### 4. Reconcile the docs to the resolved state

**Task (explicit — do exactly these edits to `MAILWOMAN_ROAD_TO_V8.md`, nothing open-ended):**

- Mark **#1315 street-context gate**, **#1317 trailing-locality prior (opt-in)**, and **#1318 per-locale
  FST distribution (default-on)** as COMPLETE.
- Remove/close any "future" or "open" entry that frames **decode-time gazetteer** or **comma-free
  trailing-locality** as a pending BUILD — it is a settled decode dead-end (training-side via #1102).
- Ensure **§3-F reads 0.605** (not 0.215).
- Note the **#1318 default-on bar revision** as tracked (the issue from Task 2) with its next-promotion
  retirement condition.
- **Otherwise no changes.** Do not restructure or re-status unrelated roadmap items — if something
  outside the #1315/#1317/#1318 arc looks stale, surface it to the operator rather than editing it.

---

## Parked on the OPERATOR (awareness only — not yours to decide or force)

- v8 cut go-aheads: Track A breaking-batch green-light, Track B overlay re-cut, demo repoint (strictly
  post-cut). Surface them if relevant; don't action them.
- Trailing-locality W1 cell re-verify **if the model changes** (future, tied to a promotion).

## Pointers

- `docs/superpowers/plans/2026-07-25-SESSION-REPORT-fst-arcs.md` — the predecessor's report (start here).
- `.superpowers/sdd/progress.md` — the dated ledger (pre-registrations, batteries, the bar revision at line 274).
- `scripts/copy-weights.ts`, `mailwoman/release-tools/publish-hf.ts`, `.claude/skills/mailwoman-release/` — the release-staging files for task 1.
- `neural/fst-prior.ts` (gate + emission prior), `neural/trailing-locality-prior.ts` (opt-in), `core/pipeline/runtime-pipeline.ts` (default-on wiring, emission zeroed) — the mechanism files.
