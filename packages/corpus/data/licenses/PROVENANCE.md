# `corpus/data/licenses/` — retrieved license texts

The copies a license decision was read from. `ElectedLicense.retrievedCopy` in the source register names a file here,
so a later reviewer checks the same text rather than today's page.

A publisher's page moves. A license is versioned and the page carrying it is not, so a decision recorded against what
the page said cannot be rechecked once it says something else. Each file here is the text as retrieved, with the URL
and the retrieval date at its head, and it is never edited after that — a correction is a new retrieval.

Nothing here elects anything. These are the texts a reading would be made from, and every license decision in
`address-source-register.json` still reads `unchecked`.

## What is here

| file                      | publisher                         | retrieved  | how                                     |
| ------------------------- | --------------------------------- | ---------- | --------------------------------------- |
| `licence-ouverte-2.0.md`  | Etalab, for the French government | 2026-09-21 | `etalab/licence-ouverte`, `LO.md`       |
| `sirene-publication.md`   | INSEE, via data.gouv.fr           | 2026-09-21 | the dataset page                        |
| `whosonfirst-licenses.md` | Who's On First, originally Mapzen | 2026-09-21 | the docs page and the repo `LICENSE.md` |

The first filename keeps the publisher's own spelling, which is the name of the grant rather than prose.

The Who's On First file is here although no register source points at it, because the `candidate`
runtime bundle's rights record cites those terms and an operator acts on them today. Its retrieval
also settles half of that record's open question: the page names Ordnance Survey of Northern Ireland
and Ordnance Survey Ireland, and names Royal Mail nowhere.

## What could not be retrieved, and what that means

An automated fetch that fails is an unretrieved text rather than a prohibition. Recording the failure keeps the two
apart, because a source with no archived terms and a source whose terms refuse us look identical in a register that
only carries decisions.

| target                                        | attempt                                               | result                         |
| --------------------------------------------- | ----------------------------------------------------- | ------------------------------ |
| NLOD 2.0, the Norwegian open-government grant | `data.norge.no/nlod/en/2.0`, over both HTTP and HTTPS | HTTP 406 to an automated fetch |
| AusTender copyright page                      | recorded in an earlier pass                           | HTTP 403 to an automated fetch |

Both need a person with a browser, or an authenticated retrieval. Neither result says anything about what those terms
grant.
