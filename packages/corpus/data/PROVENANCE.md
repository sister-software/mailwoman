# `corpus/data/` provenance

## `address-source-register.json` — the address-source register (#2323)

Which jurisdictions exist, what research has resolved for each, and what is known about every
source's terms. Generated, **not hand-edited**.

### Regenerate

```sh
mailwoman corpus source-register \
  --inventory      internal/research/global-address-jurisdiction-inventory-v3.csv \
  --sources        internal/research/global-functional-authority-corpora-v2.csv \
  --decisions      packages/corpus/data/license-decisions.json \
  --resolutions    packages/corpus/data/source-resolutions.json \
  --register-version 0.1.0 \
  --authored-at    2026-09-18 \
  --source-version global-address-corpus-spec-v3
yarn format
```

That is the command that produced the committed copy. The two CSVs are research working documents and
live in the `mailwoman-internal` repository under `research/`, so regenerating needs a checkout of it.
That repository is checked out at `internal/`, which `.git/info/exclude` keeps out of this one, and
the paths above read from there. They were under this repository's gitignored `.notes/` until 2026-09-20, where
nothing versioned them and a reviewer could not tell which copy produced the register. The register
is the committed record here, and it carries every field a reader needs to check a row: the
publisher, the retrieved URL, and the research pass.

Two further inputs are committed beside this file, and both exist because the write below replaces the
register whole: a value recorded in the register itself is erased by the next run with no error and a
normal-looking count.

`--decisions` defaults to `license-decisions.json` and holds every licence decision somebody made by
reading a publisher's terms. The build derives each decision as `unchecked` from the research pass's
access labels and applies the recorded ones over that, so a decision survives a rebuild (#2351).

`--resolutions` defaults to `source-resolutions.json` and holds the source fields a review resolved:
`addressRoles`, `coverage`, `upstreamLineage` and `personalDataReview`. The research CSV records the
first three as the placeholders `varies`, `country-specific` and the empty string on all 421 of its
non-rail rows, and has no column for a personal-data review, so a review records its findings here
rather than by rewriting the record of what the research pass found on 2026-09-18 (#2323).

The `oxfmt` pass is required — committed JSON is oxfmt-clean, which `JSON.stringify` cannot
reproduce. The generator is deterministic, so the artifact is reproducible from the same inputs.

### What no check can establish about this file (#2352)

Regeneration is the only thing that catches a hand edit to a generated artifact, and regeneration
needs the two CSVs in `mailwoman-internal/research/`. A CI runner for this repository has no checkout
of that one, so the register's correctness rests on whoever last ran the command above, and
`auditAddressSourceRegister` does not change that: it checks the file's structure, and a publisher's
name rewritten to something that names no institution is structurally sound.

The inputs are now versioned, which is what changed on 2026-09-20. A reviewer can diff the CSV that
produced the register against the one a later build reads, and a research pass that moves a
publisher's name leaves a commit saying so. Establishing that the committed register matches its
inputs still takes running the command with both repositories checked out.

A committed digest would not close it either. A sweep that edits the artifact and the digest together
passes, and one that edits only the artifact fails without saying which side is right.

This is the arrangement that let a prose sweep rewrite `Contracts Finder / Find a Tender` to
`Interfaces Finder / Find a Tender` and `National Database of Public Contracts` to
`National Database of Public Interfaces`, and let it stand until somebody regenerated. Both are
restored, and a reader who finds a name here that resolves to no institution should regenerate before
concluding the publisher renamed itself.

### Inputs, as of the committed build

| file                                           |  rows | what is read                                                           |
| ---------------------------------------------- | ----: | ---------------------------------------------------------------------- |
| `global-address-jurisdiction-inventory-v3.csv` |   250 | all 250 rows — every ISO 3166-1 alpha-2 code plus the operational `XK` |
| `global-functional-authority-corpora-v2.csv`   | 2,421 | the 421 rows naming a national source; 2,000 are dropped               |

The 2,000 dropped rows carry `origin = global_research_rail`: eight global discovery lookups the
pass repeated once per jurisdiction, which collapse to eight distinct row bodies ignoring the `iso2`
and `jurisdiction` columns. They name a lookup to perform rather than a source, so they are the
README's procedure and not rows here.

### Why three columns the CSV carries reach no register field

`global-functional-authority-corpora-v2.csv` has an `address_role`, a `coverage` and an `upstream`
column, and the register declares all three unresolved. That is not the build dropping usable data.
Over the 421 rows it keeps, `address_role` reads `varies` on all 421, `coverage` reads
`country-specific` on all 421, and `upstream` is empty on all 421. The first two are the research
pass saying it did not determine the field per source.

The build reads the columns and refuses to carry a placeholder, because
`ingestEligibilityProblems` reports "no address role is resolved" and "no coverage has been
measured" as two of its five conditions. The others are the unreviewed license decision, the absent
personal-data review, and a status that records the source as uninspected. Writing `varies`
into `addressRole` would stop both from firing while resolving nothing. A value outside the declared
placeholder set is carried through, and an `address_role` that is neither a placeholder nor an
`AddressRole` fails the build rather than being dropped.

### How an edit to the committed file is detected

The register carries `contentDigest`, a sha256 the build writes over every other field in it.
`readAddressSourceRegister` recomputes it on every read and refuses a file that no longer matches,
naming the regenerate command above.

It exists because no check can regenerate this artifact and compare. The two research CSVs are
working documents under `.notes/`, which is not committed, so a CI job has nothing to rebuild from.
Without a recorded digest, a hand edit to a generated file is invisible: a prose sweep rewrote
`Contracts Finder / Find a Tender` to `Interfaces Finder / Find a Tender` and two other publisher
names, and the structural audit passed, because it checks shape rather than whether a name is the
publisher's (#2352).

The digest covers the register as parsed, not as bytes, because `oxfmt` reformats the file after the
build writes it. It detects an edit rather than attributing one: rerunning the build after a change
produces a new digest, which is the intended path, while editing the committed copy does not.

Of the four artifacts in this directory, the register is the one carrying a digest. The sub-venue
lexicon, the reviewed VE postcode tuples and the license decisions do not. The license decisions are
hand-written by design — that file is an input to this build, not an output of one.

### What the register carries

Two tables rather than one nested list. The jurisdiction table is a complete 250-row enumeration;
the source table is zero or more rows per jurisdiction, 421 over 240 of them. Nesting the second
inside the first would make a jurisdiction nobody researched structurally identical to one whose
list happens to be empty, and no reader could tell which they were looking at.

| research state | jurisdictions | meaning                                                       |
| -------------- | ------------: | ------------------------------------------------------------- |
| `seeded`       |           240 | at least one national source resolved                         |
| `exception`    |             7 | somebody looked and recorded that no ordinary registry exists |
| `unexamined`   |             3 | nothing resolved and nothing ruled out                        |

`exception` and `unexamined` are separate values on purpose: a researched absence is a finding and
an unexamined jurisdiction is not, and collapsing them would let a consumer read "we could not look"
as "there is nothing there". Every non-`seeded` row carries a `stateReason`, and the audit refuses
one that does not.

| source status           | rows | meaning                                                                 |
| ----------------------- | ---: | ----------------------------------------------------------------------- |
| `verified-authority`    |  221 | register confirmed; address fields, bulk access and terms not inspected |
| `retained-original`     |  142 | carried from the earlier memo without recheck; no publisher, no URL     |
| `verified-corpus`       |   29 | a bulk corpus confirmed reachable                                       |
| `verified-corpus-stale` |    1 | reachable, and the copy examined has stopped being updated              |

The `A`/`A~`/`B`/`C`/`D` column is `backboneState`, and it is deliberately not called a tier: this
repository already has locale tiers 1 through 5 in `scope.config.json` and the
`shipped` / `build-local` / `private` tiers in the layer interface.

### Three things the research pass did not resolve, on any row

Say this plainly rather than making a reader discover it by querying:

- **`addressRole` — 0 of 421.** Every row reads `varies`. The specification's section 2 asks for a
  role per source and the pass recorded none, so the research CSV cannot say whether any of these
  sources holds premises, registered offices or mailing addresses.
- **`upstreamLineage` — 0 of 421.** No row records what it was copied from, so two databases carrying
  one upstream submission cannot yet be collapsed into the single observation they are.
- **`coverage` — 0 of 421.** Every row reads `country-specific`, which is a scope rather than a
  measurement. A national portal is not evidence of national coverage.

A later review resolves these per source in `source-resolutions.json`, and the register's `unresolved`
array names any field no row carries yet. The audit checks that claim in both directions: a field
listed there must be absent from every row, and a field not listed must be present on at least one.
The array is empty today, because a review has resolved each of the four on at least one source.

Ask `ingestEligibilityProblems()` rather than reading a status as permission. Of 421 sources it
admits twenty-nine, twenty-eight national, regional or territorial address publications and Italy's
ANAC procurement release, and answers the other 392 with the reasons below.

### Licenses: 54 read, 367 unchecked

All 421 rows point at a decision record of their own. 47 are `elected`, 7 are `refused`, and the
other 367 read `unchecked`, which is a finding rather than a placeholder. The 248 web-researched rows
read `CHECK NATIONAL / DATASET TERMS` verbatim. The other 161 carry an access label from the original
memo — `Free` on 130 rows, `Free-reg` on 15, `Gated` on 2, `Licensed` on 1 and `Varied` on 1, with
six compound labels over the remaining 24, as `Free/varied` on 7 and `Free/gated` on 6 are — which
says what the download costs and grants
nothing, so treating one as permissive would admit a source on a sentence about price.

`unchecked` is a first-class value distinct from a licence reviewed and found permissive, which is
what `elected` records: the terms, the retrieved copy, the version, and why that grant rather than
another. `electedLicenseLabel()` is what the mechanical prefix filter in `utils/license.ts` reads,
and it answers `undefined` for anything not elected.

## `licenses/` — the retrieved texts a decision would be read from

Seven grants as retrieved, each with the URL and the retrieval date at its head, plus the failures a
fetch returned. Written by hand from a fetch rather than by a build, and never edited after
retrieval — a correction is a new retrieval.

The directory carries its own `PROVENANCE.md`, which lists what is there, what could not be
retrieved, and the two readings a retrieval moved. It is named here so a reader of this file knows
the directory is accounted for rather than overlooked.

`ElectedLicense.retrievedCopy` in the source register names a file there, which is how a decision
recorded in `license-decisions.json` points at the text it was made from.

## `license-decisions.json` — licence decisions somebody made by reading terms (#2351)

Hand-written, and the only file in this directory that is. `address-source-register.json` is
generated and rewritten whole on every build, so a decision recorded there is erased by the next run
with no error and a normal-looking count. This file is an input to that build instead.

Each key is a `licenseID` the register already declares. Each value is an `ElectedLicense` or a
`RefusedLicense` minus its `licenseID`, which the build fills from the key so one licence cannot carry
two decisions. `buildSourceRegister` applies these over the `unchecked` defaults it derives from the
research pass's access labels, and refuses a decision naming a licence no source points at.

An election records four things, which the corpus acceptance rules ask for: the elected terms, the
copy they were read from, that copy's version where the publisher gives one, and why this grant and
not another. `auditAddressSourceRegister` refuses an incomplete record and the build refuses a
register that fails its audit, so an incomplete entry never reaches the committed artifact.

**Fifty-four of the register's 421 decisions are recorded**, 47 elected and 7 refused. AusTender's
publisher, the Australian Department of Finance, grants `CC-BY-3.0-AU` in the AusTender Terms of Use
§5.1. DENUE's publisher, INEGI, grants its own free-use terms. INSEE grants `Licence Ouverte 2.0` over
SIRENE in each of nine overseas territories. Kadaster dedicates the Dutch address theme to the public
domain under CC0 1.0, Klimadatastyrelsen licenses the Danish one under CC BY 4.0, and ČÚZK states
`žádné podmínky neplatí` on all 6,259 rights elements of the Czech feed. Maa- ja Ruumiamet dedicates
the Estonian theme to the public domain under CC0 1.0, stated in the ISO 19139 dataset record its own
WFS capabilities links rather than in the capabilities document, whose `Fees` and `AccessConstraints`
read `puudub` and describe the service. The Dirección General del
Catastro grants its own INSPIRE
access-and-use licence over the cadastral addresses of 52 Spanish territorial offices, and the three
foral councils that publish through the same national feed grant their own terms over the rest of
Spain's cadastral addresses: Navarra under `CC-BY-4.0`, Gipuzkoa under `CC-BY-SA-4.0`, and Bizkaia
under a statement naming no instrument. Each is retained under
`internal/strategy/rights-receipts/`. Seven publishers refuse in their own words: the Banque Centrale
des Comores, the ISPF and the Government of Tokelau reserve all rights in a site footer, Kenya's PPRA
and the Central Bank of Libya do the same, Kosovo's PPRC publishes terms whose clause 12(c)
reserves copying, reproduction and derivative works except by its express written agreement, and
Sweden's Lantmäteriet states in the feed that serves its Addresses theme that `Produkten omfattas av
upphovsrätt. Avtal för användning krävs, avgifter för användning tas ut`. The other 365 read
`unchecked`.

**A refusal is recorded as a decision rather than left as an absence, and the research pass's access
label can contradict it.** Sweden's row carries the label `Free`, which describes reaching the feed;
the feed itself requires an agreement and charges fees for use. The label is what prompted the
reading, and the reading is what the register records.

A decision may name a body declared once under `sharedReadings` rather than restating it. One publisher
can hold a licence over several jurisdictions, and a decision is scoped to one publisher in one
jurisdiction, so one reading of INSEE's terms produces nine decisions. Each licence id still carries its
own, so no election spans two jurisdictions; the shared body removes the risk of nine hand-maintained
copies drifting. The build refuses a `sameAs` naming a reading the file does not declare.

Electing terms is necessary and not sufficient. `ingestEligibilityProblems` also requires a resolved
address role per column, measured coverage, and a personal-data review that does not read `present`,
none of which a licence decision touches; those live in `source-resolutions.json`. **Sixteen sources
have exactly one blocking condition left, and fifteen of the sixteen are blocked on their personal-data
reading alone.** That makes the personal-data question one decision gating fifteen sources rather than
a question about one. The sixteenth is Uruguay, blocked on its address role instead.

### Why there are 421 of them rather than 12

A decision is scoped to one publisher in one jurisdiction, so the register carries one per source.
Keying a decision by the research pass's access label alone made it as wide as the label:
`CHECK NATIONAL / DATASET TERMS` covers 248 of the 421 sources across 223 publishers, and `Free`
covers 130 across 21. Recording one election against either would have granted every source under it on a
single reading of one publisher's terms.

Spain was the worked case of the same defect inside one row. `es-mixed-regulatory-1` was named
`Catastro, INE` and carried no publisher, so its decision scoped to the source id and covered two
institutions. The same national feed carries three foral cadastres under their own terms, which the
same pass gave three rows of their own. The 2026-09-30 rights review split the row per publisher, which moved each
row's scope onto its own publisher. Naming the publisher is what makes the scoping work, and a row
that names two defeats it.

The jurisdiction is part of the scope because a publisher name is not unique across states. The pass
wrote `Ministry of Justice` for Belarus, Lebanon and Timor-Leste, `Ministry of Commerce and Industry`
for five countries, and `Commercial-registration authority` as a description rather than a name.

The cost falls on a publisher that genuinely serves several jurisdictions. INSEE covers mainland
France and nine overseas territories, so it holds ten decisions, and a reviewer who reads its terms
once records that conclusion ten times. That is the direction to err in: an over-wide election is the
failure review cannot undo.

## `source-resolutions.json` — source fields a review resolved (#2323)

Hand-written, and an input to the register build for the same reason as `license-decisions.json`: the
build rewrites the register whole.

Each key is a `sourceID` the register declares, and each value carries any of `addressRoles`,
`coverage`, `upstreamLineage` and `personalDataReview`. `buildSourceRegister` applies these over the
rows it derives from the research CSV and refuses a resolution naming a source the register does not
carry, because a resolution that resolves nothing is a typo or a source that has been removed.

The fields live here rather than in the CSV because the CSV is the record of a research pass. All 390
of its non-rail rows write `varies` for `address_role`, `country-specific` for `coverage` and an empty
`upstream`, and no pass has a personal-data column at all. Editing those placeholders would change
what a pass is recorded as having found. A row's other columns are a different matter: a later pass
rewrites one when reading the publisher settles something the earlier pass recorded wrongly, and the
row's `origin` column then names that later pass so the change is legible.

`addressRoles` is keyed by the address column's path in the published record rather than holding one
role for the source, because a publication can carry two roles on one record. AusTender's OCDS release
gives a `counterparty` address for the supplier and a `facility` address for the procuring entity on
every contracting process. Taiwan's GCIS register gives a registered company address and a tax-office
business address in separate columns. `ingestEligibilityProblems` requires at least one column to have
a role, and the audit refuses an empty map, which would read as resolved while stating nothing.

**Forty-nine sources of 421 carry at least one resolved field, and forty-five carry all four.** AusTender
and five OCDS procurement releases are recorded from whole-year measurements of the published data.
The nine SIRENE territories are recorded from INSEE's own `dessin de fichier`. Seven of the fifteen
address publications are recorded from an element census over a whole GML file, the largest being the
Netherlands' 29,677,448,685 bytes and 10,066,060 features and the newest Wallonia's 5,163,917,131
bytes and 1,772,312 features. Denmark's is recorded from the column schema of its GeoPackage instead,
because it publishes the theme as a database, and Finland's and France's from the headers of their
CSVs, every row of which carries exactly the fields that header declares, 24 for Finland and 23 for
France. The remaining four are recorded from every
element of every feature type their WFS publishes, because none of them publishes a file: five types
and 101 properties for Estonia, five and 44 for Slovakia, four and 32 for Flanders, and one type and
19 elements for Poland. Each is retained under `internal/strategy/rights-receipts/`.

**A whole-file census answers what a sample cannot.** Wallonia's 56 element names were counted over
all 5,163,917,131 bytes, which establishes that `ad:locatorName` appears 0 times in the publication
rather than 0 times in the rows that were read. The count is self-checking: `ad:Address`,
`ad:AddressLocator`, `ad:GeographicPosition`, `ad:locator` and `ad:position` each appear 1,772,312
times, as a GML file holds one of each per address, and those 1,772,312 addresses plus the file's
55,766 thoroughfare names, 1,963 address-area names, 598 postal descriptors and 264 administrative-unit
names equal its 1,830,903 `gml:featureMember` elements exactly. A first pass reported those five
counts as 1,772,315, 1,772,316 and 1,772,314, which is how a chunked reader that re-scans its own
overlap announces itself.

**Seventeen sources are ingest-eligible and fifteen have one blocking condition each.** Fourteen of the
fifteen read `personalDataReview: present`. The fifteenth is Uruguay, refused on its address role: no
party object in 127,885 carries an address field of any kind, so that publication is reachable in bulk
and is not an address source.

Sixteen of the seventeen eligible sources are national or regional address publications of European
states: Spain's Dirección General del Catastro, the three foral cadastres of Bizkaia, Gipuzkoa and
Navarra, the Netherlands' Kadaster under CC0 1.0, Denmark's Klimadatastyrelsen under CC BY 4.0,
Czechia's ČÚZK, Estonia's Maa- ja Ruumiamet under CC0 1.0, Slovakia's Ministerstvo vnútra and
Poland's GUGiK under the INSPIRE controlled value for an absence of conditions, the Flemish Region's
agentschap Digitaal Vlaanderen under the Modellicentie voor gratis hergebruik Vlaanderen v1.0, the
Walloon Region's Service public de Wallonie under CC BY 4.0, Finland's Suomen ympäristökeskus under
CC BY 4.0, France's IGN under Licence Ouverte 2.0, Luxembourg's Administration du cadastre et de
la topographie under CC0 1.0, and Norway's Kartverket under CC BY 4.0.

**An elected licence does not make a source eligible, and Switzerland is the worked case.** swisstopo's
own terms grant use, distribution, enrichment, processing and commercial use against a mandatory
source reference, so its licence is elected. Its `personalDataReview` reads `present`, and
`ingestEligibilityProblems` refuses on that alone, so the 3,303,210-row directory stays out. The
licence and the eligibility are separate answers and the register keeps them separate.

**The largest of them is France's Base Adresse Nationale at 26,117,350 rows**, measured by parsing
the whole file, against the `plus de 25 millions d'adresses` its publisher states. Poland's 8,625,921
follows, then the Flemish Region's 4,563,062, Finland's 3,862,373, the Walloon Region's 1,772,312 and
Slovakia's 1,704,196. The INSPIRE Addresses model has no element for a party, so a party reaches a
harmonised publication only through a free-text name element. INSPIRE Annex I makes Addresses a
mandatory theme for every EU member state, so the remaining states are the place to look for more.

**Belgium takes three rows and Finland's is not an INSPIRE service at all.** Belgium's regions publish
separately, so Flanders, Wallonia and Brussels each need their own row, of which the first two are
recorded. Finland's eligible publication is a pair of bulk files on the publisher's own host rather
than a WFS or an ATOM feed, which is why `addressRoles` keys it by two CSV columns, `address_fin` and
`address_swe`, each holding a complete address in its own language.

**A service may answer the theme's name with the national schema.** Poland's download service
publishes one feature type, `ms:AD.Address`, whose element names are the Polish register's own
columns: `miejscowosc`, `ulica`, `numer`, `kod` and `adres`, the last carrying the whole address as
one string. No `ad:ThoroughfareName`, `ad:PostalDescriptor` or `ad:AdminUnitName` type exists there to
join to, so that build needs no component resolution and the personal-data review has to ask what the
columns are rather than whether `AD:LocatorName` is populated. Reading the theme's name as a promise
of the harmonised model would have produced a reader that finds nothing.

**A regional row covers a region.** The Flemish theme's 4,563,062 addresses are the Flemish Region,
and Brussels and Wallonia publish their own services, so a Belgian build needs three rows where a
Danish build needs one. Spain already reads this way, with Catastro's national feed beside three foral
cadastres.

**Switzerland is why that element is opened on every source rather than assumed empty.** Its
`BDG_NAME` is populated on 20,989 of 3,303,210 rows, 0.64%, and every populated value was read: of
1,158 matching a two-capitalised-word shape, 684 carry a structure word and 474 do not, and **at least
twelve of those 474 are a surname and a given name on a row whose category reads `residential`** —
`Chaignat Aimée` in Jura, `Rutz Nelly` and `Frigerio Cesare Vittorio` in Ticino, `NB EFH Lauber Jörg`
in Valais among them. That is a natural person at their home, which this repository decided on
2026-09-30 it would not carry. Every other address publication's name element has read as a place,
farm or building name; this one does not, and a reader that had assumed the element empty would have
admitted it.

`AD:LocatorName` is that free-text element in the INSPIRE model, typed `GeographicalName`, and each
publication has an equivalent: Norway's `adressetilleggsnavn`, populated on 0.92% of 2,603,354 rows
and reading as place and farm names with its own `Kilde` column recording where each value came from,
and Switzerland's `BDG_NAME`. It has to be opened rather
than assumed empty. The Dutch, Czech, Danish, Slovak and Flemish themes leave it unpopulated, Flanders
measured at 0 of 800 addresses over 40 windows across its 4,563,062 and Slovakia at 0 of 800 over 40
windows across its 1,704,196. Estonia fills it on 1,200 of 1,200 addresses sampled over 60 windows
spread across its 729,973, every one typed `siteName` or `buildingName` in the INSPIRE codelist, with
0 of the 1,200 carrying the given-name-and-family-name shape. The values are Estonian farm names,
which is how a rural Estonian address designates its addressable unit.

**A reader that finds the element on one service can miss it on another.** Slovakia nests the locator
and omits the `name` key entirely, so its absence is structural as well as sampled. Estonia flattens
the path to `locator_addresslocator_name_locatorname_name_spelling_text`. One traversal run against
both would report one of them wrongly, which is why each service's measurement states the shape it
read, and why Slovakia's traversal was checked against Estonia before its 0 was recorded.

Those publishers state seven different grants, which is worth knowing before anyone assumes a
mandatory EU theme comes with uniform terms. Kadaster and Maa- ja Ruumiamet dedicate to the public
domain, Denmark, Navarra, Wallonia and Finland's SYKE license under CC BY 4.0, Gipuzkoa under
CC BY-SA 4.0, ČÚZK, the Slovak Ministerstvo vnútra and Poland's GUGiK state the INSPIRE controlled
value for an absence of conditions, each in its own language, IGN grants Licence Ouverte 2.0 over the
Base Adresse Nationale, Catastro and Bizkaia grant their own
access-and-use terms, and Flanders grants its own model licence for free re-use, whose article 4 makes
attribution the sole condition and whose article 5 leaves the licensee holding the intellectual
property in works created from the data. The Directive mandates the data rather than its licence.

**A publisher may state a licence that covers part of what it publishes.** SYKE's record reads
`Avoimen tiedon osalta Creative Commons Nimeä 4.0 Kansainvälinen … Muiden tietotuotteiden osalta
käyttöehdot on määritelty tietoluvassa`: CC BY 4.0 for the open-data part, and a data permit for other
products. Reading the first clause alone would grant what the second withholds, so the publisher's own
terms page settles which files are which, and the two this register records are named `open_address`.
Finland's other address publication states the permit requirement outright: the population register's
building and dwelling data reads `Tietojen käyttöön saaminen edellyttää Digi- ja väestötietoviraston
myöntämää käyttöoikeuslupaa`.

A member state's WFS states its own access terms in fields that are not the data's licence. `Fees`
and `AccessConstraints` in a capabilities document describe what calling the service costs, and the
grant over the data sits in the ISO 19139 dataset record the document links through
`inspire_dls:SpatialDataSetIdentifier`. Estonia's capabilities read `puudub` in both fields while its
dataset record grants CC0 1.0, and Slovakia's read `NONE` while its register record states that no
conditions apply and names CC0, so reading the service fields as the licence understates both grants.
Flanders states the price of the service in `Fees` and sends the reader to each dataset's metadata for
the data's terms, which is where its model licence is named. Poland's read `No fees` and
`No constraints` while its dataset record states `Brak warunków dostępu i użytkowania`, and that
record is linked per feature type rather than through the extended capabilities, whose
`inspire_dls:SpatialDataSetIdentifier` states the unreplaced placeholder `mycode`.

**A service's own count can be wrong in more than one direction at once.** Poland states three
numbers for one type and none is its count: a bare `resultType=hits` answers 1000, which is
MapServer's default feature cap, the same request at `startIndex=1` answers 1, and a feature page
answers `unknown`. `countWFSFeaturesByPaging` in `@mailwoman/core/api` measures such a type by asking
which indices hold a feature, doubling then bisecting, and a page straddling the last index confirms
the boundary. Poland's type holds 8,625,921 features, measured in 51 requests. That function refuses
a service which answers two different `startIndex` values with the same leading feature, because
paging an ignored parameter would measure the page cap instead.

**`Fees` and `AccessConstraints` can disagree in the same document.** Austria's BEV Addresses service
states `Fees` `no conditions apply` and `AccessConstraints` `restricted`, and its path carries a
customer token. Reading the fee field alone records that service as free when its own access field
says otherwise, so both are read before a service is called reachable.

**An HTTP 422 is a validation message naming the fix, where a 404 is an absence.** The export URL in
Slovakia's own capabilities document answers 422 with
`{"loc":["path","collection_record_id"],"msg":"value is not a valid uuid"}`, which places the id in
the path where the capabilities put it in the query, and a second 422 enumerates the permitted
`export_format` values, which exclude the `gmd` the capabilities asks for. Reading those two bodies
turned a record recorded as unreachable into
`https://rpi.gov.sk/api/collection_record/86dea70e-a55b-4241-bd63-4024b3f76b72`. Its own
`downloadable_urls` holds the service's capabilities URL, which is what ties the record to the
service rather than a title match.

**A dataset record may carry more than one instrument, in separate constraint blocks that answer
different questions.** The Flemish Adressen record states `Geen beperkingen op de publieke toegang` in
its access block, and in its re-use block names four things: the model licence for free re-use, two
instruments governing public-task use by GDI-Vlaanderen participants and by bodies that are not
participants, and the attribution string the licensor requires, `Bron: Digitaal Vlaanderen`. Flattening
those blocks loses which instrument governs which re-user.

**An identifier that will not serve its own text may serve it under a file extension.** The Flemish
licence identifier answers `text/html`, `text/turtle`, `application/ld+json` and `application/rdf+xml`
with one 541,080-byte application rendering to its title. The same path with `.ttl` appended returns
the RDF, which states `cc:requires cc:Attribution`, and the record's `rdfs:seeAlso` gives the page
carrying the nine articles.

Denmark also shows that the theme is not always GML: it serves a GeoPackage, so its `addressRoles`
is keyed by a table name rather than an element name.

The eighth is Italy's ANAC procurement release, and it is eligible for a different reason.
`internal/strategy/personal-data-policy-2026-09-30.md` records the operator's decision that a corpus
carries the addresses of organizations and no address of an identifiable natural person. Italy's
release names natural persons among its suppliers and records an address for none of them: 0 of
11,075 supplier parties carry an `address` object, and every address in the release sits on `buyer`
or `payer`, both Italian public entities. Its `addressRoles` names those two fields alone. That
reading is `assessed` rather than `absent`, because the publication does name people.

The other `verified-corpus` sources are business registers and procurement portals where the address
belongs to a party, and some of those parties are natural persons trading on their own account. The
policy document records why a name-shape filter, an organization identifier and a diffusion-status
filter each fail to separate the two kinds of party.

Every measured source places the role differently, which is why the field is a map keyed by a path rather
than one role per source.

- AusTender carries two roles in two column families on one record.
- Companies House carries one role in one family.
- Catastro's INSPIRE AD theme carries one role on the record itself rather than in a column: the
  feature is the address, so the map is keyed by the feature's element name, `AD:Address`.
- SIRENE carries it on a row-level flag: `etablissementSiege` says whether the establishment is its legal
  unit's seat, so the same columns are a `registered-office` address on one row and a `facility` address
  on the next.
- An OCDS release keys addresses by party role, and the roles differ per publisher. Germany uses fifteen
  where AusTender uses two. Italy's `supplier` role carries no address at all, so its addresses are a
  `buyer`'s and a `payer`'s, which is AusTender's shape inverted. Chile carries a region and neither a
  postcode nor a locality on any of 544,754 party objects.

An OCDS role takes a role here only where OCDS's own codelist defines it. Germany's eight extension roles
take none rather than a guessed one.

## `training-manifests/<version>.json` — what reached one base corpus (#2375)

The frozen training manifest `buildCorpus` writes beside the corpus it produced, copied here so a release
path can read it. Each file names the sources that contributed, their row counts, their license label, and
the register decision in force at build time, and carries a `contentDigest` over its own contents. The
corpus `MANIFEST.json` records the same digest as `training_manifest_digest`, so a committed copy that
drifted from the build it claims is detectable; `auditTrainingManifest` recomputes the digest and compares
the source rows against `totalRows`.

`mwops release rights-audit` looks a manifest up by the `training.corpus_version` a package's
`model-card.json` names. Observed 2026-09-28: of the twelve `neural-weights-*` cards, ten carry no
`training.corpus_version` at all and the two that do carry prose rather than a version, so no card yet
resolves to a file here. The record exists for the corpus the next base model trains on.

`v0.7.0-de-holdout.json` is byte-identical to
`/mnt/mw/corpus/versioned/v0.7.0-de-holdout/TRAINING_SOURCES.json`, the file that build wrote. Eleven
sources, 118,938,779 rows, profile `exploratory`, no refusals.

## `builds/<version>/inputs.json` — which adapter read which input (#2375)

The adapter inputs of one base corpus build. `corpus build --inputs <path>` reads this file when the
argument is not JSON text, and `readBuildInputs` resolves each `inputPath` against `$MAILWOMAN_DATA_ROOT`.
The paths are data-root-relative because the predecessor record,
`/mnt/mw/corpus/build-logs/v0.5.0-inputs.json`, names paths under `/mnt/playpen/mailwoman-data/`. Those paths
stopped resolving when the data root moved to `/mnt/mw` on 2026-09-23.

The source data itself is not committed and not reproducible from this repository. What the record
establishes is which path each adapter was pointed at. A corpus `MANIFEST.json` states that for no adapter.

`builds/<version>/OVERLAY_PLAN.json` holds what an overlay assembly was asked to add: the per-file
`parquet`, `source` and `split` triples, the base manifest it extended, the Modal root, and the note.
`assembleOverlayManifest` writes it next to the `MANIFEST.json` it produced, and the copy here is the one a
later assembly on the same base reads. The `v0.6.0-register-surface` plan (66 files in three lists) was
produced by three scripts in a session scratch directory with the old data root written into them, and was
carried into the next assembly as a hand-written list.

No plan exists for `v0.7.0-de-holdout`. Its overlays were assembled before `assembleOverlayManifest`
wrote one, and its `MANIFEST.json` records the `split`, `source` and `path` of each of the 71 labeled
slices while recording the `route` of none. A plan reconstructed from the manifest would therefore assert
a route it cannot read, and that reconstruction is the mechanism `OverlayPlan`'s docstring names: a
hand-placed split reached `v0.6.0-register-surface` through the caller route and put 770 of DE's
validation `source_id`s in train, and the filename was the only record that showed it (#2359). The next
assembly on this base writes its own plan.

The rename receipt for this assembly is
`/mnt/mw/corpus/versioned/v0.7.0-overlay-staging/source-names.json`, beside the files it rewrote. It
records the per-file row count and the md5 over the ordered `source_id` column before and after, verified
on both sides, and the md5 of `lib/recipes/sources.ts` as that file stood when the rewrite ran. Later
edits to the table move that md5, so it dates the rewrite rather than tracking the table.

## `training-manifests/<version>.effective.json` — what reached one trainer (#2383)

The frozen manifest above states what a corpus holds. An effective training manifest states what one
config's audited epoch drew from it, and the two differ by the country filter, the source weights, a zero
weight, the sampler, `augment_exclude_sources` and every overlay merged after the frozen manifest was
written. `effective-manifest.run.ts` derives it from the frozen manifest and an `audit_epoch_mixture`
output, and `mwops release rights-audit` reads `<corpus_version>.effective.json` beside the frozen file.

Each row carries the corpus row count, the config weight, the rows drawn, the rows emitted after
augmentation, and the reason an excluded source was excluded. `emittedButUnrecorded` holds the sources the
epoch emitted that the frozen manifest does not name, with their row counts.

`v0.7.0-de-holdout.effective.json` reads the corpus through
`corpus-python/src/mailwoman_train/configs/v7.0.0-de-holdout-60k.yaml` at seed 43 over 1,000,000 draws. Of
the eleven sources the frozen manifest names, nine drew rows and two carry weight 0.0. Thirty-nine further
sources were emitted under no frozen-manifest entry, 886,620 of the 1,000,000 rows, because the overlays
carrying them were merged after that manifest was written.

## The `surface` column on a corpus built up to `v0.7.0-de-holdout`

`SurfaceOrigin` gained a `rendered` value on 2026-09-29. Before that the enum held `attested`,
`composed` and `invented`, and every one of the 22 adapters declared `attested` while each of them
assembles its row's line from the source's fields. A recipe declared `composed`. So on a corpus built up
to and including `v0.7.0-de-holdout`, `surface` records which stage produced a row rather than whether
the written form is the publisher's:

| recorded value | what it means on those builds                                      |
| -------------- | ------------------------------------------------------------------ |
| `attested`     | an adapter produced the row, and the line is assembled from fields |
| `composed`     | a recipe produced the row                                          |
| `invented`     | a synthetic row matching no published record                       |

Those builds keep the value they recorded, because a built artifact's value is what it said at the time.
A reader needing the distinction on one of them derives it from `source` against the adapter inventory
rather than from `surface`.

From the next build, an adapter that assembles a line declares `rendered`, a recipe declares `composed`,
and `attested` is reserved for a source that publishes the written line itself. No adapter in the tree
emits `attested` today, so a corpus reporting zero attested rows is a correct census rather than a defect.

Measured on `v0.7.0-de-holdout` while this was found: GB holds 813,781 street-bearing rows and every one
reads `composed`, from `rendered-gb`. Its 13,000,821 rows reading `attested` come from `wof-postalcode`
and `wof-admin` and carry no street.

## `reviewed-ve-postcode-tuples.json` — reviewed Venezuelan postcode placement (#1821)

Four geographic facts support the Venezuelan `locality postcode, region` convention. The Barcelona
tuple comes from the Anzoátegui state government's contact address. The Caracas, Sanare, and Santa
Elena de Guairén tuples come from the Universal Postal Union's Venezuela addressing guide. The file
records the publisher, full source address, retrieval date, review status, and source-license note for
each tuple.

Only factual fields are stored. No source prose is copied, and the corpus rows do not claim that either
source published the facts under CC0 or another open-data license. The recipe creates bounded synthetic
case, punctuation, accent, country-tail, and left-context forms while keeping each reviewed
postcode-to-place join unchanged.

## `sub-venue-lexicon.json` — the sub-venue designator lexicon (#35, waves 1–2)

The vocabulary a corpus recipe (and eventually the span proposer) reads to recognize `Terminal 5`,
`North Terminal`, `Concourse B`, `第1ターミナル` as venue-interior structure. Generated, **not
hand-edited**. See `docs/records/engineering/sub-venue-corpus-task.mdx` for why this exists — the short
version is that the `unit` tag was never taught the modifier+designator shape, so closing the class by
decode weight would take a bias scale near 11 nats where the stronger designator+identifier evidence
needed 6.

The one hand-authored input is `corpus/src/tools/sub-venue-promotions.ts`, the curation ledger. The
builder cannot decide that Spanish `terminal` is safe and British `hall` is not, because that is a
judgement about a language's confounds; what it does is APPLY those decisions.

### Regenerate

```sh
mailwoman corpus fetch wikidata-subvenue --out-root $MAILWOMAN_DATA_ROOT/sub-venue/sources

# One extraction per region. ogr2ogr dominates: 44 s for a 340 MB extract, 371 s for Japan's 2.5 GB.
mailwoman corpus sub-venue-extract \
  --pbf $MAILWOMAN_DATA_ROOT/sub-venue/pbf/japan.osm.pbf \
  --out $MAILWOMAN_DATA_ROOT/sub-venue/extracts/japan.jsonl --country JP

mailwoman corpus sub-venue-lexicon \
  --wikidata-dir $MAILWOMAN_DATA_ROOT/sub-venue/sources/wikidata-subvenue \
  --extracts "GB=$E/great-britain.jsonl,DE=$E/germany.jsonl,FR=$E/france.jsonl,ES=$E/spain.jsonl,JP=$E/japan.jsonl" \
  --overture-db $MAILWOMAN_DATA_ROOT/db/poi/poi.db \
  --out corpus/data/sub-venue-lexicon.json
npx oxfmt corpus/data/sub-venue-lexicon.json
```

`$E` is `$MAILWOMAN_DATA_ROOT/sub-venue/extracts`. `--extracts` takes `REGION=path` pairs because the
region is the axis every curation decision is taken on, and no extract filename carries it reliably —
`ile-de-france` is FR, `great-britain` is GB. A bare path lands region `""`, whose surfaces can never
be promoted.

The oxfmt pass is required — committed JSON is oxfmt-clean, which raw `JSON.stringify` cannot
reproduce. The generator is byte-deterministic and oxfmt is too, so the artifact is reproducible from
the same fetch outputs. `sub-venue-lexicon.test.ts` pins determinism directly.

The extract JSONLs and the `.osm.pbf` files are build inputs under
`$MAILWOMAN_DATA_ROOT/sub-venue/` rather than committed.

### Sources, as of the committed build (2026-08-05)

| source          | origin                                             | license             | rows    |
| --------------- | -------------------------------------------------- | ------------------- | ------- |
| Wikidata (WDQS) | `https://query.wikidata.org/sparql`, 8 concept ids | CC0                 | 877     |
| OpenStreetMap   | Geofabrik `great-britain-latest.osm.pbf`           | ODbL                | 254,356 |
| OpenStreetMap   | Geofabrik `germany-latest.osm.pbf`                 | ODbL                | 403,863 |
| OpenStreetMap   | Geofabrik `france-latest.osm.pbf`                  | ODbL                | 251,260 |
| OpenStreetMap   | Geofabrik `spain-latest.osm.pbf`                   | ODbL                | 78,918  |
| OpenStreetMap   | Geofabrik `japan-latest.osm.pbf`                   | ODbL                | 183,999 |
| Overture Places | `poi.db` spatial layer, vintage `2026-05-20.0`     | CDLA-Permissive-2.0 | 9,219   |

**The ODbL question, unchanged from wave 1 and still open for the recipe output.** The committed artifact
contains no OSM geometry and no OSM row. What survives the OSM leg is surface COUNTS — that the token
`ターミナル` appears in 1,215 Japanese feature names — plus the `identifierShapes` distribution, whose
`examples` are gate reference strings (`B32`, `1A`, `16-18`). Facts and short factual strings are not
a substantial extraction from a database, so this table is not treated as a Derived Database. That
reading matches `osm/README.md`'s posture that the ODbL obligation rides on the built recipe output
rather than on code. **A corpus recipe output built from OSM rows IS a derived work, and that question is still not
settled** — it gates step 4 rather than this table.

### What the sources are FOR, and what each cannot do

Overture and OSM fail differently, which is why both are read.

- **Overture (`poi.db`)** is curated venue-interior naming. `concourse` appears 35 times in its
  `airport_terminal` category against 4 in the whole Great Britain OSM extract, and 3 of those 4 are a
  street called CONCOURSE WAY. **But poi.db is four countries** — US 11,521,612 / CA 794,418 /
  FR 721,352 / MX 644,316, and nothing else (measured 2026-08-05). It can attest en-US, en-CA, fr-FR
  and es-MX and nothing else, so a zero count in it is evidence of absence in four countries rather than in
  the world.
- **OSM** reaches any region with a Geofabrik extract, and carries the `name:<lang>` family, which is
  where every non-Latin surface in this table comes from. What it does not carry is a curated notion
  of "interior": 3,204 of Great Britain's 3,273 `hall` hits sit on a `public_transport=platform`,
  because a British bus stop is named after the village hall it stands outside.

The Overture category set is measured rather than guessed. A full scan of all 13,681,698 rows counted, per
category, how many named rows carry a designator token; the ranking is not what a category name
predicts. `gas_station` leads the entire table with 12,996 hits, every one of them `station` inside
"Holiday Station" or "Chevron Station Seward", and `shoe_store` contributes 708 hits of `wing` because
Red Wing sells boots. Four categories survived reading the distribution — `airport_terminal`,
`campus_building`, `pier`, `airport_lounge` — and `overture-subvenue.ts` lists the rejects with the
number that rejected them.

### The wave-1 defect this build fixes

Wave 1 attributed every harvested phrase to `row.designatorID`, the rule that matched the FEATURE.
Because a bus stop tagged `public_transport=platform` is named "Village Hall" or "West Kensington",
**108 of its 133 OSM-derived surfaces named a different record than the one they pointed at**: the
shipped artifact claimed `west → platform`, `hall → platform`, `biggin → platform`, `salon →
platform`. Attribution now runs through a phrase → record index, and the row's own designator is kept
as `context` — which is the axis a confound board needs, since a `hall` on a platform is a bus stop
and a `hall` on a terminal is a hall.

### Head nouns: what the curation pass needed before it could start

Wikidata gives the ENCYCLOPAEDIC name of a concept rather than the designator as addressed. Q849706's
Spanish label is `terminal aeroportuaria`; the form on an envelope is `Terminal`. That is why wave 1
shipped 1,014 uncurated surfaces and could promote none of them — there was nothing promotable in the
table. Two derivations run before the harvest:

- **Latin script — the cognate test.** A token whose ASCII fold shares five leading characters with
  the designator's own id. `terminal aeroportuaria` → `terminal`, `letištní terminál` → `terminál`,
  `havalimanı terminali` → `terminali`. An earlier rule matched against any single-token surface of
  the record and, because Dutch `universiteit` is one, derived `universitario`, `universitaire` and
  twenty more as head nouns of `campus`. Those are the modifier half, and they would have taught the
  harvest to read "Ciudad Universitaria" as sub-venue structure.
- **Han / Kana / Hangul — the shared-substring test.** Every substring of length ≥ 2 carried by two or
  more surfaces of the same record and language, maximal-only, capped at six. `ターミナル` is in none
  of the five Japanese labels on its own — every one is a compound — and it is the form Japanese
  addresses carry. Nothing else in the pipeline can produce it, and the Japan harvest is what confirms
  it: 1,215 attestations.

Run over every non-Latin phrase instead, the second derivation produced 90 fragments of Cyrillic,
Greek, Arabic, Thai, Burmese and Tamil words — `сгра`, `κτίρ`, `ิ่งก่อสร้า` — because those languages
have one surface per concept and the only shared substrings are pieces of one word. None could ever
be counted: nothing in reach attests a Thai or Burmese surface. The derivation is scoped to the four
scripts where it works.

The harvest also gained a script-aware match. `第1ターミナル` has no word boundaries, so the
token-boundary rule that protects Latin script from `Briggate` finds nothing at all in Japanese; for
Han and Kana the match is a substring test, and the Germanic-compound objection does not transfer.

### The curation ledger

`curated: false` is still the default and nothing auto-promotes. A surface becomes curated only by
matching a decision in `sub-venue-promotions.ts`, which names a designator, a phrase AND a locale.
Per-locale because the same token is a designator in one language and a disaster in another.

Every decision below is backed by a census in that locale's own data. `real` counts occurrences in
genuine venue-interior naming; `confound` counts the rest, and the note says what the rest IS — a bare
number is not a board, and "3,273 hits" told nobody that 3,204 of them were bus stops.

| designator | phrase       | locale |  real | confound | what the confound is                                       |
| ---------- | ------------ | ------ | ----: | -------: | ---------------------------------------------------------- |
| gate       | `flugsteig`  | de-DE  |    19 |        0 | nothing — pure aviation term, no collision in German       |
| gate       | `porte`      | fr-FR  |    19 |      927 | Paris city gates and their Métro stations                  |
| hall       | `hall`       | en-GB  |     0 |    3,273 | 3,204 bus stops named after a village hall; Hall Lane/Road |
| hall       | `hall`       | en-US  | 2,095 |   27,081 | City Hall, Kingdom Hall, event halls, dormitory halls      |
| hall       | `hall`       | fr-FR  |    35 |        5 | three English `Town Hall` strings on `name:en` tags        |
| hall       | `halle`      | de-DE  |    32 |      168 | the CITY Halle (Saale) / Halle (Westf), plus village halls |
| pier       | `pier`       | en-GB  |   120 |       44 | Pier Road / Street / Avenue / Terrace — street names       |
| pier       | `pier`       | en-US  |   278 |    2,330 | Pier 1 Imports and franchises, seafood restaurants         |
| terminal   | `terminal`   | ca-ES  |    15 |        0 | nothing                                                    |
| terminal   | `terminal`   | es-ES  |   190 |        0 | nothing                                                    |
| terminal   | `terminal`   | fr-FR  |   169 |        0 | nothing                                                    |
| terminal   | `ターミナル` | ja-JP  | 1,213 |        2 | two `ターミナル前` bus stops, arguably real                |
| wing       | `wing`       | en-GB  |    23 |        6 | the Buckinghamshire village of Wing — Wing Close/Road      |
| wing       | `wing`       | en-US  |     4 |    3,354 | Red Wing boots (676), chicken-wing restaurants (759)       |
| wing       | `wing`       | fr-FR  |     0 |       26 | Wing Chun and Wing Tsun martial-arts clubs                 |

Nine promotions, six rejections. Three pairs carry the whole point of doing this per-locale: `hall` is
0-of-3,273 in Great Britain and 35-of-40 in France; `wing` is 23-of-29 in Great Britain and
4-of-3,358 in the United States; `pier` is promotable in Great Britain and not in the United States.

**The test that separates a promote from a reject is whether SHAPE can isolate the confound**, and it
is checked by enumeration rather than asserted. `halle` keeps a 168-hit confound and is promoted
because dumping all 32 `<halle> <identifier>` hits returns numbered factory, trade-fair and airport
halls — VW Halle 42, Audi GVZ Halle G, Messe West Halle 8 — and not one instance of the city of
240,000 people with the same name. `porte` has a smaller confound ratio in that bucket and is
rejected, because 17 of its 36 shape hits are Porte Saint-Martin, Porte Saint-Denis and Porte
Notre-Dame. Same test killed `pier` for en-US: Pier 1 Imports IS the designator+identifier shape.

**A caveat on `wing`, the designator the corpus task's board rests on.** 24 of its 29 Great Britain
hits sit on a `public_transport=platform`, because British bus stops are named after the hospital wing
they serve. The extractor maps no building wings at all: `aile` in France is **0 hits**, `ala` in
Spain **0**, `flügel` in Germany **0**. The en-GB evidence is a property of British stop naming rather
than of a source that has wings in it, and the localized wing surfaces the corpus task asked for are
out of reach until the extractor gains an `indoor=*` rule or the lexicon gains a hand-seeded surface
list.

**A rejection of a SHIPPED designator is advisory.** `neural/venue-structure.ts` carries a flat
English vocabulary with no locale gate, and `wing`, `terminal` and `concourse` are in it. This table
cannot un-ship them: the `wing` / en-US rejection tells a recipe author which locale to leave out of a
generated line, and it does nothing to stop the span proposer firing on "Red Wing". Giving the shipped
vocabulary a per-locale gate is step 4's problem, and it is the single largest thing the recipe will
want that does not exist yet.

The mechanism does hold for anything the lexicon adds. `pier` is promoted for en-GB and rejected for
en-US, and because it is not in the shipped list, the rejection has teeth: the region-free English
`pier` surface stays `curated: false` and only the 164 Great Britain attestations are marked usable.

### Identifier shapes are per-region now

`Gate A12` is a rendering rather than a string anyone wrote down: all 658 Great Britain `aeroway=gate`
features but 13 are unnamed and carry only a `ref`. The table therefore carries a distribution rather
than a phrase list — and the distribution turns out to differ by country far more than the shared
vocabulary suggests, so a recipe generating `Gate <ref>` for a French address has to sample France's:

| region | gate refs | most common shape      |           second | third           |
| ------ | --------: | ---------------------- | ---------------: | --------------- |
| GB     |       655 | digit 463 (71%)        | letter-digit 19% | digit-letter 8% |
| JP     |       450 | digit 402 (89%)        |  digit-letter 5% | other 3%        |
| FR     |       628 | letter-digit 385 (61%) |        digit 29% | letter 5%       |
| DE     |       642 | letter-digit 387 (60%) |        digit 18% | range 11%       |
| ES     |       493 | letter-digit 189 (38%) |        range 35% | digit 15%       |

Britain and Japan number their gates; France and Germany letter-then-number them (`A37`, `B05`); Spain
is the outlier that gives a third of its gates a RANGE (`B18-B20`, `D42-D43`), which no other country
does at that rate. A generator that samples Great Britain's 71%-bare-digit shape into a Spanish line
produces a plausible string that is wrong about Spain.

### The seed duplicates `neural/venue-structure.ts`

`@mailwoman/corpus` does not depend on `@mailwoman/neural`, so the shipped designator and modifier
lists are re-declared in `sub-venue-lexicon.ts`. That is a drift surface, and
`sub-venue-lexicon.test.ts` pins both lists literally so a change in either place fails a test rather
than passing silently. The right move is still the reverse direction: have `neural/venue-structure.ts`
read a committed lexicon extract and delete both copies.
