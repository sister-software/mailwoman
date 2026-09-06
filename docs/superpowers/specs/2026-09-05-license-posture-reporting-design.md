# License posture reporting: the stderr notice, the `engine` stamp, and the response headers

**Status:** design approved 2026-09-05 (placement, wording rules, and the every-invocation decision chosen by the operator).
**Builds on:** PR #2117 (the signed license key and the doctor's posture line).
**Precedes:** the self-service commercial licensing design (Stripe subscription, license worker), which
links to the same `/license` page and depends on the release that carries this work.

## The problem

Mailwoman is dual-licensed, `AGPL-3.0-only OR LicenseRef-Commercial`. Today the only place an
installation reports which branch applies is `mailwoman doctor`, and the only people who run the
doctor are people who already know it exists. Every other output — a `geocode --json` record, a
Nominatim `/search` result, a Photon FeatureCollection — says nothing about who produced it or
under what terms. A team that deploys the Photon drop-in behind their product has no signal, in the
tool itself, that the AGPL source offer (section 13) attaches to that deployment, or that a
commercial license exists.

The doctor already computes the answer. `runtimeLicenseCheck` in `packages/mailwoman/lib/doctor/checks.ts`
derives the applied branch from `chooseLicenseBranch` and `verifyConfiguredLicenseKey`, and reports the
licensee, key id, and key status. This design puts that same answer where responses already go.

## Decisions taken

**The runtime does not change.** A valid key changes what is reported, never what runs. This holds
the line PR #2117 drew: `doctor` and `license verify` remain advisory, and no code path refuses work
for want of a key.

**One posture, computed once per process.** Every output reads the same value: the applied license
branch, from the same two inputs the doctor uses (the package's `license` expression and the
configured key's offline verification). No output re-derives it.

**No licensee, no key id, in any response.** The doctor prints those locally for the operator. A
Photon deployment serving the public must not carry its operator's commercial relationship in every
response. The stamp says which branch applies and nothing about who holds it.

**The notice prints on every CLI invocation, TTY or not.** A notice that only prints to a terminal
never reaches the deployment it describes. A compliant AGPL user pays two stderr lines they can
redirect. The only thing that silences the notice is a valid key. There is no environment variable.

**Wording uses the doctor's vocabulary.** The doctor reports three obligations: attribution,
share-alike on modifications, and the source offer to network users. The notice states the source
offer, because that is the obligation a network deployment carries and the one the commercial
agreement waives.

**Drop-in protocols are not broken.** A field goes where the protocol has room for one and nowhere
else. Where it has none, headers carry the posture.

## The stamp

One object, snake-case keys to match `intent_markers` and `admin_coherence` on the wire:

```json
"engine": {
  "name": "mailwoman",
  "version": "9.2.0",
  "license": "AGPL-3.0-only",
  "license_url": "https://mailwoman.ai/license",
  "notice": "mailwoman is licensed AGPL-3.0-only: modified or network-served copies must offer their source. A commercial license waives that obligation."
}
```

| Field         | Value                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `name`        | `mailwoman`, constant                                                                                    |
| `version`     | the `mailwoman` package version, from `readMailwomanManifest`                                            |
| `license`     | the applied branch: `AGPL-3.0-only`, or `LicenseRef-Commercial` when the configured key verifies `valid` |
| `license_url` | `${MAILWOMAN_DOCS_URL ?? "https://mailwoman.ai"}/license`, derived the way `licenseKeysWellKnownURL` is  |
| `notice`      | present only when `license` is `AGPL-3.0-only`; absent otherwise                                         |

An expired, unknown, invalid or retired key reads as `AGPL-3.0-only` with the notice present, the
same reading the doctor gives it. The stamp does not say why; the doctor does.

### Home

The type, the notice text, and the pure function that builds a stamp from `(version, verification)`
live in `@mailwoman/core/license` as a new module `packages/core/lib/license/stamp.ts`:

```ts
export interface EngineStamp {
	name: "mailwoman"
	version: string
	license: string
	license_url: string
	notice?: string
}

export function buildEngineStamp(input: {
	version: string
	expression: string
	key?: LicenseKeyVerification
	docsURL?: string
}): EngineStamp
```

`chooseLicenseBranch` supplies `license`; the function is pure and takes `now` through the
verification it is handed, so a test drives `valid`, `expired`, `unknown_key`, `invalid`, and
no-key without a clock.

The version comes from `readMailwomanManifest` in `packages/mailwoman/lib/cli-kit/metadata.ts`, which
is the one read of mailwoman's own manifest and lives in the `mailwoman` package. `@mailwoman/api`
and the three drop-ins may not depend on `mailwoman` (the engine-agnosticism boundary in
`packages/api/lib/schema.ts`), so the `mailwoman` package builds the stamp once and hands it to each
app as an option. Each drop-in's `cli.ts` already wires its engine from `mailwoman`, so the hand-off
point exists; the app packages carry only the type and the placement.

A `resolveEngineStamp()` in the `mailwoman` package memoizes the result for the process: manifest read,
`verifyConfiguredLicenseKey()`, `buildEngineStamp`. The doctor's `runtimeLicenseCheck` keeps its
richer `LicensePosture`; both call `chooseLicenseBranch`, so they cannot disagree on the branch.

## Placement

### The stderr notice

Printed once, at the end of a CLI invocation, by the launcher `packages/mailwoman/lib/cli.ts`:

```
mailwoman is licensed AGPL-3.0-only: modified or network-served copies must offer their source.
A commercial license waives that obligation: https://mailwoman.ai/license
```

The launcher must keep its single static import (its header explains the compile-cache ordering), so
the notice arrives by dynamic import after `dispatchCommand()` resolves and is written before
`process.exitCode` is set. It prints for every exit code, including a usage error, and for `--help`
and `--version`. It does not print when the key verifies `valid`. It prints for an expired key with the
expiry date appended to the first line:

```
mailwoman is licensed AGPL-3.0-only (the configured license key expired on 2026-09-01): modified or network-served copies must offer their source.
```

The text is one function in `stamp.ts`, `licenseNotice(verification)`, returning the two lines or
`undefined`; the launcher writes what it returns. The doctor's `detail` line is unchanged.

The same notice prints once at server startup, in `serveNode` (`packages/api-kit/lib/serve.ts`), after
the `listening on` line, when the app options carry a stamp with a `notice`.

### The response body, per output

| Output                                                       | Placement                                                                   | Constraint that decides it                                                                                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mailwoman geocode --json`                                   | top-level `engine` on each record                                           | `--stdin` emits one record per line, so per record is the only place                                                                                                  |
| `mailwoman reverse --json`                                   | top-level `engine` on the record                                            | same shape                                                                                                                                                            |
| `mailwoman autocomplete --json`                              | `engine` on a wrapping object `{ engine, entries }`                         | today's output is a bare array; wrapping it is a change to that command's `--json` contract, recorded in the CHANGELOG                                                |
| `mailwoman parse --format json`                              | top-level `engine` on the decoded object                                    | `tuple` and `xml` are unchanged                                                                                                                                       |
| `mailwoman geocode --jsonld`                                 | none                                                                        | schema.org vocabulary; a foreign key breaks consumers. The stderr notice still prints                                                                                 |
| `POST /v1/geocode`, `/v1/parse`, `/v1/resolve`, `/v1/format` | top-level `engine` on the response                                          | `GeocodeOutcomeLikeSchema` is `.loose()` and the route passes the outcome through verbatim, so the field is additive; adding it to the schema documents it in OpenAPI |
| `POST /v1/batch`                                             | once, on the envelope beside `results`                                      | one stamp per response, not per row                                                                                                                                   |
| Nominatim `/search`, `/reverse`, `/lookup`                   | `engine` on each result object; `licence` stays the data attribution string | top level is a bare array by protocol; `NominatimResultSchema` is `.loose()`, and geopy and its peers ignore unknown keys                                             |
| Photon `/api`, `/reverse`                                    | `engine` as a foreign member on the FeatureCollection                       | RFC 7946 section 6.1 permits foreign members; `PhotonFeatureCollection` gains the optional field                                                                      |
| libpostal `/parse`, `/expand`                                | none in the body                                                            | `/parse` is a bare array of `{label, value}` by protocol; headers carry the posture                                                                                   |
| `/health`, `/metrics`, `/openapi.json`                       | none in the body                                                            | operational routes; headers carry the posture                                                                                                                         |

### The response headers

Two headers on every HTTP response from every app, set by one api-kit middleware `engineHeaders(stamp)`
that each `create*App` mounts beside its CORS middleware:

```
Server: mailwoman/9.2.0 (AGPL-3.0-only)
Link: <https://mailwoman.ai/license>; rel="license"
```

`rel="license"` is a registered link relation (RFC 8288), so the libpostal drop-in and every proxy in
front of the others report the license without a body change. With a valid key the `Server` header
reads `mailwoman/9.2.0 (LicenseRef-Commercial)` and the `Link` header is unchanged. No app sets a
`Server` header today, so nothing is displaced.

## The `/license` page

`https://mailwoman.ai/license` returns 404 today, as do `/licensing`, `/licensing/commercial` and
`/pricing`. The pages under `docs/records/site-2026-08/licensing/` are records, not routed. This
design adds one routed page, `docs/src/pages/license.mdx`, that states:

- the dual license in one paragraph, with the AGPL obligations in the doctor's vocabulary;
- what a commercial license waives, linking `COMMERCIAL-LICENSE.md`;
- how to obtain one: a contact address now, the Checkout button when the shop opens;
- how a key is configured (`MAILWOMAN_LICENSE_KEY`) and checked (`mailwoman doctor`,
  `mailwoman license verify`).

The URL is the contract; the self-service design places its Payment Link on this page. The path is
`/license`, singular, to match `license_url`, `rel="license"`, and the `license` command.

## Interfaces changed

| Package                   | Change                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@mailwoman/core/license` | new `stamp.ts`: `EngineStamp`, `buildEngineStamp`, `licenseNotice`, the notice text constant; re-exported from `index.ts`                                                   |
| `mailwoman`               | `resolveEngineStamp()` in `cli-kit`; the launcher prints the notice; `geocode`, `reverse`, `autocomplete`, `parse` attach the stamp; each drop-in `cli.ts` passes the stamp |
| `@mailwoman/api-kit`      | `engineHeaders(stamp)` middleware; `serveNode` prints the notice when given a stamp                                                                                         |
| `@mailwoman/api`          | `MailwomanAPIOptions.engine?: EngineStamp`; `engine` on `GeocodeOutcomeLikeSchema`, the parse/resolve/format response schemas, and `BatchResponseSchema`                    |
| `@mailwoman/nominatim`    | `NominatimAppOptions.engine?`; `engine` on `NominatimResultSchema`; `format.ts` attaches it                                                                                 |
| `@mailwoman/photon`       | `PhotonAppOptions.engine?`; `PhotonFeatureCollection.engine?`                                                                                                               |
| `@mailwoman/libpostal`    | `LibpostalAppOptions.engine?`; headers only                                                                                                                                 |
| `@mailwoman/docs`         | `src/pages/license.mdx`                                                                                                                                                     |

The `engine` option is optional on every app so that a test or an embedding application that builds an
app without the `mailwoman` package still works; without it, no body field and no headers are added.
The four `cli.ts` entry points always pass one.

## Verification

Unit, in `packages/core/test/unit/license/stamp.test.ts`:

- `buildEngineStamp` over no key, `valid`, `expired`, `unknown_key`, `invalid`: `license` and the
  presence of `notice` match the doctor's branch for each; `licensee` and `kid` never appear in the
  output, asserted by key enumeration, not by spot check.
- `licenseNotice` returns two lines for the AGPL branch, the expiry-dated variant for `expired`, and
  `undefined` for `valid`.
- `license_url` honours `docsURL` and strips a trailing slash, the way `licenseKeysWellKnownURL` does.

CLI, in `packages/mailwoman/test/`:

- `mailwoman --version` writes the notice to stderr and the bare version string to stdout, so
  `--json` consumers are unaffected.
- `mailwoman geocode --json` and `--stdin` records carry `engine`; `--jsonld` output carries no
  `engine` key.
- With `MAILWOMAN_LICENSE_KEY` set to a token signed by a test key that the test injects as trusted,
  stderr carries no notice and the record's `engine.license` reads `LicenseRef-Commercial`.

HTTP, in each app's existing test file:

- every route, including `/health` and `/openapi.json`, carries both headers when an `engine` option
  is given and neither when it is not;
- Nominatim results carry `engine` and an unchanged `licence`; the Photon collection carries `engine`
  as a top-level member and every feature is unchanged; libpostal bodies are byte-identical with and
  without the option;
- the OpenAPI document emitted by `mailwoman openapi` documents `engine` on the native routes.

Docs: `yarn docs:build` routes `/license`, and the existing link check passes.

## Out of scope

- Any change to the doctor's `LicensePosture` or its `detail` line.
- The MCP server's advertised version (`packages/mcp/lib/server.ts`) and the Fastify plugin; both
  can adopt the stamp later through the same option.
- The library API: no notice on import, no stamp on a `GeocodeResult` returned in-process.
- Payment, checkout, and the license worker: the separate design that follows this one.
