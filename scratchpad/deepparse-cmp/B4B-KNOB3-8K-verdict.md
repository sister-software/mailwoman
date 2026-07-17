# B4b knob 3 8k (v371) — clean additive net-positive, but the target PLATEAUS below the bar

The escalation of the additive 2k probe (v370). The 8k answers the one open question — does more training
push bare-street-hn over the strict bar? **No: it plateaus.** But it stays clean everywhere, and the 8k
golden gate (the step that exposed numsplice's trade) is spotless.

## The reads — 2k vs 8k

| board       | metric                      |           v310 |      v370 (2k) |      v371 (8k) | note                                                    |
| ----------- | --------------------------- | -------------: | -------------: | -------------: | ------------------------------------------------------- |
| board 3     | **bare-street-hn** (TARGET) |          0.693 |          0.740 |      **0.733** | PLATEAU — 8k did not move it; strict bar ~≥0.78 NOT met |
| board 3     | city/pc-first/street-led    | .953/.940/.968 | .953/.955/.968 | .953/.955/.965 | held                                                    |
| board 3     | bare-pc (guard)             |          1.000 |          1.000 |          1.000 | ✓                                                       |
| FR fragment | OVERALL                     |          0.733 |          0.767 |      **0.758** | +2.5pp, held                                            |
| FR fragment | bare-street                 |          0.715 |          0.802 |          0.775 | +6.0pp                                                  |
| golden gate | verdict                     |           PASS |           PASS |       **PASS** | —                                                       |
| golden gate | >2pp regressions vs v310    |              — |              0 |          **0** | fr-hn +0.2, unit ±0, cedex +0.2                         |
| golden gate | country_homograph_f1        |           87.5 |           89.8 |       **89.8** | +2.3pp gain                                             |

The 2k→8k trajectory on the target is FLAT (0.740 → 0.733, inside noise). This is convergence, not
under-training — knob 3 tops out at ~+4pp on bare-street-hn. The 8k golden gate is clean, confirming the
2k: unlike numsplice (whose 8k gate revealed a −2 to −4pp trade on 5 tags), knob 3's cost stays at zero
through 8k. fr.house_number is +0.2pp (numsplice was −2.8pp).

## What v371 IS

A **clean, purely-additive net-positive** over shipped v310/v6.4.0: bare-street-hn +4pp, FR fragment
+2.5pp, country_homograph +2.3pp, and NOTHING regressed >2pp on the golden gate. It is strictly better on
every axis it touches. It is the only digit-ownership lever with no trade at any range or step count.

## What v371 is NOT

A **solution** to digit-ownership. The target plateaus at 0.733, well below the pre-registered bar
(~≥0.78 for clean CI separation). The residual is the same dual-mode failure: digit→postcode on some
3-digit (the tokenizer length prior, which only vocab surgery moved — and that failed the gate) and
absorption on SHORT numbers (`Utsikten 3`, 1-digit, below this shard's ≥3-digit boost).

## Fork — ship / iterate / hold

1. **SHIP v371** as a clean additive improvement. Defensible: it beats shipped on bare-street-hn, FR
   fragment, and homograph with ZERO golden cost. The caveat is honesty — it does NOT clear the
   digit-ownership bar the arc set; it's a marginal net-positive, not a fix. Full release cycle for
   +4pp/+2.5pp/+2.3pp.
2. **One more cheap tweak (recommended if pursuing the bar):** a 2k probe with `--long-number-min-digits 2`
   (catch the `Utsikten 3` short-number absorption the ≥3-digit boost misses) + boost 6. knob 3 is the
   right lever; the visible remaining miss mode is short numbers it never touched. If that crosses the bar,
   it's a much stronger ship; if it plateaus again, knob 3 is maxed and option 1 or 3 stands.
3. **HOLD — bank the finding, keep v6.4.0.** The gain is real but modest and the arc's bar (solve
   digit-ownership) is unmet. The mechanism (long-number boundary signal, cross-lingual) is documented and
   reusable; ship it bundled with the next model change rather than spending a release on +4pp alone.

The lever is understood and the numbers are clean. This is an operator ship/scope call, not a technical
one. Promotion is the operator's act.
