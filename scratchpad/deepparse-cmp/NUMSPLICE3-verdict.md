# B4c 3-digit range refinement (v352) — the guard HOLDS; house_number win without the postcode cost

**The fork this probe adjudicated:** the full-range splice (10-9999, v351) fixed house_number
(+13.2pp board-3 bare-street) but broke 4-5 digit postcodes (parity postcode −9.7pp, 7 rows absorbed
into adjacent spans). Hypothesis: the postcode cost was carried by the 4-5 digit pieces; a 3-digit-only
splice (100-999) keeps 4-5 digit numbers multi-piece and so retains the house_number win WITHOUT the
cost.

**Verdict: CONFIRMED.** v352 = v0.11.1-numsplice3 (word-start 100-999 only, +900 pieces), 2k probe,
init_from v310 step-008000 FVT mean-init'd to 74,043.

## The decisive guard — parity postcode

| model                          | parity postcode   | new regressions vs v310 |
| ------------------------------ | ----------------- | ----------------------- |
| v310 (shipped)                 | 0.986 (1/72 miss) | —                       |
| v351 (full 10-9999, 8k)        | 0.889 (8/72)      | **7**                   |
| **v352 (3-digit 100-999, 2k)** | **0.986 (1/72)**  | **0**                   |

The 3-digit cut avoids the postcode cost **entirely**. Zero rows that v310 got right are broken. The
4-5 digit postcodes (AU/NL 4-digit, FR 5-digit) that the full range swallowed stay multi-piece, so
their length signal survives.

## The house_number win — retained

- **PL row** `aleja Wojska Polskiego 178`: v310 → `postcode:178` (WRONG); **v352 → `house_number:178`** (CORRECT). Same fix as the full range.
- **board-3 bare-street-hn**: 0.693 → **0.787** (+9.4pp at only 2k; full range reached 0.825 at 8k — an 8k here should close much of that 3.8pp).
- **board-3 contextful classes RECOVERED** vs the full range (the full range regressed these −5 to −9.5pp; 3-digit does not):

| class         | v310  | v351 (full 8k) | v352 (3-digit 2k) |
| ------------- | ----- | -------------- | ----------------- |
| city-first-hn | 0.953 | 0.870          | **0.915**         |
| pc-first-hn   | 0.940 | 0.845          | **0.860**         |
| street-led-hn | 0.968 | 0.915          | **0.938**         |

- **6 demo presets**: byte-identical to v310 (US 5-digit ZIP guard holds: 20500/10118/94133/60613/98109/90210 all correct postcode).

## The one thing 3-digit gives up — FR date-name

| FR fragment class  | v310  | v351 (full 8k) | v352 (3-digit 2k) |
| ------------------ | ----- | -------------- | ----------------- |
| date-name          | 0.158 | **0.682**      | 0.367             |
| bare-street        | 0.715 | 0.720          | 0.743             |
| street-particle    | 0.855 | 0.838          | 0.860             |
| alnum-housenumber  | 0.960 | 0.965          | 0.963             |
| street-housenumber | 0.948 | 0.950          | 0.950             |
| OVERALL            | 0.733 | 0.809          | 0.775             |

`date-name` (`rue du 11 Novembre`, `rue du 8 Mai 1945`) is the one class where 3-digit under-delivers:
+21pp (0.158→0.367) vs the full range's +52pp. **Structural, not convergence**: date streets carry
2-digit day numbers (`11`, `8`) and 4-digit years (`1945`), and 100-999 splices neither — so those
tokens are unchanged from v310. The full range spliced them; 3-digit can't. It still never regressed
anything, and FR OVERALL is +4.2pp over shipped.

## What the data now points at — 10-999 (add 2-digit)

The postcode cost was carried by the 4-5 digit pieces; 2-digit pieces (10-99) **cannot** collide with a
4-5 digit postcode. So a **10-999** cut (2+3 digit) would:

- keep the postcode guard clean (2-digit can't be swallowed as a 4-5 digit postcode), AND
- recover the FR date-name **2-digit** win (`11 Novembre` → `▁11`) that 3-digit forgoes.

It would still forgo the 4-digit-year part of date-name (`1945`), but that is the smaller half. A single
2k probe answers whether 10-999 is strictly better than 100-999.

## Decision (per the config's pre-registered table)

`win HOLDS + guard HOLDS → SHIP CANDIDATE`. Both hold. **3-digit (100-999) is a clean lever** — the
first numsplice cut that fixes house_number without a postcode regression. Two ways forward:

1. **10-999 probe first** (recommended, ~10 min) — the mechanism says it dominates 3-digit (same guard,
   plus the date-name 2-digit win). If it holds, take _that_ to 8k. Cheap, and it's the completion the
   data asked for.
2. **8k on 3-digit now** — commit to 100-999, confirm bare-street-hn reaches ~0.82 and contextful holds,
   accept the softer date-name. Ship candidate on pass.

Not shipping either from a 2k. Promotion is the operator's act.
