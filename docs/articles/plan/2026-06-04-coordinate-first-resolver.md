# Coordinate-first resolver & falsehood-aware reconciliation — direction (2026-06-04)

We spent the PR3 cycle trying to fix German inside the parser — a self-conditioned retrain, then a decoder repair — and both produced correct-er parses that the resolver couldn't cash in. The resolver is the judge, and the judge kept saying the same thing: German is a **resolver** problem, not a parser problem. This is the plan that follows from finally believing it.

DeepSeek-signed across the Pilot-A postmortem consult (`.agents/skills/deepseek-consult/session-notes-2026-06-04-pilot-a-postmortem.md`, `…-resolver-coordinate-first.md`), grounded in how Pelias and Airmail actually work.

## Why now

[PR3 Pilot A](../evals/2026-06-04-pr3-pilot-a-eval.md) (self-conditioning, from scratch US/FR/DE) came back a clean negative: DE locality resolver-match 25.6% vs v0.7.2's 77.4%, the v0.8.0 span collapse reproduced via a new mechanism, on correct data, and _converged_ (flat 10k→20k). The decoder follow-up — the [postcode-trim](https://github.com/sister-software/mailwoman/pull/272), which hands a swallowed city-start back to the city — fixed the parse (`auen Vogtl` → `Plauen Vogtl`, +36pp DE exact-locality) and moved the resolver **zero**.

That zero is the whole story. The parse was string-perfect and the resolver still missed, because **our resolver matches the parsed locality string against WOF names, and OA's gold carries a region suffix WOF doesn't store** (`Plauen Vogtl` vs WOF's `Plauen`). Even v0.7.2, which parses German cleanly, only resolves 54.7% of Saxony for this reason. We were optimising a name-equality the gazetteer's canonical names can't satisfy.

## The reframe: the German "wall" is largely a metric artifact

Our `oa-resolver-eval` locality-match is name-centric — it compares the resolved WOF _name_ to OA's gold _name string_. It penalises a geographically-correct resolve that returns `Plauen` against gold `Plauen Vogtl`. Meanwhile the resolver already places these German addresses at coord **p50 1.3 km** via the postcode anchor. So a large slice of the "25.6% / 77.4% German locality" number was never a geocoding failure — it was a scoreboard that can't read a name variant.

The fix starts with the scoreboard. **The non-gameable metric:** a locality is correctly resolved iff the real OA per-address point lies _inside the polygon_ of the resolver-assigned WOF locality (point-in-polygon containment, not centroid distance — distance is gameable in a dense metro). The circularity guard is absolute: score against the real OA point, **never** the postcode centroid the resolver itself consumed.

## How the rest of the field does it

**Pelias** doesn't name-match for admin at all. Its `wof-admin-lookup` _discards_ the source record's city names and regenerates the whole hierarchy from WOF polygons via point-in-polygon on the coordinate, at import — "we ignore all admin hierarchy from individual records and generate it from the polygon data." The `Plauen Vogtl` mismatch can't arise. Its `postal-cities` precomputes a postcode→locality table that aggregates _multiple_ names per postcode (18964 → both "Souderton" and "Franconia"). Its point-in-polygon is an in-memory rbush R-tree + ray-cast, not Elasticsearch and not SpatiaLite.

**Airmail** (and Nominatim, Photon) are retrieval geocoders — BM25 over indexed places. A wrong postcode just lowers a document's score; the right city still ranks it up. Robust, but with no explicit "these two fields disagree" signal, so they _silently mislocate_ when a wrong combination scores high (`90210 Los Angeles` → Beverly Hills). That silence is the gap we can fill.

The lesson: Pelias trusts the coordinate because at _import_ it has the true address point. We are a query-time parser+resolver — the postcode is the user's _claim_, which can be transposed, stale, or borrowed from the next town over. So we cannot blindly trust it the way Pelias does. The parsed city name is our independent cross-check, and the trim is what made it reliable.

## The design

A coordinate-first resolver that scores rather than hard-matches, and flags rather than launders.

### Candidate generation (coordinate-first, in-DB, no ES)

Precompute a `postcode → candidate localities` table **offline**, where the geometry lives. For each postcode, take its centroid, point-in-polygon (or nearest within ~10 km) against WOF locality polygons, and store the containing/adjacent localities with their canonical name and WOF alt-names. This is Pelias's move keyed on postcode; the heavy geometry runs once at build time, and the shipped artifact is a flat SQLite lookup. **No SpatiaLite-for-web** — it's a lookup we precompute, not a spatial engine we ship.

At resolve time, the candidate set is the postcode-proximal localities ∪ a few name-matched localities (country-filtered fuzzy), typically ≤5.

### Soft-scoring reconciliation (retrieval robustness + explicit conflict)

Score each candidate `c`:

```
Score(c) = 0.6·S_pc + 0.3·S_name + 0.1·S_pop
  S_pc   = exp(−dist/2km), or 1.0 if the postcode point is inside c's polygon
  S_name = fuzzy match of the parsed locality vs c's canonical name + alt-names
  S_pop  = log-normalised population, a tiebreak when evidence is weak
```

Pick the top. **Confidence = logistic(margin between the top two.)** And the differentiator a BM25 geocoder structurally can't offer: **raise a `postcode_city_mismatch` flag when `|S_pc − S_name| > 0.5`** — the postcode points one way, the name another. Return the best candidate, but with lowered confidence and the flag attached. Never silently overwrite a strong name match with a postcode-only guess.

Output the canonical WOF name (that's what geocodes), and echo the parsed string as `parsed_locality` for transparency.

### Reconciliation policy (default)

- Both `S_pc` and `S_name` > 0.6 → return, confidence ≥ 0.9.
- One signal dominates (e.g. `S_pc` > 0.8, `S_name` < 0.3) → return top, confidence ~0.7, flag `postcode_city_mismatch`.
- Small margin (< 0.1) with disagreement → confidence ~0.5, flag `ambiguous_locality`, optionally return both as an ordered list.

### The three auxiliary tables — what's worth building

- **Transposed/alias city names** — _skip the dedicated table._ WOF ships `alt_name`/`name:*`; edit-distance + double-metaphone over a 5-item candidate set catches the rest on the fly (see #189 for splitting alt-names into their own FTS table).
- **Misappropriated postcode → target** — _don't build a table of user mistakes_ (intent is unsourceable). But fold the _sourceable_ half — WOF/`postal-cities` postcode→multiple-postal-city aliases — into the candidate table. That covers "the postal city differs from the admin city"; the genuine mistakes are caught by the conflict flag.
- **Abutting/adjacent postcodes** — _a radius, not a table._ Candidate generation within ~10 km already captures the neighbour; an optional build-time `is_adjacent` boolean only if the data demands it. The containment metric handles it for free: if the gold point is genuinely in the next town, the next town is the right answer.

## Falsehoods: the part Pelias and Airmail skip

`data/eval/falsehoods/postcodes.jsonl` currently tests alphanumeric postcode _parsing_ — it says nothing about postcode/city _conflicts_. We extend it with the cases that actually bite travellers and border-town residents: digit transposition (`75008`→`57008`), wrong-city-for-postcode (`10115 München`), and adjacent-town borrowing. The metric is whether the resolver **catches** the conflict (raises the flag) rather than confidently mislocating. Clean-OA containment measures accuracy; conflict-falsehoods measures the robustness that justifies a parse-then-resolve pipeline over a BM25 box.

## Staged plan (cheapest and most decisive first)

1. **PIP-containment metric + re-measure.** Implement the geometric metric (gold OA point inside resolved WOF locality polygon, using the WOF GeoJSON polygons already on disk) and re-score the _current_ resolver on DE — no build, no retrain. **Gate: if DE clears ~85%, the German wall was largely a measurement artifact** and the candidate table is a refinement, not a rescue. If lower, the table is mandatory. (#273)
2. **Postcode → locality candidate table** (offline precompute, WOF alt-name aliases folded in). Re-measure. (#274)
3. **Soft-scoring reconciliation + conflict flag** in the resolver. (#275; builds on #227 population tiebreak, #189 alt-names.)
4. **Conflict-falsehoods eval** — extend the falsehoods doc; gate on catching mismatches. (#276)
5. **No-postcode fallback** — country-filtered fuzzy over the alias index (where the trim's clean string earns its keep).

The parser stays a clean token tagger throughout. PR #272 (the trim) is retained: it doesn't move the name-match metric, but it makes the name a reliable cross-check for reconciliation and feeds the string-fallback path.

## Done-with-German

At least **90% of German test addresses have their gold OA point inside the polygon of the resolver-assigned WOF locality**, with US held above 95%, no Elasticsearch, no further parser retraining.

## Durable principle

The parser extracts raw text; the resolver assigns authoritative geography by projecting postcode centroids onto WOF polygons, using strings only as a tiebreaker — and when the postcode and the name disagree, it says so instead of guessing.

## Related

- [PR3 Pilot A eval](../evals/2026-06-04-pr3-pilot-a-eval.md) — the negative result that pointed here.
- [Anchor-based parsing direction](./2026-06-03-anchor-based-parsing.md) — the parser-side direction this complements.
- Issues: #227 (population tiebreak), #189 (alt-names FTS table), #242 (the self-conditioning pilot — now closed negative), epic #239.
