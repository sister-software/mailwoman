# MCP romp, part 1 — what `Of` and `to` surfaced

Two lookups, run through `mwdev_lookup` against the live lab artifacts. Both started as casual probes
("testing something", "I suspect this will have bad results") and both turned up something worth a second
look.

## Read this first: what state these findings describe

**Everything below is measured against artifacts that may reflect PARTIAL WORK.** Several of the arcs that
produced them are mid-flight, and a finding here is a description of one build, not a verdict on a design.
Specifically:

| Artifact                       | Identity                                       | Note                                                                                                  |
| ------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `wof/admin-global-priority.db` | built 2026-08-04                               | carries **no `layer_manifest`** — it predates the contract, so it cannot say which recipe produced it |
| `wof/candidate.db`             | symlink → `candidate-global-2026-08-15-icu.db` | also unmanifested; the `-icu` suffix suggests an in-progress fold change                              |

Neither artifact can state its own provenance, which is the exact gap phase 3 closes going forward. So
where this document says "the gazetteer does X", read it as "this build does X" — a rebuild may already
have changed it, and there is currently no way to tell from the file.

Two further honesty markers used throughout:

- **observation** — a command produced it, and the command is shown.
- **inference** — the evidence supports it, nothing measured it directly.
- **falsified** — I proposed it, tested it, and it was wrong. Kept in, because the wrong turns are the
  cheapest part of the report to skip and the most expensive to repeat.

---

## Part 1 — `Of`

### The question

`Of` is a real district and town in Trabzon Province, Turkey. It is also an English function word, which is
what made it worth probing.

### What the sources say

**WOF extracts** (`source: "wof"`), unscoped: two exact-name rows, plus a long tail of names merely
_containing_ the token — `City of Port of Spain`, `Isle of Grain`, `Municipality of the County of Kings`,
17 US postcodes matching on `alt_names`, and `The place of impact of the spear` (IR), which is a genuine
WOF row.

**Mechanism (observation):** the FTS5 index runs token-AND over `name + alt_names`, and **`of` is not a
stopword**. A single-token query for a common function word therefore retrieves every multi-word name
containing it.

**Candidate table** (`source: "candidate"`, the resolver's actual path): exactly **2 rows**. It keys on
`name_key`, an exact fold, so `Isle of Grain` folds to `isle of grain` and never enters the set. The
64-row difference between the two sources is the expected consequence of exact-key lookup versus token
matching — **not a build gap.**

|               | WOF source                               | Candidate              |
| ------------- | ---------------------------------------- | ---------------------- |
| Route         | FTS5 token-AND over `name` + `alt_names` | exact `name_key` probe |
| Rows for `Of` | 66 row-hits across 6 extracts            | 2                      |

### The finding: a tie the ranker cannot break

Both candidate rows carry **identical population (44,212)** and therefore identical `referential`
(0.392759559505463), because `referentialFromPopulation` is a pure function of population.

| Name | Placetype | `spr_id`      | Population |
| ---- | --------- | ------------- | ---------- |
| Of   | locality  | 8114738869649 | 44,212     |
| Of   | county    | 8837168432019 | 44,212     |

The locality's `parent_id` **is** the county, so this is a seat/district pair — a duplicate, not two
competing places. With `neg_rank` equal to the bit, their order fell out of the SQL scan: which one a bare
`Of` query resolved to was decided by storage layout rather than by data.

### Root cause, and a correction to my own first answer

I initially reported this as a WOF data property. **It is not.** Both ids are ≥ 8e12, which is
`OVERTURE_ID_BASE` — Turkey has no WOF repo cloned, so it is served by the Overture `divisions` backfill.
`fold-overture.ts` copies `d.population` per row with no parent→child propagation, so the duplication
arrived from Overture's own data.

WOF's own `Of` is **[890463199](https://spelunker.whosonfirst.org/id/890463199)** — one county, population
**31,951**, no seat-town duplicate at all.

|            | WOF 890463199      | This gazetteer (Overture) |
| ---------- | ------------------ | ------------------------- |
| Rows       | 1 county           | county + locality         |
| Population | 31,951             | **44,212 on both**        |
| Parent     | 85679383 (Trabzon) | 8474473525031             |

**This is the clearest "partial work" signal in the document.** The discrepancy exists because TR was never
pulled from WOF. It is an acquisition gap, not a modelling error, and it closes the moment
`whosonfirst-data-admin-tr` is synced.

### What shipped, and what is still unverified

A **seat preference** now breaks the tie: on an exact `neg_rank` tie, a `locality` carrying a _real_
population outranks other placetypes. Both checks are required and were measured, not reasoned:

- A plain "finer placetype wins" moved the top slot on **11,377** keys, of which only **722** were the
  seat/district duplicate. The rest were contests between distinct places — 2,885 `locality → neighbourhood`
  (a bare city name losing to a same-named hood), 2,973 `region → county`, 2,662 `postalcode → locality`.
- **7,179 of the 11,377** sat at population 0, where a tie means _no evidence_, not equal evidence.
- Narrowed, the term moves **3,896** top slots, every one promoting a populated place over a same-population
  duplicate.

**UNVERIFIED, and this matters.** The 3,896 is scope at the **ranker**. The 558-row regression board is
byte-identical before and after, and three inverted probes — the term itself, `compareReferential`, and the
candidate `ORDER BY` — changed nothing end-to-end on four inputs the sweep says move. A deliberate `throw`
confirmed the harness reads the edits, so the pipeline decides those answers **downstream of candidate
ordering**, somewhere not yet identified.

### A hypothesis I had wrong

I expected the 14 two-source countries (Overture + GeoNames) to _be_ this tie population. **Falsified:**
769,906 tied groups are single-source against 27,729 cross-source, and most of the latter are
cross-_country_ name collisions, since `name_key` groups globally. The two problems are largely independent.

---

## Part 2 — `to`

### The FTS route: the stopword problem, larger

`to` returns **976 row-hits** across the extracts. Same mechanism as `Of`, more of it. The rows that come back
first are genuine — `Tô` (BF), `Tó` (PT), `To` (NO ×3) — so bm25 ranks exact-ish matches sensibly; the 976
is the tail.

### The candidate route: a different and more interesting failure

**19 rows** under key `to`, across 19 distinct places. The tool's own note flags the shape:

> Top row's stored name is `"Toledo"`, not the surface queried. Top row is `is_primary=0` — an
> alias/abbreviation row, not the place's canonical name.

| Row                                     | Why it is under key `to`                                        | Verdict     |
| --------------------------------------- | --------------------------------------------------------------- | ----------- |
| **Toledo**, ES — region, pop 707,109    | `names` row `TO`, `privateuse=abbr` — the Spanish province code | **correct** |
| `Tô` BF, `Tó` PT, `To` NO ×3            | places actually named that                                      | **correct** |
| **Lake** County, Minnesota — pop 10,855 | `Tó`, language `hun` — **Hungarian for "lake"**                 | **wrong**   |

### The mechanism

**Observation.** Lake County carries **364 `names` rows**, which are the translated common noun _lake_ in
every language WOF has: `Meer` (afr), `بحيرة` (ara), `Laco` (arg), `Quta` (aym), `Göl` (aze), `Sø` (dan),
`See` (deu), `Lac` (fra), `adagun`, `aintzira`, `Tó` (hun). These are dictionary entries for the word, not
names of a county in Minnesota.

The candidate build indexes every alt-name as a `name_key`, so the place becomes reachable under **134
distinct keys**. A bare Hungarian `Tó` retrieves it; so, by the same route, will Dutch `Meer` or French
`Lac`.

### Scale

Fan-out across the whole candidate table (8,343,429 places):

| distinct `name_key`s per place | places    |
| ------------------------------ | --------- |
| 1                              | 4,596,808 |
| 2–9                            | 3,632,886 |
| 10–49                          | 109,735   |
| **≥ 50**                       | **4,000** |

The ≥50 tail is **two populations mixed**:

```
United States    US  country        428 keys   pop 331,449,281   ← legitimate
United Kingdom   GB  country        392 keys   pop  67,326,569   ← legitimate
Fish             US  neighbourhood  261 keys   pop         575   ← the defect
Birds            US  neighbourhood  221 keys   pop       1,199
Bird             US  neighbourhood  221 keys   pop          63
Lake             US  county         134 keys   pop      10,855
```

A country with 428 exonyms is correct. **A neighbourhood of 63 people with 221 name keys is not.**

Splitting the 4,000 on that basis:

|                                                  | count     |
| ------------------------------------------------ | --------- |
| country / macroregion / region                   | 503       |
| **non-admin placetype with population < 50,000** | **3,233** |
| total ≥50 keys                                   | 4,000     |

**Inference, not observation:** the 3,233 are _predominantly_ this defect class. I sampled the head, not the
whole set, and some will be genuine (a small but historically significant town can carry many exonyms).

### A discriminator I proposed and falsified

My first idea was that a translated common noun attaches to _many unrelated places_ while a real exonym is
near-unique. **Wrong, and measurably so:**

| Name                      | Distinct places carrying it |
| ------------------------- | --------------------------- |
| `Tó` (hun, "lake")        | **1**                       |
| `Meer` (afr, "lake")      | 18                          |
| `Wien` (a genuine exonym) | **14**                      |

The genuine exonym is shared across _more_ places than the offending noun. Sharing does not separate them.

**What does look separable** — and this is a hypothesis, not a finding — is the mismatch between key count
and prominence. 221 keys on a 63-person neighbourhood is anomalous in a way 428 keys on the United States
is not. That is a change with a board, not a change to make from one example.

### Why this survived

Three reasons worth stating, because they generalise:

1. **The fan-out is invisible per query.** Nothing asks how many keys one place has, so 19 rows for `to`
   looks like a busy key rather than a data problem.
2. **The bad rows are shaped exactly like the good ones.** Both are alt-names in a named language with
   `privateuse=preferred`. Toledo proves the mechanism is required — abbreviation aliases are how
   `TO` → Toledo works — so `is_primary=0` cannot simply be dropped.
3. **It is not the stopword problem**, which is what I expected going in. That belongs to the FTS route
   (976 hits). The candidate route returns 19, and its bad rows arrive through legitimate-looking alias
   data — a harder failure to see precisely because the count is small.

---

## Status

Nothing here is filed. The `Of` half produced a shipped fix (seat preference) whose end-to-end reach is
still unverified; the `to` half is unfixed and undiagnosed past the mechanism above.

Both rest on two artifacts that cannot state their own provenance, which is the thing most likely to make
this document stale without anyone noticing.
