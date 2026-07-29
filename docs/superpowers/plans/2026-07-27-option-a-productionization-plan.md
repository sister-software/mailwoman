# Option-A productionization — execution plan (Claude-owned)

**Status:** ACTIVE · **Owner:** Claude (operator-delegated 2026-07-27: "You'll be in charge") ·
**From:** the five-run probe chain (v3.15 → v3.18, PR #1335, merged `cf0bbf71`) · **Target:** the
next model promotion ships the evidence bundle end to end.

## The confirmed recipe (what the probes bought)

Retrieval-augmented encoding on v385's lineage: two evidence channels as learned input features —
`street_type` (1-dim, codex street vocabulary) + `locality_surface` (2-dim `[locality,
locality_homograph]`, WOF-derived) — trained under the **absence-curriculum** (ramped per-row
zero-out, independent per-channel draws) with **three-law lexicon selectivity**:

1. **Degenerate exclusion** — function words, street-type words, all-function-word compositions
   (the shipped FST curation policy, applied to training evidence).
2. **Prominence floor** — 1-token locality surfaces need population-backed importance ≥ 0.25
   (hamlets are noise, not evidence).
3. **Person-name tier** — 1-token surfaces in libpostal given_names/surnames/personal_titles need
   importance ≥ 0.45 (Joseph/Pierre/Saint leave; Paris/Lyon/Nancy stay).

Verdict grid (v3.18, all pre-registered bars passed): locality marginal within −0.020 everywhere;
homonym +0.055 as-typed / **+0.292 lowercase-heal**; user-register net +0.020. The lowercase
doctrine (operator-ratified) is load-bearing: evidence value peaks in the register users type.

## Phases

### Phase 1 — artifacts become first-class (S, no GPU)

- Promote both lexicon builders from `scripts/diagnostic/` into `mailwoman/gazetteer-pipeline/` +
  `mailwoman gazetteer build` commands (drawer policy), the three-law policy recorded in each
  artifact's `generated_by` + a policy block. Versioned outputs; the locality lexicon (13 MB) ships
  like the other soft-feed binaries (weights-package sibling + HF staging + publish.yml fetch), NOT
  in git.
- The evidence-channel spec lands in the model card's `requires` block (the ship-config discipline:
  a bundle-trained model refuses to run without its lexicons — the #718 strict-channel precedent).

### Phase 2 — inference parity (M, the real build)

- TS painting: mirror `gazetteer_char_paint`/`realign_gazetteer_to_pieces` semantics for both
  channels in `@mailwoman/neural` (the anchor-lexicon TS painter is the template; word-norm rules
  are already documented in each lexicon's `rules` block — train/inference MUST share the
  computation byte-for-byte, tested against golden fixtures generated from the Python painter).
- ONNX export gains the two graph inputs (`export_onnx` wiring); node + browser classifiers feed
  them; `neural-web` parity.
- The zero-feature path must be byte-identical to a no-channel model for back-compat weights (the
  probe's smoke-test contract, now a standing test).

### Phase 3 — the production training run (M)

- Full-scale recipe off the probe's shape: the standing feed, 8k+ steps, bundle + curriculum +
  v3-selectivity lexicons. The P-A decay was time-dependent — checkpoints graded at every save, the
  over-trust watch explicit.
- **Gates (pre-registered before launch, per the iron rules):** the full promotion battery — golden
  us/fr floors, **invariance suite `--baseline v385`** (the probe chain never ran it; the P-B
  comma-drop signature is the named watch), gauntlet ×3 layers, presets byte-check, fragment boards
  **with lowercase legs** (doctrine), and the NEW **evidence-ablation gate**: channels-zeroed parse
  ≥ v385 baseline on unaffected spans — this gate joins the standing battery permanently.

### Phase 4 — ship + retire (S)

- The promotion ships model + lexicons together (tokenizer-mismatch discipline applies to lexicons
  now too: the card pins their identities).
- Decode-surface retirement check (SCOPE invariant 4): which FST-prior/gate levers does the trained
  bundle subsume? Measured head-to-head; retire what it beats — the anti-hellscape payoff.

## Open research items (named, not blocking Phases 1–2)

- **Street channel × lowercase × house-number** (the −0.19 class): levers = feed case-augmentation
  bump, street-channel presence-noise, `normalizeCase`-for-lowercase (its own product arc). Phase 3
  carries it as a watched class with its own bar, not a blocker.
- The ambiguity field (`crossCountryBranches`, 6.6.5 candidates) as a continuous third dim — only
  after the binary bundle ships (one artifact churn at a time).
- Pair-hierarchy artifacts as the GB/NZ-style pair evidence channel — the design doc's five open
  questions route through Phase 1's builder consolidation.

## Receipts

Five-run chain + attribution + paint-check + heal/case grids: `.superpowers/sdd/progress.md`
(2026-07-26/27 blocks). Probe assets inventory: memory `project-parser-architecture-probes`.
