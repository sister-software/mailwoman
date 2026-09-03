# v4.6.0-admin-surfaces — grade verdict

**Recommendation: DO NOT PROMOTE. The run trades a real +11.0 pp gain on US `country` for the
collapse of the bare-toponym class — 21 net new gated board failures, several placing the answer
thousands of kilometres out. The cause is identified and the extract is worth rebuilding, but this
artifact should not ship in any posture.**

**DECIDED 2026-08-15: NOT PROMOTED.** The operator accepted the recommendation. v4.4.0 remains the
shipped model; nothing in `release.config.json`, the weights cards or the demo moves.

This document is the evidence behind that call. The artifacts are retained — fp32
`f2dbf4a85f845068234a1a565c323682`, int8 `afb8ca11bc1e2952b049d437bba611ef`, both on the Modal
volume — because the next attempt is a re-dose and re-cut of the same recipe, not a fresh design, and
the comparison arm is worth keeping.

## What a retry needs before it is worth GPU time

Both, together. Either alone fails for the reason the other one causes.

1. **#1677 — re-dose `synth-bare-country-v23`.** Weight 1.0 gave its 277 rows **165 repetitions each**
   against 5× for the 53,078-row Spanish extract weighted six times higher. 0.030 puts it at parity.
   The sampler allocates by weight normalised across sources and ignores row count, so weight is not
   dose and nothing in the config or launch output displays the number anyone reasons in.
2. **#1673 — re-cut the ES extract on official-language names.** It teaches English exonyms:
   461 `Balearic Islands` rows against **4** containing `Illes`, and zero `Portopetro`. `spr.name` is
   the wrong column for any non-English locale.

And a discipline this run did without: **pre-register a watch on the adjacent class.** #513 already
records that relabelling one boundary loosens its neighbours, and bare-country/bare-locality are as
adjacent as two classes get. The bare-toponym board rows — `bz-cs-belize-city`, `kh-cs-phnom-penh`,
`tt-cs-port-of-spain`, `bn-cs-bandar-seri-begawan`, `il-cs-tel-aviv-yafo`, `my-cs-petaling-jaya` and
the `*-street-name-*` family — go on the watch list before the run, not after.

## What shipped instead, on the same day

The class this run was built to fix had a cheaper answer. `Intl.DisplayNames` supplies ~5,244 country
surfaces across 280 regions from the runtime's own ICU; folding them into the candidate gazetteer
(#1687) fixed every non-Latin bare-country query — 格鲁吉亚, 沙特阿拉伯, 巴布亚新几内亚, 多米尼加共和国,
布基纳法索 — at **zero** board regressions and no training at all.

That is the retrieval-over-memorisation principle with a receipt: a fact the atlas can hold should be
retrieved, not memorised into weights.

Promote was the operator's call. This document is the evidence.

## The run

`ap-doym9ibZZMBVquBibF3ftz`, from-scratch 60k cosine s42 — the v4.4.0 recipe verbatim — on corpus
`v0.23.0-admin-surfaces`. Completed clean 2026-08-15 06:15 UTC.

|              |                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| final        | 60,000/60,000, `train_loss` 0.6193                                                                           |
| val          | `val_loss` 0.7203, `macro_f1` 0.9198 over 4,096 rows                                                         |
| locale probe | `cross_pollution` 0.00% (DE 0.00 / US 0.00), `locale_acc` 1.000                                              |
| fisher       | artifact written, 2,000 batches — the smoke's `finalize() with zero accumulated batches` crash did not recur |
| fp32         | 157.1 MB, md5 `f2dbf4a85f845068234a1a565c323682`                                                             |
| int8         | 39.4 MB, md5 `afb8ca11bc1e2952b049d437bba611ef`                                                              |

Baseline arm throughout: v4.4.0 fp32, md5 `0f9273a37db14fdd86a6d2c8806f8494`, matching
`release.config.json`. Both arms graded through the identical battery on caches differing only in
`model.onnx`.

## Gate: FAIL — but only one floor is really the candidate's

Spec `v6.0.0-shipped-baseline`, 18 floors, int8-vs-fp32 cap 1.5 pp,
`requires_gazetteer_lexicon: true`, `requires_conventions: "auto"`, `requires_bridge: true`.

| floor              | bar |   v4.6.0 |   v4.4.0 | verdict                            |
| ------------------ | --: | -------: | -------: | ---------------------------------- |
| `us.street_prefix` |  96 | **95.8** | **98.0** | **REGRESSION, −2.2 pp**            |
| `arena.perturb`    |  78 |   **65** |   **65** | **STALE FLOOR — not a regression** |

Everything else passes: `us.postcode` 96.7/94.9, `us.micro` 90.9/85.1, `us.locality` 87.7/74.6,
`us.region` 90.7/87.7, `us.street` 88.5/78.6, `us.street_suffix` 100/92.9, `us.unit_real` 97/95,
`us.po_box_real` 97.6/86.7, `us.intersection_real` 100/98, `us.country_homograph_f1` 85.1/83.1,
`fr.postcode` 99.5/97.9, `fr.house_number` 98.1/94, `fr.region` 79.8/29.9, `fr.cedex_real` 99.1/82.2,
`de.native_locality` 91.6/89.4.

**Quantization is clean.** Every int8-vs-fp32 delta is 0.0 except `fr.region` at 0.2 pp.

### `arena.perturb` is a gate-maintenance defect, not a model regression

The shipped model reads **65** on this floor too and **fails it identically**. The floor of 78 no
longer describes the model it was cut from.

The arena regenerates its 398 cases on every run (`wrote 398 perturbed cases (delimiter-strip,
lowercase, glue)`), so the set has drifted away from the one the floor was cut against while the
number stayed frozen. This is the `v5.3.0-family` failure repeating: a spec whose one tight floor
fails the shipped model, caught the same way — by running the full battery on the baseline itself.

**Do not re-cut this floor as part of a promote.** It needs its own gate revision with a stated
reason, per the no-silent-gate-drift rule.

### The `us.street_prefix` regression is exactly one row

Reproduced identically across two independent control runs: v4.4.0 scores 24 tp / 0 fp / **1** fn on
n=25; v4.6.0 scores 23 / 0 / **2**. Diffing the two encoders over the fixture names it:

```
10 South Dearborn, Chicago, IL 60603
  gold    "South"
  v4.4.0  "South"  ✓
  v4.6.0  undefined  ✗
```

One row of twenty-five, and a coherent one: `Dearborn` carries **no street suffix**, so the leading
directional has no suffix anchor to lean on. v4.6.0 declines to call it a prefix.

That reading is strengthened by the board, where v4.6.0 newly passes a whole family of
directional-bearing street names — `george-street-north`, `bloor-street-west`, `yonge-street-north`,
`wellington-street-west`, `robson-street-west`, `ocean-parkway-south`. The model has shifted how it
treats directionals: better on trailing ones attached to a full street name, worse on a leading one
with nothing after the name.

## Board: 329/352 gated vs the shipped model's 350/352 — **21 NET NEW FAILURES**

**This section replaces an earlier reading of mine that was wrong, and wrong in the direction that
would have mattered most.** I first reported "+15 rows, zero regressions" after reading only the
tail of the board output, where the promote-flag block sits. The gated pass/fail header is printed
ABOVE that block and I truncated it away. Both halves are true and only one of them is decisive.

|                                   | shipped v4.4.0 |      v4.6.0 |
| --------------------------------- | -------------: | ----------: |
| gated cases passing               |    **350/352** | **329/352** |
| gated failures                    |              2 |      **23** |
| improvement_targets newly passing |              3 |          18 |

v4.6.0 flips fifteen tracked rows to passing **and breaks twenty-one gated ones.** The trade is
badly negative.

### The regression has one shape: bare toponyms lose their span

**Bare street names return `street: null`** — `Avenida Alvear` (AR), `Rua Augusta` (BR _and_ PT),
`King Street East` and `King Street West` (CA), `Madison Square West` (US).

**Bare city names drop or truncate**, and the coordinate follows them off the planet:

| case                        | v4.6.0                 |      error |
| --------------------------- | ---------------------- | ---------: |
| `bn-cs-bandar-seri-begawan` | locality `Bandar Seri` |   4,871 km |
| `bz-cs-belize-city`         | locality `null`        |      65 km |
| `il-cs-tel-aviv-yafo`       | locality `Tel`         |   2,586 km |
| `kh-cs-phnom-penh`          | locality `null`        | unresolved |
| `my-cs-petaling-jaya`       | locality `null`        | unresolved |
| `tt-cs-port-of-spain`       | locality `null`        |   6,535 km |
| `intl-beirut-lebanon`       | —                      |   9,211 km |
| `bare-region-georgia`       | —                      |  10,089 km |

### The likely cause is the extract that produced the headline win

`synth-bare-country-v23` is 277 rows at dose 1.0, and the sampler allocates draw share **by weight
normalised over sources, not by rows × weight** — so those 277 surfaces repeat roughly twenty times
an epoch. The extract teaches exactly one lesson: _a bare capitalised name is a `country`._

US `country` +11.0 pp and the collapse of the bare-locality and bare-street classes are the same
event seen from two sides. The model learned the lesson too well and generalised it over every bare
toponym. `bare-region-georgia` landing 10,089 km out is the tell — the row the bare-country work was
supposed to help.

This is the base-consistency lesson (#511) in a new costume: a small extract at high effective dose
outvoting a much larger base, and the visible win arriving with an invisible bill.

## What the corpus additions bought

Per-locale regression check, matched fp32 batteries:

| tag         | us                          | fr                 |
| ----------- | --------------------------- | ------------------ |
| **country** | 59.5 → **70.5** (**+11.0**) | 45.1 → 49.8 (+4.7) |
| street      | 86.2 → 88.5 (+2.3)          | 96.8 → 95.6 (−1.2) |
| po_box      | 67.9 → 70.4 (+2.5)          | 100 → 100          |
| region      | 92.8 → 90.7 (−2.1)          | 82.6 → 80.0 (−2.6) |
| locality    | 88.5 → 87.7 (−0.8)          | 95.3 → 95.4 (+0.1) |

Plus adversarial exact-match 61.2 → **67.3** (+6.1) and cross-locale macro spread 15.7 → **10.1 pp**,
i.e. less inter-locale interference.

**`synth-bare-country-v23` is the clear win**: +11.0 pp on US `country`, the largest single movement
in the run, exactly the class it was built for (#1651's parse half).

FR macro-F1 reads −5.0 but that is an averaging artifact — `unit` appears in the FR column at 0.0%
where it was previously absent, while FR micro moved −0.4 and the unit floor's own leg reads 97.0
against a 95 bar.

## Acceptance test: FAIL, on the pre-registered criterion

Only one of the two named rows was ever live. **`gb-op2-st-margarets-hope` already passed on the
shipped model** when re-measured at 06:00 UTC — most likely fixed by #1662's dominance race — so it
is not creditable to this run.

The live row, `es-op3-southeast-portopetro`, criterion registered before the candidate existed:
_passes iff the parse emits `locality: "Portopetro"` AND `region: "Illes Balears"`; partial credit is
a FAIL._

```
Southeast, Carrer Passeig d'es Port, 15, 07691 Portopetro, Illes Balears, Spain

v4.4.0   locality "Illes Balears"   street "Portopetro"   venue "Southeast"   country "Spain"
v4.6.0   locality "Portopetro" ✓    street "Southeast"    region — ✗          country —
```

**The locality moved and the region did not appear** — verbatim the partial-credit case registered as
a failure. The extract taught the tail without teaching the boundary. v4.6.0 additionally drops
`country: "Spain"` and mislabels the venue as street on this row.

The cause is already filed as **#1673**: the ES extract teaches **English exonyms**. It contains 461
`Balearic Islands` rows and **4** containing `Illes`, and zero `Portopetro`. The model was asked to
recognise a region surface it had effectively never seen. This is a fixable extraction defect, not a
failed hypothesis about the trailing-region extract.

## Recommendation

1. **Do not promote, in any posture.** This is not a D-rule gating question. 21 gated board
   failures with multi-thousand-kilometre coordinate errors on bare city names is not a regression
   to gate behind a flag; it is an artifact to rebuild.
2. **Fix #1673 and re-cut the ES extract on official-language names**, then rerun. The acceptance row
   is one surface away, and the mechanism is understood.
3. **File the `arena.perturb` floor for its own gate revision.** It fails the shipped model; leaving
   it stale means every future candidate carries a phantom failure.
4. **Re-dose `synth-bare-country-v23` before the next run.** 277 rows at dose 1.0 repeat ~20× an
   epoch under the per-source sampler, and they taught "bare capitalised name → country" strongly
   enough to erase the bare-locality and bare-street classes. The mechanism works — that is what
   +11.0 pp shows — but the dose is the change, and the next attempt should carry a pre-registered
   watch on the bare-toponym board rows, per the #513 adjacent-class rule.
5. **The measurement lesson.** The board's gated pass/fail header prints ABOVE the promote-flag
   block. Reading the tail alone shows the flips and hides the breakage. Read `gated cases pass`
   first, every time.

## Standing caveat

> **STRUCK 2026-08-19 — no longer true, and it was true only for one more day after this was written.**
> `gazetteerPrior` became default-ON in the harness on **2026-08-16** (`harness.ts`'s `priorDepsFor`:
> "only an explicit `false` withholds the prior"), so the board grades WITH the prior. The numbers in
> this document stand — they were measured under the caveat — but do not carry the caveat forward to a
> later reading. It survived in the type's own docstring until ba515ebdc and was quoted as live in #1684.

~~The gauntlet grades **FST-less** (#1497, corroborated independently by #1669): `parseForGeocode`
calls `classifier.parse` with no `fst` key and `GeocodeClassifier` cannot express one. Both arms are
crippled identically so every comparison here holds, but the board understates both.~~
