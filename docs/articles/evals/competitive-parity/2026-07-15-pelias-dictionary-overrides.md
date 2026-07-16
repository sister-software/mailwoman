# What Pelias's dictionary overrides cost — 94 deletions, read as a bug log

A read of `pelias/parser/resources/pelias/dictionaries` (2026-07-15). Pelias vendors a curated subset
of libpostal's dictionaries and maintains a **patch layer** on top: a `!token` line means _"libpostal
says this is a street type / place name / surname; we say no."_

**94 of the 276 non-comment lines are deletions.** A third of the vendored dictionary exists to
un-say something. This is not a criticism of the engineers — every line is a defensible call. It is a
record of what the _architecture_ charges for a homograph.

## Each line is a headstone

| override                         | the comment, verbatim                                                            | who lost                                               |
| -------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `!and` (it)                      | "this Italian contracted form of Androna causes issues in English"               | Trieste's `and.` street type                           |
| `!ca` (es)                       | "conflicts with US state abbreviation"                                           | Spanish `calle` abbreviated                            |
| `!alle` (nb)                     | "Causes a bunch of issues with Spanish addresses (\"Calle\" is a common prefix)" | Norwegian, so Spanish could win                        |
| `!art` (wof locality)            | "18 person county in texas"                                                      | **Art, Texas — population 18**                         |
| `!alabama`, `!north carolina`, … | "remove any localities which share a name with a US state"                       | Alabama, NY and every peer                             |
| `!italy` (wof locality)          | "remove problematic locality names"                                              | Italy, Texas                                           |
| `!street` (surnames)             | —                                                                                | the surname Street (a real surname — Picabo Street)    |
| `!paris` (wof region)            | "This is not used as region"                                                     | —                                                      |
| `!burgermeester` (nl)            | "typo in LibPostal resource"                                                     | pure vendoring tax — can't fix upstream, patch locally |

Note the **chain of collisions**: `!ca` deletes Spanish so California can win; `!alle` then deletes
Norwegian so Spanish can win. Each is resolved in favour of whoever complained loudest.

## The two best lines in the directory are commented out

```
#!new york
...
#!washington
```

The rule _"remove any localities which share a name with a US state"_ was applied bluntly — and then
had to be **hand-un-applied** for the famous cases, because New York and Washington are, in fact,
localities. The commented-out lines are the fossil of that fight: a blunt instrument, then a manual
exception list for the entries that mattered too much to lose.

That is the same shape as our own gazetteer-importance problem (#1142): when the signal cannot
express nuance, famous things need special-casing by hand.

## The pattern: a global dictionary must choose once, forever

Almost every override is a collision between a **rare-but-real** meaning and a **common** one:

`ca` (calle / California) · `ch` (Chaussee / Switzerland) · `ga` (Korean 가 / Georgia) ·
`ma` (Mannheim / Massachusetts) · `in` (preposition / Indiana) · `a` (article / A Street DC) ·
`art` (Artery, Art TX / the word "art")

A dictionary lookup has no locale, no context, and no confidence. A token has ONE meaning. So when
two meanings collide, one must **die — globally and permanently**. There is no "unless the query
smells like Spain."

**This is pragmatism, and the EV is correct.** Art, Texas has eighteen residents; the word "art" appears
in millions of queries. Deleting `art` is the right call _given a dictionary_. Nobody was careless.

**It becomes scar tissue in one specific sense: it is irreversible and context-free.** The deletion has
no locale gate, no confidence, no conditions to revisit. It is a global `if false`, and the reason it
can never be anything else is architectural, not intellectual.

## The receipts, ours

The claim a contextual model makes is that it can hold both meanings and let context weigh them.
Measured on the shipped v264 (2026-07-15):

```
Art, TX               → {region: TX, locality: Art}                       ✓  (Pelias: deleted)
Alabama, NY           → {region: NY, locality: Alabama}                   ✓  (Pelias: deleted)
100 Main St, Art, TX  → {hn: 100, street: Main, suffix: St, locality: Art, region: TX}  ✓
Calle Mayor 5, Madrid → {hn: 5, street: "Calle Mayor", locality: Madrid}  ✓  (Pelias: !ca)
Italy, TX             → {country: Italy, region: TX}                      ✗  WE FAIL THIS
```

**4 of 5 — and the miss is the honest part.** `Italy, TX` is the exact row Pelias hand-deleted
(`# remove problematic locality names`), and we get it wrong too. We simply get it wrong _differently_:
Pelias deletes the locality; we call Italy a country.

So the thesis is not "we win." It is narrower and more defensible:

> **Holding an ambiguity is not the same as resolving it.** The architecture buys us the ability to be
> wrong _recoverably_ — `Italy, TX` is the country-channel homograph class, and its knob is
> `country_ambiguous_scale`, which v263 set hard, over-suppressed, and v264 relaxed to 0.5 and
> measured (homograph F1 82.6 → 85.1, WOF-admin 89.3 → 91.1%, no trade). Pelias's equivalent knob is a
> line you delete.

One sets a scale to 0.5 after an eval. The other sets it to zero forever, in a text file, with a
comment explaining who lost.

## Why this matters to us specifically

1. **It is the strongest available argument for the #727 span/segment direction** — not because
   dictionaries are dumb, but because a per-token global lookup structurally cannot condition. Every
   `!` line is a place where context existed and could not be consulted.
2. **`!art` is our own failure class too.** "Art" as a street-type abbreviation for "Artery" is the
   same rare-abbreviation-vs-common-word collision we hit with `rue` (0.149) being a gazetteer place
   (#1142). We are not immune; we are _conditionable_.
3. **The commented-out `#!new york` is a warning about #1142's fix.** A blunt global rule plus a
   hand-maintained exception list for famous things is exactly the failure we would ship if we
   "fixed" importance without the `matched`/`importance` split.
