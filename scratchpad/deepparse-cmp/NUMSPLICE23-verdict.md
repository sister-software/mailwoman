# B4c 10-999 (v353) — 2-digit doesn't recover date-name; 3-digit (v352) is the cut

**The fork this probe adjudicated:** the 3-digit cut (v352) held the postcode guard perfectly but forgave
half the FR date-name win. Hypothesis: adding 2-digit pieces (10-99) recovers the date-name 2-digit day
(`11 Novembre`) at no postcode cost (2-digit can't collide with a 4-5 digit postcode), so 10-999 would
strictly dominate 100-999.

**Verdict: hypothesis REFUTED. Take 100-999 (v352) to 8k.** v353 = v0.11.2-numsplice23 (word-start
10-999, +988), 2k probe, init_from v310 FVT mean-init to 74,131.

## The three arms

| metric                      | v310 (shipped) | v352 (3-digit 100-999) | v353 (10-999)         |
| --------------------------- | -------------- | ---------------------- | --------------------- |
| **parity postcode** (guard) | 0.986          | **0.986 (0 new reg)**  | 0.972 (**1 new reg**) |
| FR date-name                | 0.158          | 0.367                  | 0.395                 |
| FR fragment OVERALL         | 0.733          | 0.775                  | 0.780                 |
| board3 bare-street-hn       | 0.693          | 0.787                  | 0.813                 |
| board3 city-first-hn        | 0.953          | **0.915**              | 0.890                 |
| board3 pc-first-hn          | 0.940          | **0.860**              | 0.828                 |
| board3 street-led-hn        | 0.968          | **0.938**              | 0.917                 |
| board3 slash-hn             | —              | 0.642                  | 0.583                 |

All differences between v352 and v353 sit inside the n=400 noise band (95% CI ≈ ±0.04) **except the
guard**, where v352 is clean (0 regressions) and v353 nicks one row:
`Eight Mile Plains 4113` → postcode `"Plains 4113"` (the locality word pulled in). So on the one axis
that separates them, v352 wins. v352 is also the smaller vocab (900 vs 988 pieces).

## Why 2-digit didn't recover date-name — the real mechanism

The date-name win the FULL range (10-9999) captured (0.682) was NOT carried by the 2-digit day. It was
carried by the **4-digit YEAR**: `rue du 8 Mai 1945` → under full range `1945` → `▁1945` (one piece);
under 10-999 `1945` → `▁194,5` (unchanged from v310). The day (`8`, `11`) is a 1-2 digit token that
barely moves the phrase. So:

- **date-name and postcode are in DIRECT conflict.** Both want 4-digit single-pieces (year vs postcode).
  A 4-digit piece that makes `1945` one token is the SAME kind of piece that makes `4113` one token and
  lets it be swallowed. You cannot single-piece the year without single-piecing the postcode.
- 10-999 can't recover date-name because recovering it **requires** the 4-digit pieces that break
  postcodes — which is exactly what the 3-digit cut was designed to avoid.

This is the deeper finding behind the full-range trade: it wasn't an accident of the range, it's that
French date-street names and 4-digit postcodes compete for the same tokenizer capacity. For a general
geocoder, postcodes win.

## Decision

Per the pre-registered table: `guard DROPS (1 reg) + date-name FLAT (+2.8pp, noise) → fall back to
100-999 (v352)`. Both signals point the same way.

**Ship path: take v352 (3-digit, 100-999) to 8k.** It's the clean lever — house_number win (PL 178 fixed,
board-3 bare-street +9.4pp, contextful recovered), postcode guard intact (0.986, 0 regressions), demos
byte-identical. The softer FR date-name (0.367, +21pp over shipped, never regresses) is the accepted cost,
and now we know WHY it can't be recovered without breaking postcodes. Promotion is the operator's act.
