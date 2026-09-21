# `corpus/data/licenses/` — retrieved license texts

The copies a license decision was read from. `ElectedLicense.retrievedCopy` in the source register names a file here,
so a later reviewer checks the same text rather than today's page.

A publisher's page moves. A license is versioned and the page carrying it is not, so a decision recorded against what
the page said cannot be rechecked once it says something else. Each file here is the text as retrieved, with the URL
and the retrieval date at its head, and it is never edited after that — a correction is a new retrieval.

Nothing here elects anything. These are the texts a reading would be made from, and every license decision in
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

The first filename keeps the publisher's own spelling, which is the name of the grant rather than prose.

Five of the seven are here although no register source points at them, because the four runtime bundles'
rights records cite those terms and an operator acts on them today. A file here covering a bundle
rather than a register source is the ordinary case rather than an exception: a source nobody can
ingest is a terms question for later, and a database somebody downloads this week is one for now.

The National Address Database is the sharpest case for that ordering. Its rows are 85,482,142 of the
`us` bundle's 125,276,536, which is 68.2%, and the bundle's record named neither the database nor the
Department of Transportation until a census of the shipped databases' own `source` column found them.

Three of the five retrievals moved a record rather than only backing one up. The Who's On First page
names Ordnance Survey of Northern Ireland and Ordnance Survey Ireland and names Royal Mail nowhere,
so half of the `candidate` bundle's open question was about a body absent from the text.
CDLA-Permissive-2.0 §3.1 states that the agreement imposes no restriction or obligation on Results,
and §5.4 defines Results to include machine learning models, so the `poi` bundle's conditions now
separate what redistributing the database requires from what the model carries. And the National
Address Database's page states both that the data carries no copyright under 17 U.S.C. § 105 and that
it is not intended for use as a mailing list under state statutes, which a record naming only the
first would lose.

A quotation of a grant written in British English sits in a fenced block rather than a blockquote, so
the publisher's own spelling survives a prose sweep. `nlod-2.0.md` is the worked case.

## What could not be retrieved, and what that means

An automated fetch that fails is an unretrieved text rather than a prohibition. Recording the failure keeps the two
apart, because a source with no archived terms and a source whose terms refuse us look identical in a register that
only carries decisions.

| target                   | attempt                                                    | result                         |
| ------------------------ | ---------------------------------------------------------- | ------------------------------ |
| AusTender copyright page | `www.tenders.gov.au/Content/Copyright`, retried 2026-09-21 | HTTP 403 to an automated fetch |

That one needs a person with a browser, or an authenticated retrieval. The result says nothing about what those terms
grant.

**One earlier entry is withdrawn.** NLOD 2.0 was recorded here as returning HTTP 406 from
`data.norge.no/nlod/en/2.0`. The same URL returned HTTP 200 on 2026-09-21, and the SPDX license list
serves the same text as plain text, so the text is retrieved and archived as `nlod-2.0.md`. A single
failed fetch is evidence about one attempt, and recording it as a property of the endpoint was the
wrong reading. Retry before repeating a failure in a durable record.
