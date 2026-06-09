# Night-Shift Postmortem — 2026-06-09 (parity campaign: affix gated, country → deterministic)

*Sketched live during the shift (04:45→15:00 UTC), finalized at wrap-up.*

## What shipped

- **v0.9.8-affix gated + int8 ship-ready** (PR #461 merged). street_prefix 0→78 (P100/R64), street_suffix 0→67 (P100/R50) on the real-affix OOD eval; US golden street +2.1 (negative space); unit retained 93.8. FR postcode −3.9 (US-shard dilution) trips the >2pp gate → **promote deferred to operator (#462)**; DeepSeek recommends promote-with-annotation.
- **Affix-aware eval tooling** (`scripts/eval/score-affix.ts`, `probe-affix-decode.ts`) — `per-locale-f1`'s `foldToComponents` joins affixes into `street`, so it can't measure the split; these score the unfolded decode. Caught the gate's false 0% (the model splits 7/10, perfect precision).
- **Parity scorecard** (`docs/articles/evals/parity-scorecard-2026-06-09.md`, #375) — one authoritative per-tag-vs-v0 table, two lenses (arenas + per-tag), with the fold gotcha documented.
- **Country lever resolved** (PR #463 + #464): salvaged ISO 3166-1 from isp-nexus into `codex/country/` + surface-form layer + `matchCountry`; multi-locale shard (US/DE/FR/IT/NL, v1/v2/v3); real-country OOD eval (34 cases). **Key result: the model is the wrong tool.** The v1 cumulative shard makes the model *over-fire* (country-real 49 F1, golden precision 23% — it learns "trailing token = country"), whereas a deterministic `matchCountry` on the trailing comma-segment scores **P=R=F1=100**. Lever moves to a post-parse `ProposalClassifier` (#464); the model path is kept on #463 as the exploration record.

## What went well

- The proven recipe (codex synth + format-diverse + real-OOD gate + int8 value_info-strip) carried two more levers cleanly through build+gate.
- Caught the **fold gotcha** fast (the affix 0% was a measurement artifact, not a training failure) — built the right tool instead of chasing a phantom.
- The multi-locale country shard **recovered the affix FR-postcode dilution** (95.6→99.5) — the secondary design goal worked.
- Front-loaded the scorecard during the affix train window; no idle.
- **Let a negative result reshape the strategy instead of forcing the lever.** The country over-firing wasn't a bug to tune away — it revealed a *lever-shape taxonomy*: closed-vocab/fixed-position tags (country, po_box, cedex) want a deterministic matcher; open-vocab/boundary tags (affix, unit, locality) want a retrain. That taxonomy now guides the remaining levers (po_box likely goes deterministic too).

## What could've gone better

- **Jumped to a cumulative country run** (base+unit+affix+country in one) rather than proving country solo first — it diluted (affix suffix 67→59) and country **over-fired** (golden precision 23%, fp high). The v2-vs-v3 unit lesson ("prove solo before combining") applied and I under-weighted it. Silver lining: the dilution *is* the evidence behind the consolidation rule (prove solo, then consolidate with a bigger step budget) now in the scorecard. But two retrains (v1 cumulative + v2 negatives) burned GPU on a lever that a 10-line deterministic probe should have pre-empted — I should have run the deterministic probe **before** the first country retrain, given country's obvious closed-vocab/trailing shape.
- The affix gate's first read was a false 0% (fold) — a per-tag affix scorer should have existed before the shard (now it does).

## Decisions made autonomously

1. **Held the affix promote** (gate not cleanly passed; FR postcode −3.9 > 2pp) against DeepSeek's promote-rec — deferred to the operator via #462 rather than overriding their pre-registered gate while offline.
2. **Country lever as cumulative consolidation** (bakes unit+affix+country) — efficient in intent but it surfaced dilution + over-firing. The DeepSeek pro consult on the fork timed out (180s); I proceeded on the diagnosis. **Resolution (autonomous): redirect country from retrain to a deterministic tagger.** The deterministic probe (P=R=100) settled it — country is closed-vocab and trailing, so a `matchCountry` `ProposalClassifier` (#464) is the right tool, not another shard. Kept #463 as the exploration record rather than force-merging an over-firing model.
3. **Held the v3 FR-fix as a committed-but-superseded artifact** rather than launching a v3 retrain — once the deterministic result landed, spending more GPU on the model path was unjustified. v3's corpus correctness fix (FR number-street order) is still committed for whoever revisits.

## Open questions for the operator

- **#462: promote v0.9.8-affix → v4.2.0?** (clean affix win, FR-postcode −3.9 trade). DeepSeek says yes-with-annotation. *Still needs your call — I did not promote while offline against the pre-registered gate.*
- **#463 disposition:** merge for the reusable `codex/country` + eval assets, or close in favor of #464 (deterministic)? Either is fine; the codex salvage is the durable part.
- **#464 homograph guard:** the deterministic tagger needs a guard for state/country homographs (Georgia, Jordan) before it can default-on. Fire only when the trailing segment is unambiguously a country, or downrank when an upstream `region` already claims the span.

## Concrete next steps

- **#464**: build the deterministic country `ProposalClassifier` (codex `matchCountry` on the trailing comma-segment) — opt-in, byte-stable, with the homograph guard. ~½ day, zero GPU. po_box likely follows the same shape.
- po_box lever (codex salvaged: `codex/us/po-box.ts`) — probe deterministic-first before any retrain (lesson applied); intersection (gated); FR venue/cedex (#330).
- Consolidation v1.0 once the open-vocab levers (affix) are promoted — bake winners into one run with **> 20k steps** to beat the cumulative dilution; full per-tag regression gate.

## Numbers (running)

| metric | value |
| --- | --- |
| shift window | 04:45→15:00 UTC |
| models trained (Modal) | 3 (affix v0.9.8, country v1 cumulative, country v2 negatives) |
| Modal spend | ~$10–12 of $20 |
| NaN incidents | 0 |
| CI failures | 0 (corpus-cli flake re-ran green) |
| regressions shipped | 0 (affix held experimental; nothing promoted) |
| PRs / issues | #461 (merged), #463 (open — country exploration), #462 (issue — affix promote), #464 (issue — deterministic country) |
| campaign tags | unit ✅ shipped · affix ✅ gated/deferred (#462) · country ✅ resolved → deterministic (#464) |
