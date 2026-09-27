# Option-A productionization — execution plan (Claude-owned)

**Status:** ACTIVE · **Owner:** Claude (operator-delegated 2026-07-27: "You'll be in charge") ·
**From:** the five-run probe chain (v3.15 → v3.18, PR #1335, merged `cf0bbf71`) · **Target:** the
next model promotion ships the evidence bundle end to end.

## The confirmed recipe (what the probes bought)

The recipe is retrieval-augmented encoding on v385's lineage. Two evidence channels enter as learned
input features: `street_type` (1-dim, codex street vocabulary) and `locality_surface` (2-dim
`[locality, locality_homograph]`, WOF-derived). They are trained under the **absence curriculum**,
which zeroes them out per row on a ramp with independent draws per channel. The lexicons use
**three-law selectivity**:

1. **Degenerate exclusion** removes function words, street-type words, and compositions made only of
   function words. This is the shipped FST curation policy, applied to training evidence.
2. **Prominence floor:** 1-token locality surfaces need population-backed importance ≥ 0.25, because
   hamlets add noise rather than evidence.
3. **Person-name tier:** 1-token surfaces in libpostal given_names/surnames/personal_titles need
   importance ≥ 0.45. Joseph, Pierre and Saint are removed, while Paris, Lyon and Nancy stay.

Verdict grid (v3.18, all pre-registered bars passed): the locality marginal stayed within −0.020
everywhere. Homonym improved +0.055 as typed and **+0.292 with the lowercase heal**. The user
register improved +0.020 net. The operator-ratified lowercase rule is required, because the evidence
has the most value in the register users type.

## Phases

### Phase 1 — artifacts become first-class (S, CPU only)

- Move both lexicon builders from `scripts/diagnostic/` into `mailwoman/gazetteer-pipeline/` as
  `mailwoman gazetteer build` commands, following the scripts drawer policy. Each artifact records
  the three-law policy in its `generated_by` field and a policy block. Outputs are versioned. The
  locality lexicon (13 MB) ships like the other soft-feed binaries (weights-package sibling, HF
  staging and a publish.yml fetch) instead of living in git.
- The evidence-channel spec goes into the model card's `requires` block. A bundle-trained model then
  refuses to run without its lexicons, following the #718 strict-channel precedent.

### Phase 2 — inference parity (M, the real build)

- TS painting: reproduce the `gazetteer_char_paint`/`realign_gazetteer_to_pieces` semantics for
  both channels in `@mailwoman/neural`. The anchor-lexicon TS painter is the template, and each
  lexicon's `rules` block already documents the word-normalization rules. Training and inference
  must compute the features byte-for-byte identically. Golden fixtures generated from the Python
  painter test this.
- ONNX export gains the two graph inputs (`export_onnx` wiring). The node and browser classifiers
  feed them, and `neural-web` matches node.
- For back-compat weights, the zero-feature path must be byte-identical to a model without channels.
  The probe's smoke test for this becomes a standing test.

### Phase 3 — the production training run (M)

- Scale the probe's recipe up: the standing feed, 8k+ steps, bundle, curriculum and v3-selectivity
  lexicons. The P-A decay depended on training time, so every saved checkpoint is graded and
  over-trust is watched explicitly.
- **Checks (pre-registered before launch, per the iron rules):** the full promotion battery. It
  includes golden us/fr floors, the **invariance suite `--baseline v385`**, gauntlet ×3 layers, the
  presets byte-check, and fragment boards **with lowercase legs**. The probe chain never ran the
  invariance suite, and the P-B comma-drop signature is the specific failure to watch for. The
  battery also adds the new **evidence-ablation check**: a parse with the channels zeroed must score
  ≥ the v385 baseline on unaffected spans. This check joins the standing battery permanently.

### Phase 4 — ship + retire (S)

- The promotion ships the model and lexicons together. The tokenizer-mismatch rule now applies to
  lexicons too, so the card pins their identities.
- Decode-surface retirement check (SCOPE invariant 4): measure head-to-head which FST-prior and
  check changes the trained bundle subsumes, and retire each one it beats. This reduces the number
  of decode-time mechanisms.

## Open research items (named rather than blocking Phases 1–2)

- **Street channel × lowercase × house-number** (the −0.19 class): candidate changes are a larger
  feed case-augmentation rate, presence noise on the street channel, and `normalizeCase` for
  lowercase input (its own product arc). Phase 3 treats it as a watched class with its own bar
  rather than as a blocker.
- The ambiguity field (`crossCountryBranches`, 6.6.5 candidates) could become a continuous third
  dimension, but only after the binary bundle ships, so that one artifact changes at a time.
- Pair-hierarchy artifacts could serve as a GB/NZ-style pair evidence channel. The design doc's five
  open questions are handled in Phase 1's builder consolidation.

## Receipts

The five-run chain, attribution, paint check and heal/case grids are in
`.superpowers/sdd/progress.md` (2026-07-26/27 blocks). The probe asset inventory is in memory
`project-parser-architecture-probes`.
