# R5 — dependent_locality aliveness outside GB, and the US instance

Hierarchy campaign R5, opened 2026-08-01 at the operator's priority. Two questions the campaign
has been carrying as an assumption since the placetype-evidence doc was written:

1. Is `dependent_locality` **contextually dead** outside GB/NZ, as the doc asserts?
2. Is there a **per-country suppression** that would have to be lifted before a US instance works?

## Both answers are in, and both overturn the doc

**There is no per-country suppression anywhere in the runtime.** A full read of the conventions,
decoder, resolver, normalize, kind-classifier, phrase-grouper and geocode paths finds exactly one
hard emission mask (`-1e9`) — FR `street_suffix` — and `dependent_locality` appears in no
`forbiddenTags` row in either the TS table or its Python training mirror. `componentsSupported`
omits the tag for en-US, but nothing reads that field to mask emissions; its only consumer
validates the policy registry. The en-US omission is documentation, not enforcement.

**The tag is dead in the MODEL, and dead uniformly — not per-country.** Raw pre-prior logits
(`parseWithLogits`) put `B-dependent_locality` at rank 11–15 of 25 everywhere, including the GB
cases that parse correctly today:

| case         | locale | raw B-dependent_locality | top raw label  |
| ------------ | ------ | ------------------------ | -------------- |
| "Shoreditch" | en-GB  | 0.14% (rank 14)          | locality 31.3% |
| "Nine Elms"  | en-GB  | 0.13% (rank 15)          | locality 23.4% |
| "Astoria"    | en-US  | 0.74% (rank 13)          | street 15.7%   |
| "Park Slope" | en-US  | 0.65% (rank 14)          | locality 17.1% |
| "Manhattan"  | en-US  | 0.18% (rank 11)          | locality 91.9% |

US surfaces carry MORE raw dependent-locality mass than the GB ones that work. The shipped GB
behaviour is not the model preferring the tag — it is the pair index at δ=10 clearing a deficit the
en-GB model card already measured as "large but UNIFORM (~7.0 logits mean)". The origin is a
training-side class weight of 0.3 on `B/I-dependent_locality` carried from v0.5.1 through v0.8.0
("penalize hallucination of rare tags"), since corrected to 1.0 but not retrained into the shipped
lineage.

**Therefore the US instance was never gated on aliveness or on conventions. It was gated on the
artifact.** Confirmed end-to-end: a US pair index built from WOF (49,033 pairs; boroughs AND
neighbourhoods, with `borough` admitted as a parent placetype because WOF parents US
neighbourhoods to the locality) dropped beside the en-US weights flips all three probes:

| input                                                     | before                                                 | after                                                   |
| --------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| `31-01 Ditmars Blvd, Astoria, Queens, New York, NY 11105` | locality=Queens, venue=Astoria, **"New York" dropped** | dependent_locality="Astoria, Queens", locality=New York |
| `350 5th Ave, Manhattan, New York, NY 10118`              | locality=Manhattan, **"New York" dropped**             | dependent_locality=Manhattan, locality=New York         |
| `123 Main St, Park Slope, Brooklyn, NY 11215`             | locality=Park Slope, **"Brooklyn" dropped**            | dependent_locality=Park Slope, locality=Brooklyn        |

Note the silent information loss in the "before" column: the second admin level was not mislabeled,
it was **discarded**. That is a live US recall defect today, independent of any tag question.

## What is NOT yet established — the pre-registered bars

The three positives above are hand-picked. A 49,033-entry US index is a far larger ambiguity
surface than GB's curated set, and US neighbourhood surfaces are heavily homonymous with street and
venue words ("Park Slope", "Midtown", "Riverside", "Fairview"). Nothing ships until:

- **B-R5.1 (no gauntlet regression).** Full gauntlet, graded through per-country overlays
  (`caseCountry` — a base-only harness reproduces the 2026-08-01 instrument artifact), with the US
  index present vs absent. Bar: **zero newly-failing gated cases.**
- **B-R5.2 (venue-confound floor).** A held-out US confound board — neighbourhood surfaces opening
  venue names, the law-1 class R4b boarded for London. Bar: **≤2% dependent-locality false
  positives**, the shipped GB floor.
- **B-R5.3 (positive side).** A held-out US board of real borough/neighbourhood addresses, graded
  for dependent-locality emission AND correct locality assignment. Bar: **≥70% tag-correct**, the
  order the GB δ-sweep cleared.
- **D-R5.4 (disclosure).** The browser path's `detectPairIndexCountry` falls back to `us` for any
  bare Latin query with no postcode — so shipping a US index means unlabeled queries take US pair
  bias by default, where today they take none. Measure and report what that does to the GB and
  bare-name boards; it is a packaging consequence, not a bug, but it must be stated before ship.

Failing B-R5.1 or B-R5.2 stops the ship regardless of how good B-R5.3 looks.

## The readings — all four bars

Measured 2026-08-01 with the experimental US index (49,033 pairs) dropped beside the en-US weights,
against the same artifacts removed.

- **B-R5.1 PASS.** Full gauntlet, per-country overlays: `VERDICT: PASS — clear to ship` with the
  index present, and the xfail set is **identical** to the baseline run without it (same 5 tracked
  xfails, same `comma-drop|181 Rue du Chevaleret` xfail-now-passes note). Zero newly-failing gated
  cases.
- **B-R5.2 PASS.** US law-1 confound board — 60 held-out rows where a US neighbourhood surface
  OPENS a venue name (35 directional-class drawn from 4,819 available, 25 short common-word), each
  in a real street address under its true parent: **0/60 dependent-locality false positives
  (0.0%)** against a ≤2% bar. The segment-mode gating that holds for London holds here.
- **B-R5.3 PASS.** US positive board — 60 rows sampled from 31,474 state-resolved WOF pairs:
  **60/60 emit, 60/60 tag-correct (100%)**, and 60/60 assign the parent to `locality` correctly.
  Disclosure: every row's pair is necessarily IN the index, so this measures the mechanism's
  efficacy where the gazetteer has data — not generalization to unknown surfaces. Retrieval-augmented
  by design; an unknown pair gets no bias and falls back to today's behaviour.
- **D-R5.4 disclosed, and it is clean.** Shipping a US index means the browser's
  `detectPairIndexCountry` fallback routes bare Latin postcode-less queries to `us`, where they take
  US pair bias instead of none. Probed against the GB canonical set — Shoreditch/London,
  Nine Elms/London, Clapham/London, Camden/London, Didsbury/Manchester — the US index **misses all
  five** while the GB index hits all five. The fallback does not manufacture GB bias.

## Verdict, and what is NOT being done unilaterally

The mechanism is proven and every pre-registered bar passed. Three things land from this rung:
the diagnosis above, the `us` entry in the pair-index command's `PROBE_PAIRS_BY_COUNTRY` (its guard
correctly refused to build a US index without one), and both boards as reusable instruments under
`$MAILWOMAN_DATA_ROOT/scratch-r5-us/`.

**Shipping `pair-index-us.bin` inside `@mailwoman/neural-weights-en-us` is left as an operator
decision, not taken here.** The bars were the technical gate and they passed; what they do not
settle is that this changes DEFAULT parse output for the flagship package — every US address with a
neighbourhood or borough line starts emitting `dependent_locality` where it previously emitted
nothing and silently dropped the second admin level. That is an improvement and a behaviour change
at once, it wants a model-card note and a version, and the GB/NZ precedent (a locale overlay
package nobody installs by accident) does not cover it.

## The finding worth carrying past this rung

The doc's claim that the US instance is gated on "the tag's _contextual_ aliveness for US" is
**wrong, and was wrong for GB too**. The tag is dead uniformly — the en-GB model card had already
measured the deficit as "large but UNIFORM (~7.0 logits mean)" — and no locale's dependent-locality
emission comes from the model preferring it. GB emits because an artifact clears a uniform deficit;
the US does not emit because no artifact exists. Every other locale in the campaign's wave 2–4 list
(FR lieu-dit, ES pedanía, BR bairro, MX colonia, and the borough instances in Paris/Tokyo/Amsterdam)
is therefore an ARTIFACT question, not a training question — which moves them out of R5's
training-gated column and into the same decode-time lane R2–R4b already ran.

## R5 follow-on — the OTHER projections, and a three-way split

Prompted by the operator's note that the projection table covers far more than boroughs and that
probe set 2 was built to exercise it. Measuring the rest of the table splits the campaign's targets
into three classes that want three different mechanisms — the useful generalization of R5's finding.

**Class 1 — enumerable administrative (`borough`, `neighbourhood`, `macrohood`, `microhood` →
`dependent_locality`).** Closed, finite, already in WOF. **Artifact-gated**, and R5 is the proof:
build the index and the tag emits. Everything R2–R5 did lives here.

**Class 2 — open-class venue names (`venue` → `venue`).** NOT artifact-gated, and the measurement
says so plainly: of the 40 probe-set-2 improvement targets carrying an expected venue string, only
**8 (20%) exist in poi.db at all** — and most of those 8 are wrong-country homonyms ("East West"
[US] for a London row, "Ginza" [FR] for a Dhaka row), so true coverage rounds to near zero. The
residual is "A Bar with Shapes for a Name", "Art4Space", "B.indulged", "Paws 4 A Rest", "Tricky's @
The Tolgus Inn" — small, new, deliberately odd commercial names that no gazetteer enumerates. **No
retrieval artifact can supply what does not exist in any source.** This class is where the model
has to generalize, which is why #1366's fine-tune shape was right even though V1 missed, and why its
three named residual mechanisms are the actual work.

**Class 3 — compositional sub-venue structure (`building`, `campus`, `wing`, `concourse`, `arcade`,
`enclosure`, `installation` → `venue` / `unit`).** Neither of the above: these are PATTERNS, not
names — a small closed designator vocabulary times an open numbering. It was **completely
untested**: before this rung the gauntlet contained zero `unit:` expectations and one line matching
any sub-venue term.

Measured behaviour, and the reason for it:

| input                                                   | today                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| `Building 43, Googleplex, 1600 Amphitheatre Parkway, …` | correct — `unit=Building 43, venue=Googleplex`               |
| `Terminal 5, Heathrow Airport, Hounslow, TW6 2GA`       | `locality="Terminal"`, `house_number=5`, **airport dropped** |
| `Gate 12, Terminal 2, Manchester Airport, …`            | `locality="Gate"`, `house_number=12`                         |
| `West Wing, St Thomas' Hospital, …`                     | `locality="West Wing"`, hospital folded into `street`        |
| `Concourse B, O'Hare International Airport, …`          | `street="O'Hare International Airport"`                      |

The asymmetry is not random. The span proposer's designator lexicon
(`neural/span-proposer-lexicon.ts`) reads `codex/us/unit-designator.ts`, which is **USPS Publication
28** — a mail-delivery standard. It stocks BUILDING, HANGAR, PIER, LOBBY because mail is delivered
there, and omits TERMINAL, GATE, CONCOURSE, WING because mail is not. The postal source is correct
about postal reality and silent about venue interiors — the same source-shaped gap the
dependent-locality arc hit when PPD turned out to have no US analogue.

A probe extending the designator set moved `Terminal 5` → `unit="Terminal 5", locality="Heathrow
Airport"` and `Gate 12` → `unit="Gate 12"`, but split `Concourse B` into `unit=Concourse` +
`venue=B` and left the trailing-designator `West Wing` untouched. **Real lever, not a clean sweep** —
and it is a default-on change to unit parsing with obvious confound risk (GB street names ending in
`-gate`, industrial estates literally named "Terminal"). It gets its own pre-registered board before
anything ships; the experiment was reverted.

**Landed here instead: the instrument.** Six sub-venue cases join the gauntlet — five
`improvement_target` and one **gated control** (`Building 43`, the half that already works, locked
so a future designator change cannot silently regress it). The class now has coverage it has never
had, which is the precondition for fixing it.

## Ship decision: TAKEN (operator, 2026-08-01) — "we don't mind change if the result is better"

`pair-index-us.bin` ships inside `@mailwoman/neural-weights-en-us`: 49,033 WOF-sourced pairs,
1,323,912 bytes, md5 `5fd4a6cca54c6bf9b121cb2fcd759f7a`, δ=10 / β=5 (the exact pair the bars were
measured at, inherited from GB rather than re-swept because the classifier deficit is uniform).

**The non-regression guarantee, verified rather than assumed.** The concern with a default change
to the flagship package was ordinary US addresses. They are untouched, and the reason is structural:
the prior fires only when child AND parent are BOTH present in the query. `Astoria, NY 11103` — a
USPS-valid city/state/ZIP with no parent in the string — keeps `locality=Astoria`. That is why the
19 candidate rows in the US golden boards needed **no edit**; both halves are now gated gauntlet
cases (`us-r5-park-slope-brooklyn`, `us-r5-astoria-no-parent-unchanged`).

**Two latent bugs surfaced by the packaging work, both fixed here:**

1. `scripts/copy-weights.ts` typed its pair-index config as `{source, delta}` and passed only
   `--delta`. The release path would therefore have rebuilt `pair-index-gb.bin` **without** β=5 and
   **without** the R2/R3/R4b borough and London pair sources — a quietly degraded artifact whose
   bytes no longer matched the md5 in the model card. It never shipped because CI sets
   `MAILWOMAN_SKIP_WEIGHTS_COPY` and the operator publishes the dev-linked binary, but one local
   `yarn release` would have produced it.
2. `neural/test/weights.test.ts` symlinked every en-us file into a temp package, then wrote a
   1-entry stub named `pair-index-us.bin`. `writeFileSync` follows symlinks — so the moment en-us
   shipped a real one, that test would have overwritten the 49,033-pair production artifact in
   place, silently, with every later test in the run grading against the corrupt file. Same
   write-through-the-symlink hazard AGENTS.md documents for `fs.copyFile` in the publish path.

**Remaining, operator-side:** stage the artifact to Hugging Face before dispatching the release
(`mailwoman release hf … --pair-indexes neural-weights-en-us/pair-index-us.bin,…`) — CI fetches it
from the bucket and the preflight now names it, so an unstaged file fails loud rather than
publishing an empty package. The demo repoint (`STAGED_PAIR_INDEX_COUNTRIES`, `stagePairIndexes`)
stays a separate follow-up per the country-evidence-layer runbook; adding `us` there is what turns
on US pair bias for bare postcode-less browser queries (D-R5.4).
