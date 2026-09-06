# First live EDGAR ingest — 2026-08-07

`mailwoman filer edgar-ingest` against the SEC, for the first time. 24 telecom registrant names,
a five-pin override list, and `cik-lookup-data.txt` — the full 1,054,085-entry registrant index
that `company_tickers.json` omits for private carriers.

**Explore the data:** [Datasette Lite](https://lite.datasette.io/?url=https://public.mailwoman.ai/filer/filer-explore.db&metadata=https://public.mailwoman.ai/filer/filer-explore-metadata.json) — no install, runs in your browser. Canned queries: who-owns, holding-companies, acquisitions-by-year, supersession chains, bankruptcy citations, and more.

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
corroboration check plus five operator pins. Both false matches were excluded;
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

## The filer.db artifact (built 2026-08-08)

The EDGAR rows and the Form 499 workbook were fed to `buildFilerDatabase` together.
The artifact is at `/mnt/playpen/mailwoman-data/filer/filer.db`.

|                     |         |
| ------------------- | ------: |
| artifact size       | 36.8 MB |
| build time          |  20.0 s |
| `filer_node` rows   |  45,215 |
| `filer_edge` rows   |  31,605 |
| `filer_family` rows |   6,929 |
| `filer_attribute`   | 207,500 |
| schema version      |       3 |

|                                   |     count |
| --------------------------------- | --------: |
| same-entity (FRN↔form499ID)       |    18,953 |
| holding-company                   |     5,752 |
| subsidiary (EDGAR Exhibit 21)     |     2,894 |
| superseded-by (Replaced by filer) |     2,826 |
| management-company                |       812 |
| parent-company (family rollup)    |       368 |
| **edges closed by cessation**     | **5,714** |
| **inverted windows abstained**    | **3,992** |

The cessation numbers are the first time `valid_to` has been set on anything. The
3,992 abstentions are the 3,916 filers whose stated cessation date PREDATES their last
filing (an annual form — a carrier that ceased September 2013 still files April 2014)
plus 76 same-day filers. Closing those unconditionally would write inverted windows
that match nothing under `valid_from <= t < valid_to`; open is visibly incomplete,
inverted is invisible.
