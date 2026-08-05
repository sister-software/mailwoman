# Regression corpus — batch notes

The prose that lived between the array literals of `cases/regression.ts` until the 2026-08-05
migration to per-country JSONL. JSONL carries no comments, so it moved here VERBATIM rather than
being deleted with the array. Nothing here is machine-read; it is the reasoning a reader needs
before touching a row.

Two indexes:

- **Batches** — the header that introduced a group of rows, keyed by the `source` value(s) those rows
  carry. `source` is the only field that survives the country split as a batch handle, which is why it
  must stay a curated, batch-shaped value and not drift into free text.
- **Per-case margin notes** — comments that sat above ONE row, keyed by case id.

Country dirs are lowercase ISO-3166 alpha-2; a row lives at `cases/<cc>/regression.jsonl`.

## Batches

### `bug:#905`

5 rows · `cases/au/`, `cases/ca/`, `cases/fi/`, `cases/fr/`, `cases/ie/`

> #905 acceptance rows — bare famous namesakes through the production path. The Jun-27 GeoNames
> alias fold silently broke unscoped ranking (FTS5 bm25 length-poisoning; the fix is the
> population-ordered companion fetch + population-first exact tier, PR #910). These lock the
> user-visible behavior class against BOTH ranking and placer regressions at the next DB rebuild —
> the exact silent-break mode #905 documented (lab-only suites are CI-invisible).
> STATUS 4/5 pass (#912 ranking bug CLOSED 2026-07-04): the #910 population-first exact tier +
> #936 officialNameExact fixed both the library ranking AND the CLI defaultCountry/township-alias
> path — Paris→FR, Dublin→IE, Melbourne→AU, Vancouver→CA all resolve correctly, and the #3
> sub-finding ("Åbo"→"bo" diacritic drop) is gone. Åbo stays improvement_target for a DIFFERENT,
> narrower reason: its coordinate is now correct (Turku) but the resolver returns the alias NAME
> "Åbo" not canonical "Turku" (a name-canonicalization residual, #897 family) — see its note.

<details><summary>Rows</summary>

- `global-paris-bare` — `cases/fr/regression.jsonl`
- `global-dublin-bare` — `cases/ie/regression.jsonl`
- `global-melbourne-bare` — `cases/au/regression.jsonl`
- `global-vancouver-bare` — `cases/ca/regression.jsonl`
- `global-abo-alias` — `cases/fi/regression.jsonl`

</details>

### `bug:#901`

5 rows · `cases/si/`

> #901 knife-edge sentinels (added 2026-07-03): the four SI short-village rows + the Učakar
> digit-split form. The four-probe attribution proved these are knife-edge outputs of the
> shipped encoder — ANY 2k init_from fine-tune of a surgery-lineage base tips them (zero-shard
> control: 4/4 row-identity; embedding-freeze: still breaks). They are the v2.2.0 full
> retrain's acceptance rows and the permanent early-warning sentinel for partial-update
> damage. Coordinates = the OA SI gold for each address; Učakar expects the street WHOLE.

<details><summary>Rows</summary>

- `si-sentinel-zabice` — `cases/si/regression.jsonl`
- `si-sentinel-apace` — `cases/si/regression.jsonl`
- `si-sentinel-mlinse` — `cases/si/regression.jsonl`
- `si-sentinel-zikarce` — `cases/si/regression.jsonl`
- `si-sentinel-ucakar` — `cases/si/regression.jsonl`

</details>

### `posais-attendee:2026-07-10`

4 rows · `cases/fr/`, `cases/jp/`

> Venue-toponym traps (added 2026-07-10, contributed by a POSAIS attendee — real Paris venues whose
> NAMES are toponyms pointing the wrong way). Live v5.9.0 behavior at intake: parís.méxico → Comer,
> Georgia US (the Spanish verb matched a US town namesake); Bubble Tea → "Bubble Bubble", AU;
> Shinjuku Pigalle → Tokyo. The class needs venue-kind detection + POI tier + the #1039 confidence
> floor; coordinates = BAN rooftops of the actual venues (provenance: ban:fr release=2026-05-18).
> Tolerance is metro-scale — the win condition is "lands in greater Paris or declines", not rooftop.

<details><summary>Rows</summary>

- `venue-toponym-comer-paris-mexico` — `cases/fr/regression.jsonl`
- `venue-toponym-comer-bare` — `cases/fr/regression.jsonl`
- `venue-toponym-shinjuku-pigalle` — `cases/fr/regression.jsonl`
- `venue-toponym-shinjuku-bare` — `cases/jp/regression.jsonl`

</details>

### `operator:paris-list-2026-07-15`

4 rows · `cases/fr/`

> FR street-name homonyms (operator's Paris list, 2026-07-15). The street's NAME is a major
> foreign city; the tolerance is what makes these mean something — Paris→Rome is ~1100 km, so a
> 50 km band FAILS LOUD if the toponym ever out-competes the street reading. These PASS today;
> they are here because two in-flight levers put them at risk: the #1103 morphology bias (a
> re-probe is pre-registered now that the #727 span head landed) and any recalibration of the
> gazetteer importance score (`impBias = importance * biasScale * maxBias`, neural/fst-prior.ts
> — measured 2026-07-15: `rue` 0.149 / `boulevard` 0.167 / `place` 0.169 are themselves
> gazetteer places, so raising importance would start biasing STREET-TYPE WORDS toward locality).
> The 30 currently-FAILING bare-fragment forms deliberately do NOT live here — this file is the
> executable bug log, not a wish list; they live in eval-harness/fixtures/paris-streets.jsonl.

<details><summary>Rows</summary>

- `fr-rue-de-rome-homonym` — `cases/fr/regression.jsonl`
- `fr-rue-de-constantinople-homonym` — `cases/fr/regression.jsonl`
- `fr-rue-d-ulm-elision-homonym` — `cases/fr/regression.jsonl`
- `fr-chat-qui-peche-street-swallows-locality` — `cases/fr/regression.jsonl`

</details>

### `operator:venue-list-2026-07-24`

13 rows · `cases/fr/`

> Venue-name traps, carried-address form (operator's venue list, 2026-07-24). Sibling family of
> the 2026-07-10 venue-toponym traps, but the venue NAMES here are mostly NOT foreign toponyms —
> they're honorifics, digit-words, slashes, CJK script, and one Korean city. Seven of thirteen
> resolve to the BAN rooftop TODAY (verified 2026-07-24, shipped model md5 700f3cf4, tier
> address_point, uncertainty 1 m): the BAN tier keys on house_number+street+postcode, which all
> parse cleanly, so the resolution is insensitive to the venue span. The six exceptions are gated
> as improvement_target: venue-delta-restaurant-paris-6 (the venue's 'Paris 6' arrondissement
> number
> is grabbed as the house_number — rooftop still lands), venue-bangkok-factory-boulogne ('Bis'
> glues into the street + the query falls to the admin tier), venue-nooyork-gravilliers-range
> (the '46/48' slash-range parses whole but the BAN tier can't match the literal range form),
> and venue-american-express-bercy (the brand demonym matched 'American', OHIO — a confident
> cross-continent pin ignoring the explicit 75012 postcode; the #1039 failure mode),
> and venue-bar-1802-pascal (the venue span consumed the address — '1802' as house_number, 'Bar'
> as street, the real span destroyed), and venue-cathedrale-strasbourg (the venue name contains
> the locality — 'Strasbourg' is consumed with it and the hierarchy collapses to country-only,
> landing ~5.5 km from the cathedral).
> The pinned residual across the whole batch is the LOCALITY SLOT: in every row the venue span
> swallows `locality` ('Paris' is consumed — locality='MR', 'Le 9Neuf', 'SOKCHO 牛者', …), the
> same venue-span/address-span separation defect the #1039 family tracks. These rows gate that
> the carried address keeps out-voting the venue name — tolerance is metro-scale, the win
> condition is 'lands the rooftop or declines'.

<details><summary>Rows</summary>

- `venue-mr-mrs-crab-huchette` — `cases/fr/regression.jsonl`
- `venue-le-9neuf-gaillon` — `cases/fr/regression.jsonl`
- `venue-sokcho-gyuja-antin` — `cases/fr/regression.jsonl`
- `venue-a-cafe-rivoli` — `cases/fr/regression.jsonl`
- `venue-jjan-chatelet-pont-neuf` — `cases/fr/regression.jsonl`
- `venue-delta-restaurant-paris-6` — `cases/fr/regression.jsonl`
- `venue-le-paris-paris-montfaucon` — `cases/fr/regression.jsonl`
- `venue-bangkok-factory-boulogne` — `cases/fr/regression.jsonl`
- `venue-american-bar-le-marais` — `cases/fr/regression.jsonl`
- `venue-nooyork-gravilliers-range` — `cases/fr/regression.jsonl`
- `venue-american-express-bercy` — `cases/fr/regression.jsonl`
- `venue-bar-1802-pascal` — `cases/fr/regression.jsonl`
- `venue-cathedrale-strasbourg` — `cases/fr/regression.jsonl`

</details>

### `operator:paris-list-2026-07-24`

1 row · `cases/fr/`

> Bare-form companion to the 2026-07-24 venue batch (same operator intake, but NO venue span):
> the unspaced-bis resolution defect stands alone.

<details><summary>Rows</summary>

- `fr-lyonnais-3bis-bare` — `cases/fr/regression.jsonl`

</details>

### `operator:comma-probe-2026-07-24`

3 rows · `cases/fr/`

> Comma-dependence pair (operator probe, 2026-07-24) — same street, same number, the ONLY
> difference is the comma-borne admin context. The bare form parses perfectly then DECLINES
> (null coords); the comma form rooftops at 1 m. Google Maps resolves the bare form to the
> Paris address; we emit nothing. The 2026-07-15 homonym note already observed the class
> ('the BARE form Rue de Rome emits nothing at all') — this pair pins it end-to-end on a
> street whose comma form is proven resolvable. The third row repeats the bare form WITH an
> explicit FR country prior: it STILL declines (verified 2026-07-24 — neither defaultCountry=FR
> nor a Paris proximity-bias point rescues it), proving the missing street-search-without-admin
> path can't be worked around by scoping; that row is the fix's natural acceptance row.

<details><summary>Rows</summary>

- `fr-lyonnais-3-bare-country-bias` — `cases/fr/regression.jsonl`
- `fr-lyonnais-3-bare-no-context` — `cases/fr/regression.jsonl`
- `fr-lyonnais-3-comma-control` — `cases/fr/regression.jsonl`

</details>

### `operator:2026-07-30`

9 rows · `cases/gb/`

> Directional-homograph probes (operator, 2026-07-30 — added before the run-2 promote decision).
> The set measures the OTHER side of the street_prefix recall trade: every row carries a
> South/North/East word that must NOT be split as a prefix (venue names, locality names, and
> mid-street abbreviations), plus GB venue-led forms, ranged numbers, a doubled station name,
> and one mixed-script venue. INTAKE CORRECTION 2026-07-30: the first grading ran against a stale regression DB (the probes
> weren't in it — absence-of-failure read as pass, the JSON-hides-gaps class). True intake: the
> three bare directional rows pass on BOTH shipped and the 7.0.0 candidate; ALL SIX venue-led
> rows fail on BOTH (venue null — the GB tail shape 'London EC3N 1DE' was never in the venue
> shard's FR/US templates), so they enter as improvement_target for the GB venue increment. Parse-only cases — no coordinate asserted.

<details><summary>Rows</summary>

- `gb-venue-ye-three-lords` — `cases/gb/regression.jsonl`
- `gb-bare-southend-on-sea` — `cases/gb/regression.jsonl`
- `gb-bare-southend` — `cases/gb/regression.jsonl`
- `gb-venue-southfields-doubled` — `cases/gb/regression.jsonl`
- `gb-bare-southbank` — `cases/gb/regression.jsonl`
- `gb-venue-new-north-health` — `cases/gb/regression.jsonl`
- `gb-venue-north-face-covent` — `cases/gb/regression.jsonl`
- `gb-venue-far-east-cjk` — `cases/gb/regression.jsonl`
- `gb-venue-east-india-club` — `cases/gb/regression.jsonl`

</details>

### `campaign:r10`, `campaign:r11`, `campaign:r9`

4 rows · `cases/de/`, `cases/es/`, `cases/in/`, `cases/it/`

> ── The non-GB dependent-locality instances (campaign R9–R11), gated so each locale's win cannot
> silently regress. Every one of these emitted NOTHING before its artifact shipped, and three of
> the four additionally emitted a WRONG span — the locality fused with the sub-locality — so these
> rows protect against a return to corrupt output, not merely to missing output.
>
> They grade through their own weights overlay (OVERLAY_LOCALE_BY_COUNTRY in harness.ts). Without
> that mapping they would run against base en-US, find no pair index for their country, and fail
> for a reason that has nothing to do with the model.

<details><summary>Rows</summary>

- `de-r9-nippes-koeln` — `cases/de/regression.jsonl`
- `in-r10-indiranagar-bengaluru` — `cases/in/regression.jsonl`
- `es-r11-aravaca-madrid` — `cases/es/regression.jsonl`
- `it-r11-trastevere-roma` — `cases/it/regression.jsonl`

</details>

### `campaign:r7`

2 rows · `cases/gb/`

> ── Northern Ireland (2026-08-02, campaign R7). NI sat outside the GB index since R3, deferred on
> "the pair parent needs post towns" — a licensed Royal Mail table. R5 dissolved that: the parent
> side need not come from a postal register, and WOF parents NI neighbourhoods to Belfast /
> Newtownabbey / Londonderry / Lisburn, which ARE the post towns for those addresses. 87 pairs.

<details><summary>Rows</summary>

- `ni-r7-ballyhackamore-belfast` — `cases/gb/regression.jsonl`
- `ni-r7-east-belfast-venue-confound` — `cases/gb/regression.jsonl`

</details>

### `campaign:r5`

2 rows · `cases/us/`

> ── US dependent-locality instance (2026-08-01, campaign R5). en-us ships `pair-index-us.bin`, so
> a US address carrying BOTH a neighbourhood/borough and its parent now resolves the hierarchy
> instead of dropping the second admin level. The pair of gated cases below locks BOTH halves: the
> new capability, and — more importantly — the guarantee that an ordinary single-admin-level US
> address is UNTOUCHED. The prior fires only when child AND parent are both present, which is why
> "Astoria, NY 11103" (a USPS-valid city/state/ZIP with no parent in the string) keeps locality.

<details><summary>Rows</summary>

- `us-r5-park-slope-brooklyn` — `cases/us/regression.jsonl`
- `us-r5-astoria-no-parent-unchanged` — `cases/us/regression.jsonl`

</details>

### `campaign:r5-subvenue`

6 rows · `cases/gb/`, `cases/us/`

> ── Sub-venue structure (2026-08-01, campaign R5 follow-on). The projection table has named this
> class since it was written — `building`/`campus`/`wing`/`concourse`/`arcade` project onto venue
> and unit sub-structure, "the airport-terminal / campus parsing nudge" — and the gauntlet had ZERO
> coverage for it: no `unit:` expectation existed anywhere in this file. These rows are the
> instrument, added before any fix.
>
> The measured diagnosis: `Building 43, Googleplex` already parses correctly while `Terminal 5,
Heathrow Airport` collapses to locality="Terminal" + house_number=5 with the airport DROPPED. The
> asymmetry traces to the designator lexicon the span proposer reads (`neural/span-proposer-lexicon.ts`
> over `codex/us/unit-designator.ts`), which is USPS Publication 28 — a MAIL DELIVERY standard. It
> stocks BUILDING, HANGAR, PIER and LOBBY because mail is delivered there, and omits TERMINAL, GATE,
> CONCOURSE and WING because mail is not. The postal source is right about postal reality and silent
> about venue interiors — the same source-shaped gap the dependent-locality arc hit for the US.
>
> A probe extending the designator set moved `Terminal 5` and `Gate 12` to correct units but split
> `Concourse B` into unit="Concourse" + venue="B" and left trailing-designator `West Wing` untouched,
> so the lever is real but NOT a clean sweep; it wants its own confound board (GB street names ending
> in -gate, industrial "Terminal" estates) before anything ships default-on.

<details><summary>Rows</summary>

- `gb-subvenue-heathrow-terminal` — `cases/gb/regression.jsonl`
- `gb-subvenue-manchester-gate` — `cases/gb/regression.jsonl`
- `gb-subvenue-st-thomas-wing` — `cases/gb/regression.jsonl`
- `us-subvenue-ohare-concourse` — `cases/us/regression.jsonl`
- `us-subvenue-googleplex-building` — `cases/us/regression.jsonl`
- `us-subvenue-northwestern-pavilion` — `cases/us/regression.jsonl`

</details>

### `operator:2026-08-01`

53 rows · `cases/bd/`, `cases/fo/`, `cases/fr/`, `cases/gb/`, `cases/ie/`, `cases/im/`, `cases/in/`, `cases/is/`, `cases/th/`

> ── Operator probe set 2 (2026-08-01): 53 exotic venue/locality rows — GB/IM/IE/FO/IS/intl traps.

<details><summary>Rows</summary>

- `gb-op2-bar-with-shapes` — `cases/gb/regression.jsonl`
- `gb-op2-247-lets-go` — `cases/gb/regression.jsonl`
- `gb-op2-little-tibet` — `cases/gb/regression.jsonl`
- `gb-op2-24n-fitness` — `cases/gb/regression.jsonl`
- `gb-op2-via-emilia` — `cases/gb/regression.jsonl`
- `gb-op2-east-west-fortess` — `cases/gb/regression.jsonl`
- `gb-op2-east-west-kingsland` — `cases/gb/regression.jsonl`
- `gb-op2-nine-elms-bare` — `cases/gb/regression.jsonl`
- `gb-op2-nine-elms-tavern` — `cases/gb/regression.jsonl`
- `gb-op2-art4space` — `cases/gb/regression.jsonl`
- `gb-op2-bindulged` — `cases/gb/regression.jsonl`
- `gb-op2-306-medical` — `cases/gb/regression.jsonl`
- `gb-op2-trickys-tolgus` — `cases/gb/regression.jsonl`
- `gb-op2-boscawen-un` — `cases/gb/regression.jsonl`
- `gb-op2-gods-own-meals` — `cases/gb/regression.jsonl`
- `gb-op2-four-seasons-cjk` — `cases/gb/regression.jsonl`
- `gb-op2-china-red` — `cases/gb/regression.jsonl`
- `gb-op2-paws-4-a-rest` — `cases/gb/regression.jsonl`
- `im-op2-talk-of-the-town` — `cases/im/regression.jsonl`
- `im-op2-simpsons-field` — `cases/im/regression.jsonl`
- `im-op2-wat-thai` — `cases/im/regression.jsonl`
- `gb-op2-bla-bheinn` — `cases/gb/regression.jsonl`
- `fo-op2-akraberg` — `cases/fo/regression.jsonl`
- `is-op2-bombay-bazaar` — `cases/is/regression.jsonl`
- `gb-op2-st-margarets-hope` — `cases/gb/regression.jsonl`
- `gb-op2-antrim-aonb` — `cases/gb/regression.jsonl`
- `gb-op2-derry` — `cases/gb/regression.jsonl`
- `ie-op2-jump-4-joy` — `cases/ie/regression.jsonl`
- `ie-op2-kin-khao` — `cases/ie/regression.jsonl`
- `ie-op2-the-pyramids` — `cases/ie/regression.jsonl`
- `ie-op2-letter-west` — `cases/ie/regression.jsonl`
- `ie-op2-cuas-an-daill` — `cases/ie/regression.jsonl`
- `ie-op2-pairc-adhamhnain` — `cases/ie/regression.jsonl`
- `gb-op2-north-irish-lodge` — `cases/gb/regression.jsonl`
- `ie-op2-embassy-canada` — `cases/ie/regression.jsonl`
- `ie-op2-oscar-wilde-house` — `cases/ie/regression.jsonl`
- `ie-op2-k-four-barbers` — `cases/ie/regression.jsonl`
- `ie-op2-new-st-s` — `cases/ie/regression.jsonl`
- `gb-op2-new-st` — `cases/gb/regression.jsonl`
- `gb-op2-68-shanghai` — `cases/gb/regression.jsonl`
- `gb-op2-numero-numero` — `cases/gb/regression.jsonl`
- `gb-op2-luxembourg-house` — `cases/gb/regression.jsonl`
- `gb-op2-the-o2` — `cases/gb/regression.jsonl`
- `gb-op2-sri-mahalakshmi` — `cases/gb/regression.jsonl`
- `gb-op2-masala-india` — `cases/gb/regression.jsonl`
- `fr-op2-le-colimacon` — `cases/fr/regression.jsonl`
- `gb-op2-africa-house` — `cases/gb/regression.jsonl`
- `gb-op2-platform-934` — `cases/gb/regression.jsonl`
- `th-op2-hawaii-london` — `cases/th/regression.jsonl`
- `bd-op2-london-college` — `cases/bd/regression.jsonl`
- `in-op2-ny-burrito` — `cases/in/regression.jsonl`
- `in-op2-mainland-china` — `cases/in/regression.jsonl`
- `bd-op2-ginza` — `cases/bd/regression.jsonl`

</details>

### `bug:#42`

7 rows · `cases/de/`, `cases/fr/`, `cases/gb/`, `cases/us/`

> #42 postcode-country coherence — the mis-scoped-locale block, added 2026-08-05 with the gauntlet's
> resolver-lever pin. The pin alone was not enough to grade the lever: the corpus carried exactly ONE case with
> a `defaultCountry` (an FR address under FR, where the pass exits cheaply by design), so the mechanism fired on
> 0/116 cases and the pinned run came back byte-identical to the unpinned one. An unchanged verdict from a
> mechanism that never ran is not evidence — hence these seven, which are the only cases in the corpus that put
> a country prior in tension with the address it is applied to.
>
> They come in two halves, and both halves are needed:
>
> · four ADVERSARIAL rows at status=pass — real US addresses whose (postcode, locality) pair is exactly the
> confound the mechanism could break (ZIP 75001 really IS Addison TX; Paris TX; Berlin NH carrying a
> 5-digit code the DE shape also accepts; Athens GA). They must hold with the lever pinned either way, and
> they are the "zero newly-failing cases" bar with teeth.
> · three RESCUE rows — a French, a British and a German address under `defaultCountry: US`, the demo/CLI
> reality (locale en-US → US on every query). They were the defect: all three failed at the pre-promotion
> default, and under the lever the FR and DE rows passed, which the runner's anti-rot loop reported as
> "now PASSES — promote to status=pass".
>
> PROMOTION 2026-08-05: with `postcodeCountryCoherence` default-ON, `fr-rivoli-us-scoped` and
> `de-linden-us-scoped` are GATED (`status: pass`) — leaving a rescued row at `improvement_target` after the
> default changes turns a gated guarantee into a tracked note. `gb-downing-us-scoped` stays an
> improvement_target: its blocker is a GB postcode parse under the en-GB overlay, not the resolver (see its
> own note), so #42 cannot reach it at any default.
>
> Every coordinate below was measured through the compiled CLI at 2026-08-05 against the 2026-08-04 gazetteer,
> not copied from the design record.

<details><summary>Rows</summary>

- `us-addison-zip-75001` — `cases/us/regression.jsonl`
- `us-paris-tx-75460` — `cases/us/regression.jsonl`
- `us-berlin-nh-03570` — `cases/us/regression.jsonl`
- `us-athens-ga-30601` — `cases/us/regression.jsonl`
- `fr-rivoli-us-scoped` — `cases/fr/regression.jsonl`
- `gb-downing-us-scoped` — `cases/gb/regression.jsonl`
- `de-linden-us-scoped` — `cases/de/regression.jsonl`

</details>

### `operator:2026-08-05`

53 rows · `cases/bm/`, `cases/ca/`, `cases/cr/`, `cases/es/`, `cases/fr/`, `cases/gb/`, `cases/mx/`, `cases/ni/`, `cases/pr/`, `cases/us/`, `cases/vg/`, `cases/vi/`

> ── Operator probe set 3 (2026-08-05): 53 rows, verbatim from the operator's list. The batch is deliberately
> NOT another London/Paris venue sweep — it walks the places the corpus had no row for at all: Northern
> Ireland, the Balearics, Puerto Rico, the US and British Virgin Islands, Bermuda, Costa Rica, Nicaragua,
> Mexican supermanzana addressing, Atlantic Canada, and small-town US.
>
> HOW THE STATUSES WERE SET. Every coordinate below was measured through THIS harness (buildGauntletDeps +
> runOne) on 2026-08-05 against the 2026-08-04 gazetteer, and every GOLD coordinate is an independent
> reference — an OSM feature resolved through Nominatim, or (one row) the decoded Open Location Code, or (one
> row) a directory listing where OSM has nothing. `status: pass` means today's pipeline MEETS the expectation
> the row states; `improvement_target` means it does not. No tolerance was widened to make a row green: the
> bands are set by what the address NAMES (rooftop 100–300 m, small settlement 1–2 km, city-only 3–6 km).
>
> SCOPED ASSERTIONS. Several rows land the right coordinate through a wrong parse — the venue span is eaten by
> `locality`, or the street is split. Those follow the corpus's existing idiom (see venue-mr-mrs-crab-huchette):
> assert the coordinate + the components that ARE right, gate on that, and name the unasserted parse defect in
> the note. A row whose note describes a defect is a row that is NOT guarding that defect.
>
> `expectTier` is pinned ONLY where today's result is `address_point`. Pinning `interpolated` or `admin` would
> make a future rooftop upgrade fail the gate — the tier assertion is a floor, and there is no floor to state
> below the top tier.
>
> READINGS RECORDED RATHER THAN GUESSED (each is argued in its own row's note): "W4, The Odyssey" as
> unit+venue; "Les Halles" as a named quartier rather than the 75001 arrondissement; the Nicaraguan plus code
> VFQ6+92P and the "NIC-38" route number, neither of which has a ComponentTag; the Mexican
> supermanzana/manzana/lote block, which also has none (the schema's `block`/`sub_block` are JP-only).

<details><summary>Rows</summary>

- `gb-op3-odyssey-w4-belfast` — `cases/gb/regression.jsonl`
- `gb-op3-40ft-brewery-dalston` — `cases/gb/regression.jsonl`
- `gb-op3-4lebanese-holloway` — `cases/gb/regression.jsonl`
- `gb-op3-one-eighty-one-holloway` — `cases/gb/regression.jsonl`
- `gb-op3-les-2-garcons-middle-lane` — `cases/gb/regression.jsonl`
- `fr-op3-les-2-pianos-lourmel` — `cases/fr/regression.jsonl`
- `fr-op3-les-halles-75001` — `cases/fr/regression.jsonl`
- `fr-op3-halles-market-bonneuil` — `cases/fr/regression.jsonl`
- `fr-op3-halle-o-lognes` — `cases/fr/regression.jsonl`
- `fr-op3-wingstop-bastille` — `cases/fr/regression.jsonl`
- `fr-op3-delhi-bazaar-servan` — `cases/fr/regression.jsonl`
- `fr-op3-dancefloor-paris-11` — `cases/fr/regression.jsonl`
- `es-op3-label-cabestreros` — `cases/es/regression.jsonl`
- `es-op3-modas-bagdad-amparo` — `cases/es/regression.jsonl`
- `es-op3-font-del-cuento-garriga` — `cases/es/regression.jsonl`
- `es-op3-can-sumarro-hospitalet` — `cases/es/regression.jsonl`
- `es-op3-skulptur-portopetro` — `cases/es/regression.jsonl`
- `es-op3-southeast-portopetro` — `cases/es/regression.jsonl`
- `pr-op3-venezuela-san-juan` — `cases/pr/regression.jsonl`
- `pr-op3-san-francisco-san-juan` — `cases/pr/regression.jsonl`
- `pr-op3-place-at-the-sea-ponce` — `cases/pr/regression.jsonl`
- `vg-op3-road-town` — `cases/vg/regression.jsonl`
- `vi-op3-bordeaux-st-john` — `cases/vi/regression.jsonl`
- `vi-op3-chocolate-hole-cruz-bay` — `cases/vi/regression.jsonl`
- `vi-op3-red-hook-st-thomas` — `cases/vi/regression.jsonl`
- `pr-op3-playa-sardinas-culebra` — `cases/pr/regression.jsonl`
- `bm-op3-five-star-island` — `cases/bm/regression.jsonl`
- `bm-op3-daniels-head-beach-park` — `cases/bm/regression.jsonl`
- `mx-op3-white-house-isla-mujeres` — `cases/mx/regression.jsonl`
- `cr-op3-san-jose` — `cases/cr/regression.jsonl`
- `cr-op3-barrio-espana-rio-oro` — `cases/cr/regression.jsonl`
- `ni-op3-san-francisco-libre` — `cases/ni/regression.jsonl`
- `ni-op3-el-sauce-pluscode` — `cases/ni/regression.jsonl`
- `mx-op3-plaza-las-americas-villahermosa` — `cases/mx/regression.jsonl`
- `mx-op3-one-villahermosa-2000` — `cases/mx/regression.jsonl`
- `mx-op3-terraza-38-zapopan` — `cases/mx/regression.jsonl`
- `mx-op3-san-miguel-canada-zapopan` — `cases/mx/regression.jsonl`
- `us-op3-gayway-corner-fruitland` — `cases/us/regression.jsonl`
- `us-op3-evergreen-cemetery-kalkaska` — `cases/us/regression.jsonl`
- `us-op3-northwind-apartments-kalkaska` — `cases/us/regression.jsonl`
- `us-op3-island-lake-duplicate-degenerate` — `cases/us/regression.jsonl`
- `us-op3-village-of-fae-carmel` — `cases/us/regression.jsonl`
- `us-op3-carmel-mission-basilica` — `cases/us/regression.jsonl`
- `us-op3-twin-peaks-golf-longmont` — `cases/us/regression.jsonl`
- `us-op3-300-suns-brewing-longmont` — `cases/us/regression.jsonl`
- `us-op3-clown-motel-tonopah` — `cases/us/regression.jsonl`
- `us-op3-ernest-tubb-nashville` — `cases/us/regression.jsonl`
- `us-op3-patio-town-square-white-house` — `cases/us/regression.jsonl`
- `us-op3-residence-five-corners-easton` — `cases/us/regression.jsonl`
- `us-op3-four-corners-monument` — `cases/us/regression.jsonl`
- `ca-op3-lakehead-university` — `cases/ca/regression.jsonl`
- `ca-op3-swiss-chalet-gander` — `cases/ca/regression.jsonl`
- `us-op3-island-lake-apartments-kalkaska` — `cases/us/regression.jsonl`

</details>

### `operator:2026-08-05`

2 rows · `cases/gb/`

> Appended by the operator after the first 53 were graded — same contract, same instrument.

<details><summary>Rows</summary>

- `gb-op3-bread-street-kitchen-city` — `cases/gb/regression.jsonl`
- `gb-op3-three-upper-street` — `cases/gb/regression.jsonl`

</details>

### The seed batch (no header comment)

The 19 rows that opened the array — one per fixed bug, entered 2026-06-29 → 2026-07-02, each
carrying its own margin note below rather than a shared header.

- `fr-chevaleret-rooftop` — `cases/fr/regression.jsonl`
- `fr-chevaleret-bare` — `cases/fr/regression.jsonl`
- `us-dc-pennsylvania` — `cases/us/regression.jsonl`
- `us-5th-ave-ny-rescore` — `cases/us/regression.jsonl`
- `us-new-york-nyc` — `cases/us/regression.jsonl`
- `us-portland-me` — `cases/us/regression.jsonl`
- `us-portland-or` — `cases/us/regression.jsonl`
- `us-augusta-me` — `cases/us/regression.jsonl`
- `us-springfield-il` — `cases/us/regression.jsonl`
- `us-chicago-il` — `cases/us/regression.jsonl`
- `intl-tbilisi-georgia` — `cases/ge/regression.jsonl`
- `intl-batumi-georgia` — `cases/ge/regression.jsonl`
- `us-savannah-georgia` — `cases/us/regression.jsonl`
- `intl-beirut-lebanon` — `cases/lb/regression.jsonl`
- `intl-vienna-austria` — `cases/at/regression.jsonl`
- `intl-sydney-australia` — `cases/au/regression.jsonl`
- `intl-toronto-canada` — `cases/ca/regression.jsonl`
- `intl-zurich-switzerland` — `cases/ch/regression.jsonl`
- `us-springfield-il-region-guard` — `cases/us/regression.jsonl`

## Per-case margin notes

### `fr-chevaleret-rooftop`

`cases/fr/regression.jsonl` · `source: bug:#828`

> Entry #1 — the FR OSM rooftop tier + the v1.9.4 parse fix, guarded via the WITH-postcode demo form.

### `fr-chevaleret-bare`

`cases/fr/regression.jsonl` · `source: bug:#831`

> #831 FIXED — promoted to a gated pass (night 34, 2026-07-05). The v5.4.0 parse fix
> (v2.3.0-nl-postcode, family-pinned) parses 'Chevaleret' into the street ('Rue du Chevaleret'),
> not the locality, so the canonical mixed-case now reaches the OSM rooftop tier — verified
> deterministic at 48.8335,2.3686 (address_point) under the shipped v5.4.0 dev weights. Not a
> #829 effect (that hook only touches all-lowercase input; the mixed-case canonical is untouched).

### `us-dc-pennsylvania`

`cases/us/regression.jsonl` · `source: golden`

> A US landmark anchor — guards the US admin/street path doesn't drift while we touch intl. (country
> is dropped: the US resolver hierarchy stops at region — region=DC already implies US.)

### `us-5th-ave-ny-rescore`

`cases/us/regression.jsonl` · `source: bug:span-rescore`

> The 'Ave recovered as a French locality' span-rescore bug (66ff2e68). The fix's guarantee is IN NY,
> NOT France — guarded with a wide (NY-state) tolerance. The tighter NYC disambiguation is #832.

### `us-new-york-nyc`

`cases/us/regression.jsonl` · `source: bug:#832`

> #832 — RESOLVED. NYC carries WOF parent_id=-4 (multi-parent sentinel), so the ancestors parent_id
> closure left it only-self; the region hard-filter then excluded it and "New York Mills" (pop 3,190)
> won over NYC (8.8M). Fixed by wiring the wof:hierarchy ancestry backfill into the build (PR #835) +
> swapping the backfilled canonical DB. Gated `pass` so it can't silently regress (anti-rot).

### `us-portland-me`

`cases/us/regression.jsonl` · `source: bug:#833`

> #833 — RESOLVED by admin descendant-consistency (#263). The greedy walk resolved region "ME" to
> Messina (IT, by population), "Portland" found nothing under it, and the result fell back to the
> Sicilian centroid. The fix re-picks the (region, locality) pair where the locality descends from a
> same-named region candidate — Portland descends from Maine, not Messina. No country prior, no list.

### `us-portland-or`

`cases/us/regression.jsonl` · `source: bug:#833`

> #833 sibling — a different namesake collision (region "OR" → Ourense, Spain), guards that the fix
> generalizes across countries (IT for ME, ES for OR), not just one province.

### `us-augusta-me`

`cases/us/regression.jsonl` · `source: bug:#833`

> #833 two-pairs residual — "Augusta" exists under BOTH Maine and Messina (IT), so the locality
> resolves under the greedy foreign region and adminCoherence's unresolved-trigger never fires.
> Closed by the forward `country_hint` linkage: a 2-letter US-state abbrev pins the region to US.

### `us-springfield-il`

`cases/us/regression.jsonl` · `source: golden`

> A clean US 'City, ST' that resolves correctly — guards the working path so a placer/ranking change
> for #832/#833 can't silently regress it. Springfield-IL is also a tuned exact-match case.

### `intl-tbilisi-georgia`

`cases/ge/regression.jsonl` · `source: bug:#267`

> #266/#267 — international coverage. "Georgia" the country shadows the populous US state; the GeoNames
> admin fold (#267 data) + the country-candidate reconcile (#267 resolver) land Tbilisi in Georgia, not
> US Georgia. Guards the gap-country admin hierarchy + the foreign-capital-vs-US-state collision fix.

### `intl-batumi-georgia`

`cases/ge/regression.jsonl` · `source: bug:#1023`

> #1023 — a SECOND Georgian city on the exact path the Tbilisi fix repairs. "Georgia" parses as
> `region` (it names a US state), so a non-capital Georgian city ("Batumi") must ride
> reconcileAdminPair's matchCountry fall-through, NOT the greedy walk. Guards against a future admin
> rebuild re-breaking the country-vs-US-state class for anything but the one capital already pinned.

### `us-savannah-georgia`

`cases/us/regression.jsonl` · `source: bug:#1023`

> #1023 byte-stability guard (the NEGATIVE case) — a DOMESTIC "City, Georgia" (US) must stay US
> Georgia. The matchCountry fall-through must never re-pick a real US city to a foreign namesake:
> Savannah resolves under the US state in the greedy walk, so reconcileAdminPair's unresolved-locality
> branch never fires. Pins that the #1023 fix doesn't over-reach into the domestic path.

### `intl-beirut-lebanon`

`cases/lb/regression.jsonl` · `source: bug:#1023`

> #1023 sibling-path guard — the country-vs-US-town namesake via the EXPLICIT-country path (#822),
> the disjoint half of the namesake family. "Lebanon" parses as `country` (region=null), so
> "Beirut, Lebanon" rides applyExplicitCountryCoherence, not reconcileAdminPair. Broadens the class
> beyond Georgia (Lebanon has populous US-town namesakes — Lebanon PA/TN/OH) so a regression in
> EITHER coherence pass is caught.

### `intl-vienna-austria`

`cases/at/regression.jsonl` · `source: bug:#822`

> #822 — the named-foreign-country namesake. "Vienna" has 6 populous US namesakes that win the
> population-first candidate window; the explicit "Austria" token was ignored. applyExplicitCountry
> coherence (resolve.ts) re-picks the locality to the same-named place under matchCountry("Austria")=AT.

### `intl-sydney-australia`

`cases/au/regression.jsonl` · `source: bug:#822`

> #822 — sibling case, the resolved-but-foreign path (the greedy walk picked a non-AU Sydney).

### `intl-toronto-canada`

`cases/ca/regression.jsonl` · `source: bug:#822`

> #822 — was Toronto OH (40.46,-80.61).

### `intl-zurich-switzerland`

`cases/ch/regression.jsonl` · `source: bug:#822`

> #822 — was Zurich KS (39.23,-99.43). The exonym is folded under the native "Zürich".

### `us-springfield-il-region-guard`

`cases/us/regression.jsonl` · `source: bug:#822`

> #822 byte-stability guard — the explicit-country reconcile must NOT fire when a REGION scopes the
> locality (no region/subregion ancestor between country and locality). "Springfield, IL, USA" must
> stay Springfield IL, never the most-populous US Springfield. Pins the region guard in resolve.ts.
