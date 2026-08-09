# Exhibit 21 against real filings — 2026-08-03

`@mailwoman/filer` reads SEC EDGAR Exhibit 21 ("Subsidiaries of the Registrant") to recover
documented corporate families for FCC broadband filers. The parser shipped in v8.5.0 with a
fixture suite that was fully green.

On 2026-08-03 we ran the assembled chain against 24 public telecom registrants for the first
time. Across the 21 filings it reached, the parser emitted **245 subsidiaries from documents
that state roughly 2,640**. Ten of the 21 yielded nothing at all. Several of the 245 were not
subsidiaries.

This page records what the filings actually contain, what the parser did with them, and what
it does now.

## How the corpus was built

Twenty-four registrant names went in as a caller would supply them (an FCC Form 499 legal
name, say): `resolveCIKCandidates` against `company_tickers.json`, then `fetchTenKFilings`,
then the most recent 10-K's Exhibit 21.

Three names produced no document to parse, all for ordinary reasons: Frontier Communications
Parent has no 10-K on file under that CIK; Consolidated Communications and United States
Cellular each filed a most-recent 10-K carrying no Exhibit 21. A filing without one is
common, not an error.

The other 21 documents were fetched and parsed. Thirteen of them — chosen to cover every
distinct layout in the set, and all under 25 KB — are vendored at
`filer/test-fixtures/edgar/` with a manifest recording each source URL, CIK, accession number
and retrieval date. The other eight (Comcast's Exhibit 21 alone is 960 KB and lists roughly
1,500 subsidiaries) were measured but not committed.

## What the parser did

|                                      | Before       | After |
| ------------------------------------ | ------------ | ----- |
| Subsidiaries emitted, 21 filings     | 245          | 2,640 |
| Subsidiaries emitted, vendored 13    | 45           | 142   |
| Filings yielding zero                | 10           | 1     |
| Fabricated names among those emitted | 18 of the 45 | 0     |

The independent reference implementation described below, run over the same 21 documents,
returns 2,644. The two differ on three filings by a handful of rows each and agree everywhere
else; neither was written against the other's output.

The one remaining zero is correct. AlTi Global's exhibit separates entries with nothing but a
double space, so no name/jurisdiction boundary exists to be found without inventing one.
Abstaining is the required answer there, and the regression suite asserts it.

## Six ways the fixtures were not representative

**The SGML envelope.** EDGAR's archive serves an exhibit inside its submission wrapper:
`<TYPE>EX-21.1`, `<SEQUENCE>3`, `<FILENAME>…`, then the real `<TEXT>` payload, whose HTML
`<head>` carries `<title>Document</title>`. Stripping tags turns each of those into a bare
line. Bandwidth Inc.'s exhibit reported 18 subsidiaries, of which four were `EX-21.1`, `3`,
`q42025exh211listofsubsidia.htm` and `Document`, and the other twelve had the bullet
character `•` as the name and the actual company name as the jurisdiction. Every one of the
18 was wrong.

**Spacer columns.** Word- and Wdesk-exported EDGAR tables put a blank column between name and
jurisdiction. The parser counted cells rather than values, so a two-value row read as
three-wide and abstained. Cable One, Ooma, Verizon, AT&T and Anterix each yielded zero for
this reason alone. The fix drops columns that are blank in every row of a table, which is a
column-wise operation on purpose: filtering blanks row by row discards the fact that a row's
_leading_ cell was blank, and that is the difference between a subsidiary row and an indented
child row.

**One table of several.** The parser read the outermost table and stopped. Lumen's list spans
five sibling tables (207 rows, 42 read); Comcast's spans 33 (1,530 rows, 47 read); Uniti's
eight, Charter's four, T-Mobile's four. Even the filings that appeared to work were reporting
a fraction.

**Unlisted header labels.** Header recognition matched a fixed list of boilerplate phrases.
Liberty Broadband labels its columns "Entity Name" and "Domicile"; WidePoint uses "Full Legal
Name" and "State or Country of Incorporation". Neither was on the list, so both header rows
were emitted as subsidiaries.

**A real third column.** AT&T adds "Conducts Business Under", ATN International adds "Other
name(s) under which entity does business", EchoStar adds both "% of Ownership" and "Name
Doing Business As". A three-value row abstained. It now reads the columns the document's own
header row names — which is not a guess about which of N columns means what, because the
document says.

**Footnote tables.** Reading every table means reading the footnote tables that follow the
list. WidePoint's is `["(1)", "In January 2019, WidePoint Solutions Corp. was merged into…"]`;
EchoStar has four. A row whose first value is a bare footnote marker is counted and dropped.

## Two rules that cost more than they recovered

Both were in the plan, and both were caught by projecting the specified rules over the eight
filings that are _not_ vendored before writing any code.

A per-row test for "this jurisdiction looks like a company name" removes the case where a
two-across list of entity names is misread as name-and-jurisdiction. It also removes 135 of
Charter Communications' 139 subsidiaries, because Charter writes its jurisdiction column as
"Delaware limited liability company". What separates the two cases is repetition rather than
vocabulary: a jurisdiction column repeats (Charter, 9 distinct values over 135 rows; Comcast
0.05; Uniti 0.13; T-Mobile 0.15; Lumen 0.26) and a second name column does not (IDT, 5 over
5). The test is now a table-level one requiring both a designation majority and high
distinctness.

Abstaining when a labelled name column is blank looks safe until you meet an indented
corporate tree. Telephone and Data Systems indents each subsidiary one column to the right of
its parent, and 132 of its 183 subsidiaries sit on such rows. Taking the first non-blank
column between the labelled name column and the labelled jurisdiction column recovers them.
The nesting depth is discarded, which costs nothing here — an Exhibit 21 row becomes a
registrant→subsidiary edge either way.

## What the substring invariant does and does not catch

`exhibit21.ts` has held one invariant since it was written: every emitted name and
jurisdiction must appear in the document as a contiguous string once tags are stripped,
entities decoded and whitespace collapsed. Nothing assembled from pieces the source kept
apart, nothing truncated at a boundary the source did not put there.

It held throughout. `EX-21.1`, `3`, `q42025exh211listofsubsidia.htm`, `Document`, `•`,
`Entity Name` and `Full Legal Name` are all contiguous substrings of their documents. The
invariant is necessary and it is not sufficient, and the real-filing suite now carries a
separate set of assertions naming each of those shapes.

One case does violate it, and only structure catches it. Ooma's last table row is a single
`<td>` holding five `<p>` blocks; cleaning runs them together into one string that reads
`Trunking.IO, LLC FluentStream Corp. FluentStream Intermediate, LLC FluentStream
Technologies, LLC Phone.Com, Inc.` The rule that catches it looks at the cell's raw markup
for a block boundary with text on both sides — the source kept those apart, so the parser
must not join them.

## Ground truth

`filer/test-fixtures/edgar/expected.json` records the subsidiary list each vendored document
states, and the parser is held to it exactly. It was **not** generated from parser output. It
comes from an independent DOM-based implementation in a different language over a real HTML
parser (`filer/test-fixtures/edgar/reference-oracle.py`, kept so the numbers can be
re-derived), read line by line against the source documents.

That distinction is the whole point of this exercise. An `expected.json` generated from the
parser would have recorded, as the contract, the eight zero-yield documents and the eighteen
fabricated names — all of which the hand-written fixture suite was perfectly happy with.

## Name resolution is not solved, and is out of scope here

`resolveCIKCandidates` deliberately returns every candidate above a threshold rather than a
winner, because two different companies can canonicalize to the same name. The corpus run
took the top candidate anyway, to see what that costs. Two of 24 came back a confidently
wrong company: "Altice USA, Inc." resolved to AlTi Global, Inc. (SIC 6282, investment advice)
at 0.829, and "WideOpenWest, Inc." to WidePoint Corp at 0.886.

Both are vendored under their true registrant names, as evidence rather than as an accident.
Anything that writes EDGAR rows into `filer.db` has to corroborate a candidate against
something other than its name; the registrant's SIC code, which the submissions payload
already carries, is the cheapest check available. That work, and the ingest path it gates,
is not part of this change.

A related defect was measured and is worth stating separately: `company_tickers.json` carries
one row per _ticker_, so a registrant with several share classes appears several times under
one CIK. Resolving "Liberty Broadband Corporation" returned the same CIK four times, each at
1.0, and the tie rule — which exists to stop a caller narrowing a genuine collision between
two different companies — reported a four-way tie. The same phantom tie appeared for Comcast,
AT&T, T-Mobile and Telephone and Data Systems.

## Reproducing

The vendored corpus needs no network:

```bash
yarn vitest run filer/sdk/exhibit21-real.test.ts
```

Re-deriving `expected.json` needs `beautifulsoup4` and `lxml` in a virtualenv:

```bash
python filer/test-fixtures/edgar/reference-oracle.py filer/test-fixtures/edgar/*.htm
```

Refetching a document needs `SEC_EDGAR_USER_AGENT` set to a descriptive
`Company Name AdminContact@domain.com` string; every source URL is in
`filer/test-fixtures/edgar/manifest.json`.

## Still open

The parser is correct now, and finding the exhibit inside a filing works:
`findExhibit21Documents` reads an accession's `…-index-headers.html`, whose escaped SGML
manifest gives a type and filename per document, and returns an absolute URL per `EX-21*`.
EDGAR's accession `index.json` cannot answer this — it types every file as a GIF icon name.

Lumen's manifest is vendored for that test. It carries 161 `<DOCUMENT>` blocks while its own
`<PUBLIC-DOCUMENT-COUNT>` says 162; four sequence numbers have no block. Count the blocks.

Beyond that: the CIK corroboration rule, the share-class collapse, and the orchestrator that
walks corroborated registrants into `filer_family` rows. Until those land, nothing from EDGAR
reaches `filer.db` in production — this change makes the parser correct, not the ingest live.
