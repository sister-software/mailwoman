# v7.1.0 candidate — CA/MX Overture locale add (v385 latam 8k)

**Date:** 2026-07-18 (night). **Model:** `output-v384-latam-probe-s42/step-008000` (int8 `model-v385-latam8k-int8.onnx`). **Recipe:** `v3.8.5-latam-8k.yaml` — init_from shipped v381, `+CA/MX` in `country_weights`, `overture-latam:6.0` source (dedicated, doesn't dilute the trained EU `overture` rows), 8k (2k probe → 8k resume, constant LR). **Corpus:** `v0.13.0-latam` overlay (base v0.11.0-no-fragment + a 456k-row `overture-latam` shard, CA 299,809 + MX 156,421).

**Status: PROMOTABLE — all guards pass. Promote is the operator's call (HF upload + npm release, staged not shipped).**

## The win

- **MX locality +8.7** (74.0 → 82.7, native-order held-out board). The first genuinely-new locale coverage — the model now parses Mexican addresses (Spanish city surfaces, `Privada`/`Calle` streets) meaningfully better than shipped.
- **CA neutral** — v381 already parses Canadian (US-order) addresses; CA adds coverage-provenance but no measurable gain. Ships free.

## The guards (all PASS)

**Golden 2pp gate** (`data/eval/golden/v0.1.2`, channels-on, v385 vs shipped v381, same run):

| tag | v385 | shipped | Δ |
| --- | --- | --- | --- |
| exact-match | 24.2% (1105) | 24.2% (1104) | +1 row |
| locality | 46.8 | 46.8 | flat |
| region | 78.1 | 78.6 | −0.5 |
| postcode | 97.3 | 97.3 | flat |
| street | 15.3 | 15.3 | flat |
| house_number | 96.9 | 96.7 | +0.2 |
| **country** | **89.8** | **91.4** | **−1.6** |

No tag > 2pp down → **PASS**. The one nick is `country` **−1.6pp** (220 vs 224 / 245 — small-N; recovered from the 2k probe's −2.0). The #1104 country channel reacts to the new CA/MX surfaces. Sub-threshold and stated; the 4-row miss characterization (CA/MX-adjacent vs US/FR) is a tracked follow-up.

**Gauntlet** (`eval gauntlet --candidate`): regression **33/33 PASS**; metamorphic INV 62/63, DIR 3/3, BAND 16/21 — **identical known-xfail profile to shipped v381** (the 1 INV[comma-drop] xfail is the pre-existing FR `Rue du Chevaleret` #1101 case; the US comma-drop held). **No new regression.**

## Autonomous decisions

- BR **dropped** (0% OA-lineage → license unclear; `number` field is `SN (CASA N)` garbage). Deferred, not blocked.
- NZ **excluded** — separate dead-tag problem (`dependent_locality` unemittable in v381; see `2026-07-18-night-postmortem.md`). NZ is not in this overlay.
- 2k → 8k escalation was gated on a net-positive 2k probe + a passing golden 2pp; the 8k recovered the country nick from −2.0 to −1.6.

## To promote (operator)

1. Materialize v385 as the `neural-weights-en-us` model bundle (`scripts/copy-weights.ts` / the card's `files_md5`), bump the model card, append the eval-ledger row.
2. `npm` release as **v7.1.0** (package minor; first post-v7 model) via the publish workflow.
3. Optional pre-promote: characterize the 4-row country miss; add a native-order render to the CA/MX golden board (the eval-direction closed-loop artifact caught this cycle).

Model + artifacts staged (uncommitted): int8 on the Modal volume `/models/quantized/model-v385-latam8k-int8.onnx`; recipe/config on branch `feat/locale-expansion-nz-camx`.
