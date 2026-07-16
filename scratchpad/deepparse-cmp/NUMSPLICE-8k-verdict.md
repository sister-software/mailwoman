# B4c 3-digit 8k (v354) — DON'T PROMOTE. The postcode guard held, but the cost moved, not vanished.

**The candidate:** v354 = the 3-digit (100-999) numsplice cut, 8k, the "clean lever" the 2k probe (v352)
promised — house_number digit-ownership win, postcode guard intact. The 8k confirmed the probe on its own
instruments. Then the full golden gate told a different story.

## The gate delta — the honest arbiter

Both v310 (shipped basis of v6.4.0) and v354 register `FAIL` on the v6.0.0-shipped-baseline gate, so the
absolute floors are stale — v310 misses only `fr.postcode` 98.9 vs 99.2 (−0.3pp, a hair). The gate is
therefore NOT the discriminator; the **delta v354 − v310 on identical code** is. That delta:

| gate floor              | v310 | v354 |                      delta |
| ----------------------- | ---: | ---: | -------------------------: |
| us.country_homograph_f1 | 87.5 | 83.3 |                   **−4.2** |
| us.unit_real            | 97.0 | 93.9 | **−3.1** (floor 95 → FAIL) |
| arena.perturb           |   79 |   76 | **−3.0** (floor 78 → FAIL) |
| **fr.house_number**     | 96.8 | 94.0 |                   **−2.8** |
| fr.cedex_real           | 89.1 | 86.5 |                   **−2.6** |
| us.street_suffix        | 94.9 | 93.3 |                       −1.6 |
| us.locality             | 78.8 | 77.7 |                       −1.1 |
| us.postcode             | 96.5 | 96.3 |                       −0.2 |
| **on-gate gains**       |      |      |                   **none** |

Five tags regress >2pp; nothing on the golden gate improves. The numsplice WINS (board-3 bare-street-hn
0.693→0.790, the PL `aleja Wojska Polskiego 178` row, contextful Norwegian) are all OUTSIDE this gate —
cross-lingual bare-fragment space the golden US/FR/DE set doesn't cover.

The most telling row: **fr.house_number −2.8pp.** The whole numsplice thesis was to fix digit ownership /
house_number, and on the FR golden set (n=1546, contextful well-formed addresses) house_number got WORSE.
The win is narrow (bare Norwegian streets, the PL fragment); the cost is broad (contextful FR house_number,
unit numbers, country homographs, cedex, adversarial robustness).

## The pattern across all cuts — a trade, not a free win

| cut                       | narrow win                          | broad cost                                                         |
| ------------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| full-range 10-9999 (v351) | board-3 +13.2pp, FR date-name +52pp | parity postcode −9.7pp                                             |
| 3-digit 100-999 (v354)    | board-3 +9.7pp, PL 178 fixed        | unit −3.1, homograph −4.2, fr-hn −2.8, cedex −2.6, robustness −3.0 |

The postcode guard held for 3-digit — but the cost didn't vanish, it MOVED to other numeric-context tags.
FVT mean-init + fine-tune perturbs the whole numeric-token manifold; every golden tag that reads a number
in context (unit number, cedex, house_number-in-context, homograph digits) gets nudged. There is no range
that single-pieces the bare-fragment digits without perturbing the contextful ones — they share the vocab.

## Verdict

**DON'T PROMOTE v354.** Numsplice is a CONFIRMED mechanism for the bare-fragment digit defect, but it is a
diffuse-cost trade at every range tried, and the costs land on shipped golden capabilities (notably
fr.house_number, the #727 headline). The shipped v310/v6.4.0 is the better general model.

Caveat: both grades ran on the same core/out (a stale-out warning fired); the delta is on identical code so
it stands, but a recompiled re-grade is the confirmation step if numsplice is pursued further.

## Path forward for digit ownership

- **B4b (the fragment-shard lever)** — a CORPUS change (more bare-street rows), not vocab surgery, so it
  cannot perturb the numeric manifold the way the splice does. Weaker (+1.7pp on the 2k probe) but no
  diffuse golden cost. This is the safe lever if bare-fragment digit ownership is still wanted.
- **Or close it** — accept shipped behavior on bare-fragment digits; the defect is real but narrow, and no
  vocab cut buys it without broad collateral.

Numsplice tokenizers (v0.11.0/0.11.1/0.11.2) and the v350-v354 runs are the receipt. Don't re-propose a
numsplice range without reading this — the trade is intrinsic to sharing numeric vocab, not a range bug.
