---
title: "USAspending foreign recipients as a PO box source for thin address systems"
description: Evaluation of USAspending FY2023–FY2025 prime financial-assistance transactions to foreign recipients as a training source for po_box and unit rows, with the rights, the personal-data filter, the fields, and the measured yield.
---

# USAspending foreign recipients as a PO box source for thin address systems

#2438 asks whether USAspending's foreign-recipient address lines can supply real `po_box` and `unit`
rows to the training mix, where the building registers hold none. This record states what was read,
what was measured, and the decision.

## The source

USAspending.gov publishes federal award data under the DATA Act. The publishing repository,
`fedspendingtransparency/usaspending-api`, carries the CC0-1.0 license and describes the data as
"open source and provided to the public as part of the DATA Act". The address-source register row
`us-procurement-grants-1` ("SAM.gov / USAspending") carries status `retained-original` with its
license `unchecked`; this record is the reading behind the row's next status, and the change goes
through the register's research input rather than the built register.

The award download (`POST /api/v2/bulk_download/awards/`) accepts a one-year `date_range`, a
`date_type`, `prime_award_types` and `recipient_scope: foreign`. A financial-assistance row carries
`recipient_address_line_1`, `recipient_address_line_2`, `recipient_foreign_city_name`,
`recipient_foreign_province_name`, `recipient_foreign_postal_code`, `recipient_country_code` and
`recipient_country_name`, with `business_types_code` and `record_type_code`. Rows with an action
date on or after 2022-04-04 are past FPDS's Dun & Bradstreet limit, which is why the earlier
thin-systems rows start there.

## Personal data

A corpus carries organization addresses and no natural person's address. USAspending's own rule is
the same: an award to an individual is published as record type 3, "a Non-Aggregate Record to an
Individual Recipient with Redacted Personally Identifiable Information", or aggregated under the
recipient name `MULTIPLE RECIPIENTS`, and "these records omit location information that would
normally be present (street address and the last 4 digits of the ZIP code)". The glossary states
that "Agencies are prohibited from publishing PII on USAspending."

The adapter therefore admits a financial-assistance row only when `record_type_code` is `2` and
`business_types_code` holds neither `P` nor `21`, the two codes `get_business_categories` maps to
`individuals`. A contract row has no individual code; its `sole_proprietorship` flag marks a business
that may sit at a person's home, and a row with that flag is refused for the same reason.

## Yield

The earlier reading (`2026-10-03-label-support-census.md`): 1,029 distinct FY2024 foreign-recipient
address lines across 19 countries, 57 (5.5%) carrying a PO box (`P.O. Box`, `BP`, `Private Bag`,
`Apartado`) and 144 (14.0%) a unit, against 1.2% and 6.1% of training rows.

The FY2023, FY2024 and FY2025 foreign-recipient prime transaction downloads were requested on
2026-10-10 (`All_PrimeTransactions_2026-10-10_H05M26S52909416.zip`, `…S55615934.zip`,
`…S57845551.zip`; 36,382, 36,366 and 35,459 rows, 116 columns each).

| measure                                                         |   value |
| --------------------------------------------------------------- | ------: |
| transactions, three fiscal years                                | 108,207 |
| record type 1 (aggregate) and 3 (individual, redacted), dropped |  23,391 |
| record type 2 with business type `P`, individuals, dropped      |   7,040 |
| kept                                                            |  77,776 |
| distinct address lines (line 1 and line 2 joined)               |  11,392 |
| countries with a kept line                                      |     200 |
| distinct lines with a PO box pattern                            |     411 |
| distinct lines with a unit pattern                              |   1,618 |

The PO box share is 3.6% of distinct lines and the unit share 14.2%, against the FY2024 reading's
5.5% and 14.0%. The PO box lines sit where the thin address systems are: Kenya 63 of 240 lines,
Uganda 35 of 205, Tanzania 18 of 140, Malawi 18 of 93, Zambia 12 of 153, South Africa 11 of 277,
Australia 12 of 143, Cameroon 9 of 99. The forms are `P.O. BOX 2356`, `PO BOX 36207`, `01 BP 1740`,
`13 BP 1885 ABIDJAN 13` and `BP 2720`; the West African `NN BP NNNN <city> NN` form, with the box
district before and after, is the one the invented rows never produced. The measurement script and
the pattern lists are `usaspending-measure.py` in the session scratchpad; the patterns are a lower
bound, because a box written without a marker is not matched.

## Decision

Admitted as a source, with a yield too small to carry `po_box` alone: 411 distinct PO box lines
against the 2,135 invented PO box rows a 200,000-row training draw holds. Its value is the real West
African `BP` forms and the unit lines, which no register in the corpus states. The adapter reads the
three fiscal-year downloads, keeps record type 2 rows whose business type is not `P` or `21`, refuses
`USA` recipients, and labels the box with the span rules the GLEIF adapter already applies to
`PO BOX 309`. The register row `us-procurement-grants-1` moves to elected through the research input
with this record as its reading. The adapter is the next corpus-side task after the from-scratch run's
configuration, so the run that follows #2438 declares its `po_box` floor against the rows that exist
today.
