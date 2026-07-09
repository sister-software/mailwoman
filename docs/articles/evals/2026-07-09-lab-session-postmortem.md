# Lab-session postmortem — 2026-07-08→09 (the FR completeness sprint)

Drafted at wrap. Window: 2026-07-08 ~15:00 → 2026-07-09 ~06:30 UTC, operator present
(night-shift posture with live review). This session closed the FR quality arc the outreach
campaign opened: two releases, one model promotion, three falsifications with mechanisms.

## Headline

`55 Rue du Faubourg Saint-Honoré, 75008 Paris` → BAN rooftop `[2.316931, 48.87063]`,
`type:house`, accent intact — live on photon.sister.software. Twelve hours earlier that query
lost its `é` at the parser, missed a rooftop the data held, and rendered as a lowercase city echo.

## Shipped

| release    | contents                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **v5.8.0** | #1012 BAN FR address-point tier (26M rooftops, @1km 37.4→87.9% in-BAN, Nominatim-independent 13/14 <200 m); #1023 namesake fix; first publish of `@mailwoman/ban` (OIDC can't create packages — operator one-time token publish + trusted-publisher config, then CI)     |
| **v5.9.0** | **v241 model promotion**: `v2.4.1-fr-nsplice-ft` (init_from fine-tune on the `v0.8.0-fr-nsplice` spliced tokenizer) + #1046 street-centroid tier (2.2M streets derived from the sealed BAN artifact, voies 0/8→7/8) + #1043 house-grade decoration + #1047/#1048 tooling |

v241 gate table (full version on #444): mangle 23.5→**17.7%** int8, Honoré+René fixed, held-out
FR z=+0.90 / US z=+0.29, non-FR drift ~0. Training: 12k steps, constant lr 5e-5, ~33 min A100.

## Falsified (the night's real product)

1. **#1039 LocaleHint-as-country-prior** — locale-gate is script+postcode by design; `en-US/0.30`
   fallback on 34/36 no-postcode-tail inputs. Wiring it would be inert-to-harmful. Surviving
   levers: street-type-morphology prior, confidence floor.
2. **Training-free FR vocab-splice (#444/#1047)** — mean-init inherits `é`'s strongly-trained
   O-signal; mangle got WORSE (23.5→26.4%). Prior art (#884/#912) held only under weak-diacritic
   conditions. The falsification specified the fine-tune that then shipped.
3. **BAN keying exonerated** — 20,000 accented street keys round-trip with 0 mismatches;
   the accent loss was model-side (13.4%→re-derived 23.5% mangle class).

## What could've gone better

- **release.config.json lagged the v5.4.0 promote** (#1024): copy-weights materialized the wrong
  model and the gauntlet graded it — cost a void bisect during the 5.6.0 cut. The md5-vs-card
  guard now makes this structural.
- **npm tarball-replication lag** (~15 min, metadata-before-blob on `kind-classifier@5.9.0`) bit
  the endpoint bump — poll the tarball URL, not `npm view`, before declaring a publish consumable.
- **Trackio was silently CSV-only for every run** (reserved `_legend` key) — found+fixed at the
  v241 launch; unknown how many prior runs went untracked live.
- Judging tier behavior from Photon `properties` misled twice (#1041/#1050) — decoration lags the
  resolution ladder by one release; verify tier via repro script, not wire labels.

## Open / next

- **Sends** (Anyways / OpenRunner / Oslandia): kits SEND-READY, all claims live-true post-5.9.0.
- **Ledger row for 5.9.0** — append per re-anchor discipline (morning bookkeeping).
- **Demo repoint** — HF `defaultVersion` still v5.4.0; `hasPolygons=false` caveat applies.
- Residuals filed: #1050 (street-tier decoration), #1045 (+Lyon PLM datapoint), #1044
  (BAN CSV quote-pollution → extract fix + rebuild), Champs-Élysées (É-after-hyphen, on #444).
- #1009/#1010 self-serve remain the pre-public-flip items; 16 dependabot alerts outstanding.

## Numbers

~$3 Modal (1× A100 ~40 min incl. 3 min lost to the Trackio relaunch), 1 model trained + promoted,
0 NaN, 2 releases, 8 PRs merged, 6 public issues filed, 0 regressions shipped
(gauntlet PASS on every cut; US held-out byte-identical through the model promote).
