# Declared-intent license routes and authenticated delivery of paid tiers

**Status:** design drafted 2026-10-21 from the operator's decisions in the 2026-10-21 session. The builder check ran
the same day, and its questions are answered in the decisions and prerequisites below.
Tracked on [#2773](https://github.com/sister-software/mailwoman/issues/2773).
**Builds on:** the self-service commercial license design (`2026-09-05-self-service-commercial-license-design.md`),
the license posture reporting design (`2026-09-05-license-posture-reporting-design.md`), and the progressive atlas
distribution design (`2026-08-09-progressive-atlas-distribution-design.md`).
**Keeps:** the decision that a key changes what the doctor reports and never what runs.

## The problem

Mailwoman is dual-licensed, `AGPL-3.0-only OR LicenseRef-Commercial`. Every published artifact is free at every depth,
and the one thing a commercial subscription buys is release from the AGPL source offer. The product the operator
intends has a free base tier that is complete and worldwide, deeper tiers that a licensed installation receives, and a
license that is obtained by payment, by a declaration of intent, or by a thirty-day evaluation.

The artifacts that exist today are these. `mailwoman data pull` fetches four bundles from R2, `candidate`, `poi`,
`fr` and `us`, all free. Twelve weights overlays sit on public npm as `@mailwoman/neural-weights-*`. The atlas tiers
of the 2026-08-09 design are not built. This design defines the mechanism and the vocabulary that withholds a paid
artifact and leaves the tier boundaries to the atlas work.

## Goals

- The first run is identical for every user. `npm install mailwoman` works at base precision without a token, a
  declaration or an account, and the two stderr lines are the only sign of the license.
- A paid artifact reaches an installation only through a token the license yields.
- A token is obtained by payment, by declaration, or by evaluation, and each issuance is recorded.
- A token is portable across a licensee's environments.
- A result that could have been more precise with an uninstalled tier states so in its output.
- A wizard performs the first run and offers the routes.
- The pricing, license and getting-started pages describe the tiers in one table.

## Non-goals

- Hardware or machine identifiers. A browser, workerd and most containers have none.
- Seat or activation counting. The pricing page sells one subscription per legal entity across every environment.
- Price amounts and a non-profit discount. Those are operator decisions and change no code here.
- Tier boundaries, artifact sizes and the ODbL publication question, which the atlas and layer-tier work own.

## Anti-goals

The work has failed, even when every test passes, if any of these holds:

- A first install requires an account, an email address or a network call before the first parse.
- An installed deployment degrades when its token expires.
- The `license` field of a package on public npm changes away from `AGPL-3.0-only OR LicenseRef-Commercial`.
- An API response carries the licensee's name or key id.

## Decisions

### Paid artifacts are withheld at download

A paid artifact is fetched by `mailwoman data pull <artifact>`. Without a token, the command refuses before any byte
is transferred and prints the three routes. With a token, the CLI presents it to the license worker's download route,
receives a short-lived presigned URL for the artifact in a private R2 bucket, and downloads it into the data root. The
public bucket behind `PUBLIC_BUCKET_BASE_URL` stays public, so a paid artifact never enters it. The worker presigns
with S3 API credentials held as secrets, because an R2 binding cannot presign, and the operator provisions the bucket
and the credentials per environment as the prerequisites below list. An artifact on disk is read by the same code
paths as a free one, and no runtime path consults the token.

A paid weights overlay is delivered the same way, into the data-root weights overlay that `resolveWeights` already
reads after the package directory. The alternative is a private npm registry in the Font Awesome shape, which needs a
registry service, a token exchange in `.npmrc`, and a second delivery path to test. The data-root path exists and is
the one chosen. A weights overlay that becomes paid is removed from public npm at the release that first withholds
it, and the releases already published stay published.

### The token schema

`LicenseKeyPayloadSchema` in `packages/core/lib/license/key.ts` changes as follows. `terms` becomes a union of
`LicenseRef-Commercial` and `AGPL-3.0-only`. Four claims are added:

| Claim     | Type                                                                           | Meaning                                                                                  |
| --------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `intent`  | `open-source`, `non-profit`, `academic`, `student`, `evaluation`, `commercial` | the route that issued the token                                                          |
| `seq`     | positive integer                                                               | the issuance ordinal within the license, 1 for the first token and incremented each time |
| `install` | UUID string, optional                                                          | the installation id the requesting CLI reported                                          |
| `scope`   | `all`, or a list of package names and `tier:<name>` strings                    | the artifacts the token may download                                                     |

A `tier:<name>` string is the vocabulary the atlas work fills. The schema accepts any name, and the worker's catalog
decides which tier names each plan or intent grants. The signature covers the raw payload bytes, and an older release
strips unknown keys, so a token with the new claims verifies on a release that predates them. A token whose `terms` is
`AGPL-3.0-only` fails the literal in an older release, so the release that ships the union precedes the first declared
token.

`isSelfServicePayload` requires `lid` and `agreement` today. A declared token has a `lid` and no agreement, so the
online status check applies to any token with a `lid`, and `agreement` stays a claim of the commercial route alone.

### The installation id

On its first license or data-pull action, the CLI mints a UUID and writes it to `$MAILWOMAN_CONFIG_ROOT/license/install`
beside the key file. `mailwoman doctor` prints it. Every declare, evaluate, refresh and download request carries it, and
the ledger records it with the request. The token is never bound to it, so a token refreshed on a build machine works
in production. One license with hundreds of installation ids is information for the operator and never a refusal.

### Three routes on the worker

The worker gains three routes beside claim, refresh and status.

`POST /v1/declare` takes an intent other than `evaluation` and `commercial`, a name, and for `open-source` a public
source URL or for the other intents an organization or institution and an email address at it. It writes a license row
and an issuance row and mints a token with `terms: "AGPL-3.0-only"`. For `open-source`, the response carries the token
and the refresh credentials, and the source URL identifies the license. For `non-profit`, `academic` and `student`, the
token goes only to the stated email address through the sender the shop uses, the response carries a claim id, and the
CLI polls the existing claim route until the message is delivered, so the address is a possession proof. A repeat
issuance for any declared license presents the refresh credentials, as a renewal does, and increments `seq`. A
declaration without them creates a new license. On re-issuance of an `open-source`
declaration the worker fetches the declared URL and records `verified` when it resolves to a public repository whose
license file carries an AGPL-compatible identifier, and `unverified` otherwise. Both stay valid.

`POST /v1/evaluate` takes an email address and a name, issues a token with `intent: "evaluation"` and a thirty-day
expiry, and refuses a second evaluation for the same address. The token carries `terms: "AGPL-3.0-only"`, so an
evaluation grants artifact access under the AGPL, releases no obligation, and collects no agreement version. The token
goes only to the address, through the claim route as above, so the worker refuses a second evaluation for an address
only after that address has received the first. Renewal is a declaration or a purchase.

`POST /v1/download` takes a token and an artifact name, verifies the token offline against the register, and checks
that `scope` admits the artifact. A token with a `lid` must also have an `active` ledger state. A token without one, as
`mailwoman license issue` mints for a negotiated agreement, is admitted on offline verification and expiry alone, so an
enterprise licensee receives paid artifacts without a ledger row. The route answers a presigned URL that expires within
the hour. Each download is a ledger row keyed on the `lid` when present, and otherwise on the key id, the licensee and
the installation id.

Each route has its own rate-limit namespace, following the three that exist.

### Expiry

| Intent                      | Expiry                                                                                                                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commercial`                | the billing period end plus fourteen days, as today                                                                                                                                                                   |
| `evaluation`                | thirty days from issue                                                                                                                                                                                                |
| `academic`, `student`       | 365 days from issue                                                                                                                                                                                                   |
| `open-source`, `non-profit` | the lead date nearest to the issue date plus four months, where the lead dates are 21 days before each calendar quarter start, so 11 December, 11 March, 10 June and 10 September, with a tie going to the later date |

The quarter rule gives a token a life between 11 weeks (issued 2026-12-25, expires 2027-03-11) and 24 weeks (issued
2026-12-27, expires 2027-06-10). The CLI notice announces an expiry from 28 days before it. After expiry an installed
artifact keeps running, the download route refuses, and the notice states the lapse and the routes.

### The CLI

`mailwoman license declare` and `mailwoman license evaluate` call the two routes, write the token to the key file as
`adopt` does, and store the refresh credentials beside it. `mailwoman license refresh` re-issues a declaration as it
renews a purchase today.

A valid token whose `terms` is `AGPL-3.0-only` leaves the notice's first sentence in place, because the source offer
still applies, and replaces the second sentence with the declaration and its expiry date. The wording is the
operator's, as the posture design records. The structure is fixed here because a silenced notice would misreport the
posture.

`mailwoman data pull <artifact>` reads the artifact's catalog entry. A free artifact downloads as today. A paid
artifact without a configured token prints the three routes with their commands and exits non-zero. With a token, it
calls the download route.

`mailwoman setup` is an Ink wizard, a Pastel command under `packages/mailwoman/cli/`. It checks the data root and
config root, runs a first parse on a sample address and shows the result, asks which countries matter, lists the
tiers available for them with their size and whether each is free or paid, offers the three routes and a skip, pulls
the chosen artifacts, and ends with the doctor's summary. A `--no-interactive` run performs the checks and the first
parse and prints the tier list without asking. The wizard's tests follow the Ink conventions in
`packages/mailwoman/AGENTS.md`.

### The precision ceiling in output

When a result resolves to a coarser level and the catalog holds an uninstalled tier for that country, the `engine`
block gains a `coverage` entry stating the resolved level, the tier name, and the `data pull` command. The CLI prints
the same sentence under the result. The layer interface's distinction between zero coverage and unknown coverage
decides whether the entry appears, and a country with no tier in the catalog produces no entry.

### The pages

`docs/articles/pricing.mdx` becomes a tier comparison table with three columns, open source, commercial and
enterprise. Its rows are the parser and geocoder, the base weights, the country weights overlays, the atlas tiers
beyond the base, release from the AGPL source offer, OEM redistribution, support, custom fine-tunes and acceptance
suites, the price, and who the tier is for. The declaration routes, open source, academic, student, non-profit and
the thirty-day evaluation, appear as rows under the open-source column. The amounts already published stay.

The `/license` page lists the routes with their commands and links the terms. The getting-started articles under
`docs/articles/developers/get-started/` are revised around `mailwoman setup`. A research page documents the
academic and student routes, the citation, and the data-terms caveats. A `CITATION.cff` is added at the repository
root. It cites the software with its authors, repository URL and version, and carries no DOI, because the repository
has none.

### Placement

No new package is created. The key format and the worker client stay in `@mailwoman/core/license/*`, which already
carries export conditions for workerd and browsers. The commands and the wizard live in `packages/mailwoman/cli/`. The
routes, the catalog and the ledger live in `@mailwoman/license-worker`.

### Release ordering

The release that ships the `terms` union, the new claims and the download client precedes the first declared token
and the first withheld artifact. `RELEASING.md` records the ordering.

## Prerequisites the code cannot supply

These are operator work, and the download route cannot run end to end before them. The implementation does not wait
for them.

1. A private R2 bucket per environment for paid artifacts. The only bucket any wrangler configuration binds today is
   the tile worker's `mailwoman-tiles`, and the public bundle base is `https://public.mailwoman.ai/mailwoman/`.
2. S3 API credentials for that bucket, set as worker secrets, because presigning needs them and an R2 binding cannot
   presign.
3. Three rate-limit namespaces for the declare, evaluate and download routes, following the three that exist.

## Left to the builder

- Route paths, request and response shapes, error words, and rate-limit values.
- The ledger migration's table and index names.
- The email templates for a declared and an evaluation token.
- The wizard's copy and the sample address.
- The pricing table's wording.
- Which countries the wizard asks about and how it maps a country to the tiers in the catalog.
- Test shapes, within the repository's conventions.

## Open operator decision

Whether a lapsed declaration does more than return the notice and refuse new downloads. The alternative is a grace
ladder in authentik's shape, in which the installed paid artifacts stop being read some weeks after lapse. That
alternative puts a check on the request path and conflicts with the anti-goal above, so this design proceeds without
it until the operator decides otherwise.
