# B4c numsplice — a real trade, not a clean win: house_number up, postcode down

2026-07-16. The number-piece vocab splice (v0.11.0-numsplice: word-start pieces 10-9999, so `178` ->
`▁178`, zero postcode-leaning continuations). init_from v310 FVT-expanded to 83,131. 2k probe, then
8k. **Verdict: the mechanism is confirmed and the house_number win is large — but it is bought with a
postcode regression that 8k did NOT heal. Not a ship candidate as-is.**

## The win (real, and where the shard failed)

| metric                       |       v310 |      v351 (8k) |                                            Δ |
| ---------------------------- | ---------: | -------------: | -------------------------------------------: |
| board 3 bare-street-hn       |      0.693 |          0.825 |     **+13.2pp** (fr-fragment shard got +1.7) |
| FR board date-name           |      0.158 |          0.682 | **+52.4pp** (the `11 Novembre` split, fixed) |
| FR fragment board OVERALL    |      0.733 |          0.809 |                                       +7.6pp |
| `aleja Wojska Polskiego 178` | postcode ✗ | house_number ✓ |               the PL non-coverage row, FIXED |
| parity house_number          |    117/146 |        118/146 |                                           +1 |

Single-piece numbers remove the continuation-postcode mass — the root the shard only dented. On
house_number, street fragments, and date-names it is a decisive, mechanism-confirming win.

## The cost (real, and structural — 8k did not heal it)

| metric                |          v310 |     v351 (8k) |                   Δ |
| --------------------- | ------------: | ------------: | ------------------: |
| parity postcode       | 71/72 = 0.986 | 64/72 = 0.889 | **−9.7pp (7 rows)** |
| board 3 pc-first-hn   |         0.940 |         0.845 |                −9.5 |
| board 3 city-first-hn |         0.953 |         0.870 |                −8.3 |
| board 3 street-led-hn |         0.968 |         0.915 |                −5.3 |

The 7 regressed postcode rows name the mechanism exactly:

```
6000, NSW, Australia          -> locality "6000 NSW"              (AU 4-digit absorbed)
1234AB, Amsterdam             -> house_number "1234AB"            (NL 4-digit -> house number)
Eight Mile Plains 4113        -> street "Eight Mile Plains 4113"  (absorbed into street)
Paris 75000, France           -> locality "Paris 75000"           (FR 5-digit absorbed)
```

**A single-piece number merges into the adjacent span more easily.** For a trailing postcode
(`… Plains 4113`, `Paris 75000`) that means it gets swallowed by the preceding street/locality instead
of tagged postcode. The same property that fixes house_number (the digit stops being pulled to
postcode by its continuations) lets postcodes be absorbed by their neighbours. The house/postcode
boundary moved toward house_number — helping one, hurting the other. **The 8k did not recover it**
(board 3 identical 2k→8k), so it is structural to the tokenization, not under-convergence.

## The fork (operator's call)

1. **RANGE REFINEMENT — 3-digit only (100-999).** The absorbed postcodes are all 4-5 digit
   (6000, 4113, 1234AB, 75000). A 3-digit-only splice keeps 4-5 digit numbers multi-piece — postcodes
   retain their length signal — while still single-piecing the 3-digit house numbers (the PL 178, much
   of bare-street-hn). This is the promising path: it may get the house_number win WITHOUT the postcode
   cost. A 2k probe answers it. **Recommended.**
2. **Accept the trade + ship.** No — parity postcode −9.7pp is too steep for a general-purpose
   geocoder. Postcode is a first-class output.
3. **Shelve numsplice, take B4b.** The fragment shard was weaker (+1.7pp) but did NOT trade postcode.
   A fallback if the range refinement also trades.

The mechanism is proven either way: the vocab is the root of the digit defect. The open question is
purely the range — which number lengths to single-piece so house_number wins without postcode losing.
