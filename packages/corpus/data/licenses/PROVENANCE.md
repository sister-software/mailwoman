# `corpus/data/licenses/` — retrieved license texts

This directory holds the copies that license decisions are read from. `ElectedLicense.retrievedCopy` in the source
register points to a file here, so a later reviewer checks the same text instead of the page as it reads that day.

A publisher's page changes over time. A license is versioned but the page that carries it is not, so a decision
recorded against the page cannot be rechecked once the page changes. Each file here holds the text as retrieved, with
the URL and the retrieval date at its head, and is never edited after that. A correction requires a new retrieval.

These files elect no license. They are the texts a license reading would use, and every license decision in
`address-source-register.json` still reads `unchecked`.

## What is here

| file                           | publisher                                      | retrieved  | how                                     |
| ------------------------------ | ---------------------------------------------- | ---------- | --------------------------------------- |
| `licence-ouverte-2.0.md`       | Etalab, for the French government              | 2026-09-21 | `etalab/licence-ouverte`, `LO.md`       |
| `sirene-publication.md`        | INSEE, via data.gouv.fr                        | 2026-09-21 | the dataset page                        |
| `whosonfirst-licenses.md`      | Who's On First, originally Mapzen              | 2026-09-21 | the docs page and the repo `LICENSE.md` |
| `geonames-publication.md`      | GeoNames                                       | 2026-09-21 | the export readme and the about page    |
| `cdla-permissive-2.0.md`       | The Linux Foundation, stewarding the agreement | 2026-09-21 | the SPDX license list, plain text       |
| `nlod-2.0.md`                  | the responsible Norwegian ministry             | 2026-09-21 | the SPDX license list, plain text       |
| `national-address-database.md` | United States Department of Transportation     | 2026-09-21 | the database's own disclaimer page      |

The first filename keeps the publisher's own spelling, because it is the name of the grant.

Five of the seven files are here although no register source points to them. The four runtime bundles' rights records
cite those terms, and an operator acts on them today. A file that covers a bundle instead of a register source is the
ordinary case. The terms for a source that nobody can ingest can wait, but the terms for a database that somebody
downloads this week cannot.

The National Address Database is the strongest reason for putting bundles first. Its rows are 85,482,142 of the `us` bundle's
125,276,536, which is 68.2%. The bundle's record mentioned neither the database nor the Department of Transportation
until a census of the shipped databases' own `source` column found them.

Three of the five retrievals changed a record instead of only supporting one. The Who's On First page lists Ordnance
Survey of Northern Ireland and Ordnance Survey Ireland and never mentions Royal Mail, so half of the `candidate`
bundle's open question concerned a body absent from the text. CDLA-Permissive-2.0 §3.1 states that the agreement
imposes no restriction or obligation on Results, and §5.4 defines Results to include machine learning models. The
`poi` bundle's conditions therefore separate what redistributing the database requires from what the model carries.
The National Address Database's page states both that the data carries no copyright under 17 U.S.C. § 105 and that it
is not intended for use as a mailing list under state statutes. A record that kept only the first statement would lose
the second.

A quotation of a grant written in British English sits in a fenced block instead of a blockquote, so that the
publisher's own spelling survives a prose sweep. `nlod-2.0.md` is an example.

## What could not be retrieved, and what that means

A failed automated fetch leaves a text unretrieved, and it does not indicate a prohibition. Recording the failure
keeps the two cases apart, because a register that only carries decisions would show a source with no archived terms
and a source whose terms refuse use in the same way.

| target                   | attempt                                                    | result                         |
| ------------------------ | ---------------------------------------------------------- | ------------------------------ |
| AusTender copyright page | `www.tenders.gov.au/Content/Copyright`, retried 2026-09-21 | HTTP 403 to an automated fetch |

That page needs a person with a browser or an authenticated retrieval. The result says nothing about what those
terms grant.

**One earlier entry is withdrawn.** NLOD 2.0 was recorded here as returning HTTP 406 from
`data.norge.no/nlod/en/2.0`. The same URL returned HTTP 200 on 2026-09-21, and the SPDX license list
serves the same text as plain text, so the text is retrieved and archived as `nlod-2.0.md`. A single
failed fetch describes one attempt, and the earlier entry was wrong to record it as a property of the
endpoint. Retry before recording a failure in a durable record.
