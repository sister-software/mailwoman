# T1a — the regression cross-tab: the falsifier fired, and the metric can't see why

**Question (pre-registered, 2026-07-16 review Tier 1a):** the span decode nets ~0 overall but +23.8pp on
Paris, so it is losing somewhere. Name the class before shipping. Pre-registered kill condition: _"if
the regression class is 'street hallucinated where none exists', that's a NEW failure mode and the flag
stays off-by-default."_

**Verdict: the kill condition is met. The flag stays OFF by default.**

The span decode invents streets on inputs that have none — a failure class the shipped decode does not
have to this degree, and one that **every street metric in the arc is structurally incapable of
measuring**.

:::caution[Corrected 2026-07-16, after publication — read §4.1 before quoting a rate]
This doc first said the span decode hallucinates **"58% more often"** (12/54 → 19/54). That framing
overstates what n=54 can support: the two intervals overlap, and McNemar on the paired discordants
(11 vs 4) gives **p = 0.12**. The **rate difference is not established**. What IS established is that
the 11 new hallucinations are real, individually inspectable failures — `New York, NY` → street=`new
york` is not a statistical claim — and the pre-registered condition turns on the failure CLASS
existing, not on its rate being significantly worse. The verdict stands on those grounds. The rate
question is settled by the T1c fragment board, whose `bare-locality` class carries n=400 (±4.0pp).
Caught by the same discipline that produced the finding; left visible rather than quietly edited.
:::

|         |                                                                               |
| ------- | ----------------------------------------------------------------------------- |
| Probe   | `scratchpad/t1a-regression-crosstab.mjs`                                      |
| Models  | v264 (shipped, md5 3e534072) vs v301 (span head, md5 add5b344)                |
| Config  | production (query-shape prior fed — ffcb8e96)                                 |
| Fixture | `parity-corpus.triaged.jsonl` — 321 live, 267 street-gold, **54 street-free** |

---

## 1. The tie is not a tie — it's 17-for-17 churn

|                  | v301 seg ✓ | v301 seg ✗          |
| ---------------- | ---------- | ------------------- |
| **v264 token ✓** | 137        | **17 ← regression** |
| **v264 token ✗** | 17         | 96                  |

Net **+0** on street rank-1 (matching the aggregate: 154/267 both ways). But the decode **changes 34
fixtures** to get there. An aggregate tie was hiding a full third of the street corpus moving.

The within-model cross-tab (v301 token × v301 seg) is the same shape: +1 net, 18 fixed / 17 broke.

## 2. The win class is exactly the thesis

All 17 are the target class — the token decode is **too timid** and the span decode recovers the phrase:

```
FR "Rue de Paris"             v264=""                  seg="rue de paris"            ✓
FR "Allée Victor Hugo"        v264=""                  seg="allée victor hugo"       ✓
FR "Esplanade Méditerranée"   v264=""                  seg="esplanade méditerranée"  ✓
ZZ "Foostraße"                v264=""                  seg="foostraße"               ✓
FR "Place Sohier Vervins"     v264=""                  seg="place sohier"            ✓
FR "Avenue Aristide Briand"   v264="aristide briand"   seg=+prefix                   ✓
NO "Maria Dehlis vei 15"      v264="vei"               seg="maria dehlis vei"        ✓
SE "Gamla Varmdovägen 6"      v264="varmdovägen"       seg="gamla varmdovägen"       ✓
```

Five of them are cases where **the shipped model emits nothing at all**. The span decode is doing the
job it was built for, on the class it was built for.

## 3. The regression class is systematic — 8 of 17 are digit-eating

```
CZ "Korunní 810, Praha"                gold="korunní"                 seg="korunní 8"
ES "Carrer d'Aragó 155 08011"          gold="carrer d'aragó"          seg="carrer d'aragó 1"
FR "4 Cité Du Cardinal Lemoine 75005"  gold="cité du cardinal lemoine" seg="… lemoine 7"
NO "Øvste Skogen 121"                  gold="øvste skogen"            seg="øvste skogen 1"
PL "Ulica Strzelecka 12"               gold="ulica strzelecka"        seg="ulica strzelecka 1"
PL "Żorska 11, 47-400"                 gold="żorska"                  seg="żorska 1"
SK "Divadelná 41/3, Trnava"            gold="divadelná"               seg="divadelná 4"
SE "Ångermannagatan 80, Vällingby"     gold="ångermannagatan"         seg="ångermannagatan 8"
```

**The street span swallows the first digit of the adjacent house number or postcode** — never the whole
number, always the first piece. The tokenizer splits numbers into digit pieces (`▁8|1|0`), and the
segment ends one piece late. Eight locales, one shape. This is not noise; it is a boundary off-by-one at
a digit run, and it looks fixable independently of everything else here.

Three more are truncations (`"bulevardul iuliu maniu"` → `"bulevardul i"`, cutting mid-word), which is
the same boundary error in the other direction.

## 4. The falsifier: hallucination on the 54 rows nothing measures

Every street harness in the arc filters to fixtures with `expect.street` — `seg@1`, `oracle@5`,
`oracle@10`, the Paris board, all of them. So a spurious street on a locality-only row is invisible **by
construction**. 321 live fixtures, 267 street-gold ⇒ **54 rows where this hides**.

| decode                    | emits a street on a street-free row | 95% Wilson     |
| ------------------------- | ----------------------------------- | -------------- |
| v264 token@1 (shipped)    | 12/54 = 0.222                       | [0.132, 0.349] |
| v301 token@1              | 12/54 = 0.222                       | [0.132, 0.349] |
| **v301 seg@1 (the flag)** | **19/54 = 0.352**                   | [0.238, 0.485] |

**11 new hallucinations introduced, 4 removed. Net +7.** They are not marginal:

```
US "New York, NY"          → street="new york"
US "New York, New York"    → street="new york"
NL "Rozenburg"             → street="rozenburg"
ZZ "new south wales aus"   → street="new south wales"
AU "BOOM"                  → street="boom"
US "philadelphia museum of art" → street="philadelphia museum of art"
```

Six are pure locality/postcode rows (indefensible). Five are venue rows (softer — a venue read as a
street is arguable). Both partitions get worse: pure +6/−3, venue +5/−1.

**Not a grammar defect.** The exported grammar carries explicit `start_transitions`, `end_transitions`,
and an `O` segment type at index 0 — an all-`O` parse is representable and cheap to express. The decode
chooses street anyway. This is **learned miscalibration**, not a structural hole. (Checked, because the
structural story was the attractive one.)

### 4.1 What n=54 can and cannot support

The intervals above **overlap**. Treating the two rates as independent samples, 0.222 vs 0.352 is not a
distinguishable difference at this n. The right test is paired — same 54 rows, two decodes — so McNemar
on the discordants:

```
b = 11 (v264 silent, seg hallucinates)      exact two-sided p = 0.1185
c =  4 (v264 hallucinates, seg silent)      => direction consistent, NOT significant at 0.05
```

So: **the rate difference is not established.** Anyone quoting "+58%" from this page is quoting noise
with a decimal point — the same sin the fragment board exists to stop, committed here first.

Three things survive that arithmetic, and they are what the verdict rests on:

1. **The 11 failures are real, not inferred.** `New York, NY` → street=`new york` is a defect you can
   read, reproduce, and fix. Its existence is not a statistical claim and no p-value bears on it.
2. **The pre-registered condition turns on the class, not the rate.** It reads: _"if the regression
   class is 'street hallucinated where none exists', that's a NEW failure mode and the flag stays
   off-by-default."_ The class exists. The condition fires as written.
3. **Precaution is asymmetric here.** The flag is opt-in either way; the cost of holding it is a
   consumer types a flag, and the cost of shipping it wrong is silent street hallucination in a
   geocoder. At p=0.12 you do not get to round toward the convenient answer.

**The rate question is answered by T1c, not by this page.** The fragment board's `bare-locality` class
runs n=400 — a ±4.0pp interval at p≈0.22, versus ±10.9pp here. That is the measurement; this was the
detection.

## 5. One property, three consequences

The win class, the digit-eating, and the hallucination are not three findings. They are one:

> **The span decode is over-eager to emit and extend a street segment.**

- Where a street exists and the token decode was too timid → **it wins** (+17).
- Where the street boundary abuts a digit run → **it over-extends** (+8 of the 17 regressions).
- Where no street exists at all → **it invents one** (+11 hallucinations).

Net on the rows the metric scores: **+0**. Net on the rows the metric drops: **−7**. Counting both, the
flag is **net negative** — and the arc has never once measured it that way.

## 6. Consequences

**For the ship decision (#42): the flag stays OFF by default.** The pre-registered kill condition fired
on its exact terms. The decode's value on the target class is real and large — five fixtures where the
shipped model says nothing — but it is bought with a hallucination rate the street metric cannot price.
A consumer that wants the k-best list can opt in; nothing gets it by default until §5's over-eagerness
is separated from §2's win.

**For the instrument:** the street metric's `expect.street` filter is a blind spot that **flatters the
span decode specifically**, because the decode's failure mode lives exactly in the rows the filter drops.
This is the third instrument failure in one arc (Phase 1's starved channels, Phase 4a's dark resolver,
now this), and the pattern is the same every time: _the harness could not see the thing that was wrong._
`baselines.json` cannot catch it either — a baseline over a filtered corpus is self-consistent forever.
The two-board structure (#43) needs a third question: **what does the board not score?**

**For T2 (the BAN shard) — this is the strongest evidence yet.** The hallucination and the bare-fragment
failure are the same miscalibration seen from opposite sides. The corpus is thin on bare street fragments
and thick on bare localities; the BIO head learned "bare toponym → locality" (the §2 prior that starts the
arc), and the span head, trained on the same corpus, learned an over-eager street segment that fires on
bare toponyms **regardless of whether one is there**. Both heads are miscalibrated on the same axis, in
opposite directions, from the same missing data. A shard carrying real bare streets and real bare
localities is the one intervention that speaks to both.

---

**Reproduce:** `node scratchpad/t1a-regression-crosstab.mjs` (writes per-fixture records to
`scratchpad/t1a-crosstab.json`).
