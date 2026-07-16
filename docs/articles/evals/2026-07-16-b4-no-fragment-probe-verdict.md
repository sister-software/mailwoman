# B4 — the NO fragment probe did NOT clear its pre-registered bar

2026-07-16. The 2k falsifier for the Norwegian house-number-licence lever.

**Verdict: the probe did not clear the pre-registered MOVE criterion, and the do-no-harm guard on
the French board drifted the wrong way. Per the config header's own pre-registration, the full 8k
run is NOT auto-warranted. The decision to run it anyway is the operator's — with the honest caveat
below on the threshold.**

The 2k probe cost ~$1–2 of A100 and saved a full 8k run from being launched on a hunch. That is
exactly what the probe-before-fix discipline is for.

---

## The read

Pre-registered in `v3.3.0-no-fragment-probe.yaml`, written before the numbers existed; graded on
board 3 (the NO digit board) against the SHIPPED-v310 baselines registered before the run.

**Board 3 — the target:**

| class              | role             |                 v310 |                v330 (2k) |          Δ |
| ------------------ | ---------------- | -------------------: | -----------------------: | ---------: |
| **bare-street-hn** | **TARGET**       | 0.693 [0.646, 0.736] | **0.710** [0.664, 0.752] | **+1.7pp** |
| bare-pc            | guard (negative) |                1.000 |                    1.000 |       ±0 ✓ |
| street-led-hn      | guard (ceiling)  |                0.968 |                    0.965 |     −0.3 ✓ |
| city-first-hn      | guard (ceiling)  |                0.953 |                    0.953 |       ±0 ✓ |
| pc-first-hn        | guard (ceiling)  |                0.940 |                    0.945 |     +0.5 ✓ |
| slash-hn           | monitored        |                0.650 |                    0.655 |       +0.5 |

The pre-registered bar: _"bare-street-hn rises materially... clear motion, not the full gain. If it
does NOT move at 2k, the licence-transfer hypothesis is wrong and a full run is not warranted."_

**+1.7pp with the two intervals almost entirely overlapping is not clear motion.** The bar is not
met. Every guard held — `bare-pc` stayed pinned at 1.000, the three ceiling classes did not regress —
so there is no trade, but there is also no target win.

**Board 2 — the FR do-no-harm guard drifted:**

| class                |  v310 | v330 (2k) |    Δ |
| -------------------- | ----: | --------: | ---: |
| bare-street          | 0.715 |     0.675 | −4.0 |
| street-particle      | 0.855 |     0.830 | −2.5 |
| admin-street-homonym | 0.517 |     0.465 | −5.2 |
| OVERALL              | 0.733 |     0.716 | −1.7 |

Every French class drifted down. The CIs overlap, so no single cell is a clean violation, but the
_consistency_ of the drift is the concern — 2k of extra fine-tuning is mildly eroding the fr-fragment
win the shard is required to protect. A full 8k run would have more room to amplify that.

## Two reasons not to escalate, and one caveat

1. The target did not clear its pre-registered bar.
2. The French guard drifted the wrong way across every cell.

**The caveat, stated because integrity requires it:** "material move at 2k" was a quantitative
prediction I could not strongly ground. fr-fragment's +50pp was measured at its **8k** final; I do
not have its own 2k-vs-8k trajectory on a board, so I cannot say whether +1.7pp at 2k is "flat" or
"early but real." That is precisely the class of threshold prediction that should not, by itself,
gate a decision — so the call goes to the operator rather than being made by a bar I cannot defend.
What I will not do is _relax_ the bar I wrote in order to launch the 8k myself.

## The likely reason it barely moved — a named hypothesis, not a knob spun

B0 established the mechanism: the failing Norwegian rows have the **street mistagged as a locality**,
and the digit follows it (`Hallingrudveien 32` → locality + postcode). The fix is therefore the same
as the French bare-street polarity fix: teach that a **bare street is not a bare locality** — which
requires the street to appear _without a number at all_, so the model cannot lean on the number.

This shard's `--bare-street-prob` defaults to **0.30**: only 30% of its signal rows are pure bare
streets; the other 70% are `{street} {number}`, a form the model mostly already handles (board 3's
bare-street-hn is already 0.693, not 0.215 like French was). So the shard spends most of its weight
on a class that is not broken and little on the one that is.

**The testable next move is to raise the bare-street ratio** so the shard hits the street→locality
confusion directly, the way fr-fragment did. That is one config knob. Per the treadmill guard I am
not spinning it solo at 2k — it is a hypothesis for the operator or the next shift, to be
pre-registered and probed, not tuned in the dark.

## What stands regardless

- The instrument (board 3) and the recipe (`no-fragment`, tested, split-disciplined) are correct and
  reusable. The probe _worked_ — it gave a clean, cheap read that stopped an unjustified 8k run.
- `bare-pc` holding at 1.000 confirms the counter-distribution does its job: the model did not learn
  to stop emitting postcode to chase the digit. The shard's shape is sound; its ratio is the lever.
- The Norway YAML fix (#1145) is the load-bearing result of the night regardless of this probe —
  Norway now trains at all, and this probe is the first read that could ever have measured it.

## Reproduce

```bash
python3 scratchpad/build-no-fragment-full.run.ts
python3 scratchpad/assemble-no-fragment-overlay.py
# push overlay + config to the volume, then:
modal run -d corpus-python/modal/train_remote.py --config v3.3.0-no-fragment-probe.yaml --resume none
bash scratchpad/read-v330-probe.sh
```
