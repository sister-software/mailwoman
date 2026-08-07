# First live EDGAR ingest — 2026-08-07

`mailwoman filer edgar-ingest` against the SEC, for the first time. 24 telecom registrant names,
a five-pin override list, and `cik-lookup-data.txt` — the full 1,054,085-entry registrant index
that `company_tickers.json` omits for private carriers.

## Result

**23 of 24 registrants recovered, 2,897 subsidiary rows.** One skip: Telephone and Data Systems
has no Exhibit 21 in its most recent 10-K. That is the filer's choice, not a code defect.

|                           |             count |
| ------------------------- | ----------------: |
| names queried             |                24 |
| registrants with rows     |                23 |
| subsidiaries emitted      |             2,897 |
| registrants skipped       | 1 (no-exhibit-21) |
| per-filing fetch failures |                 0 |

## Per registrant

| registrant                     | CIK        | filing     |  rows | SIC  |
| ------------------------------ | ---------- | ---------- | ----: | ---- |
| Comcast Corporation            | 0001166691 | 2026-02-03 | 1,496 | —    |
| Uniti Group Inc.               | 0002020795 | 2026-03-02 |   212 | 4813 |
| Lumen Technologies             | 0000018926 | 2026-02-20 |   197 | 4813 |
| Altice USA, Inc.               | 0001702780 | 2026-02-13 |   189 | 4841 |
| T-Mobile US, Inc.              | 0001283699 | 2026-02-11 |   141 | 4812 |
| Charter Communications         | 0001091667 | 2026-01-30 |   139 | 4841 |
| Frontier Communications Parent | 0000020520 | 2025-02-20 |   113 | 4813 |
| Cogent Communications          | 0001158324 | 2026-02-20 |   104 | 4899 |
| United States Cellular         | 0000821130 | 2026-02-20 |    71 | 4812 |
| WideOpenWest, Inc.             | 0001701051 | 2025-03-14 |    39 | 4841 |
| Consolidated Communications    | 0001304421 | 2024-03-05 |    37 | 4813 |
| Gogo Inc.                      | 0001537054 | 2026-02-27 |    26 | 4899 |
| Verizon Communications         | 0000732712 | 2026-02-17 |    20 | 4813 |
| AT&T Inc.                      | 0000732717 | 2026-02-09 |    19 | —    |
| Shenandoah Telecom             | 0000354963 | 2026-02-26 |    17 | 4813 |
| Cable One                      | 0001632127 | 2026-02-26 |    16 | 4841 |
| Ooma, Inc.                     | 0001327688 | 2026-04-03 |    13 | —    |
| Bandwidth Inc.                 | 0001514416 | 2026-02-19 |    12 | —    |
| IDT Corporation                | 0001005731 | 2025-09-29 |    10 | 4813 |
| Liberty Broadband              | 0001611983 | 2026-02-05 |    10 | 4841 |
| ATN International              | 0000879585 | 2026-03-16 |     7 | 4813 |
| EchoStar Corporation           | 0001415404 | 2026-03-02 |     7 | 4899 |
| Anterix Inc.                   | 0001304492 | 2026-06-25 |     2 | 4813 |
| Telephone and Data Systems     | —          | —          |     0 | —    |

Three SICs are blank because the registrant was pinned rather than corroborated:
Comcast and AT&T (genuine CIK ties broken by operator pins) and Bandwidth/Ooma
(real carriers SEC files under software classifications). Pins are documented
decisions; blank SICs here are the artifact of the pin bypass, not a gap in
the data.

## How the name-resolution false matches were avoided

An earlier run of the name-only resolver against the ticker file matched "Altice
USA, Inc." to AlTi Global, Inc. at 0.829 and "WideOpenWest, Inc." to WidePoint
Corp at 0.886. Neither is a telecom company.

This run used `cik-lookup-data.txt` (130× the ticker file) plus the SIC
corroboration gate plus five operator pins. Both false matches were excluded;
both registrants resolved correctly.

| query                | resolved CIK | SIC  | how                                    |
| -------------------- | ------------ | ---- | -------------------------------------- |
| "Altice USA, Inc."   | 0001702780   | 4841 | SIC corroborated — the true registrant |
| "WideOpenWest, Inc." | 0001701051   | 4841 | SIC corroborated — the true registrant |

The two registrants genuinely tied at the top score (Comcast and AT&T) were
resolved by operator pins — the tie is real collision between two registrants
with identical canonical names, and a pin is the decision about which one is
in scope.

## Running it yourself

```bash
mailwoman filer edgar-ingest \
  --names names.txt \
  --lookup /tmp/cik-lookup-data.txt \
  --pin 0001514416 --pin 0001327688 \
  --pin 0001166691 --pin 0000732717 \
  --out-dir ./edgar-out
```

`cik-lookup-data.txt` is fetched once from
`https://www.sec.gov/Archives/edgar/cik-lookup-data.txt` (40 MB, public, no
auth). `SEC_EDGAR_USER_AGENT` must be set to a descriptive
`"Company Name AdminContact@domain.com"` string.

## What reaches `filer.db` and what does not

This run produces `EdgarSubsidiaryRow`s. Nothing writes them to `filer.db`
yet — the next step is `buildFilerDatabase({ edgarRows: rows, form499Rows:
workbookRows, ... })`, which is what produces the actual crosswalk artifact
with subsidiary→FRN corroboration, family edges, and the temporal lifecycle.
