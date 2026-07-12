---
sidebar_title: Contributing
title: Contributing & feedback
sidebar_position: 5
hide_footer: true
---

# Contributing & feedback

This page covers how to obtain Mailwoman, how to report bugs or request enhancements, and what a
contribution needs to be accepted. It mirrors the repository's `CONTRIBUTING.md`; where the two
differ, the repository copy governs code contributions and this page will be corrected.

## Obtaining Mailwoman

- **Install from npm:** `npm install mailwoman` (the CLI + library), or any of the scoped
  packages at https://www.npmjs.com/org/mailwoman. Model weights ship as data-only packages
  (`@mailwoman/neural-weights-en-us`, `-fr-fr`).
- **Try it without installing:** the in-browser demo at
  [mailwoman.sister.software/demo](https://mailwoman.sister.software/demo/), or the hosted
  Photon-compatible trial endpoint at `photon.sister.software`
  (e.g. [`/api?q=berlin&limit=3`](https://photon.sister.software/api?q=berlin&limit=3)).
- Getting-started guide: [/docs/getting-started](./getting-started.mdx).

## Feedback: bugs and enhancement requests

- **Email, always answered:** teffen@sister.software — bug reports, enhancement requests, and
  questions. For geocoding bugs, include the input string, the result you got (the trial
  endpoint is fine for reproduction), and the result you expected.
- The full issue tracker accompanies the source repository, which is in the final stage of
  preparation for public release; until then, email is the front door and every report is
  triaged into the tracker.
- A useful bug report for a parser/geocoder is small: one address in, one wrong answer out.
  Reports like that routinely become permanent regression tests within days.

## Contributing

For anything larger than a typo or an obvious fix, get in touch first so we can agree on the
approach before you spend the time. Model-layer work (training, corpus shards, evals) has its
own gates and runbook: [Contributing model work](./plan/CONTRIBUTING_MODEL_WORK.mdx).

### Requirements for acceptable contributions

1. **Contribution terms — DCO + license grant.** Mailwoman is dual-licensed (AGPL-3.0-only or
   commercial; see [Licensing](./licensing/index.md)). Every contribution must arrive under
   terms that permit both: you certify the
   [Developer Certificate of Origin 1.1](https://developercertificate.org/) and sign off each
   commit (`git commit -s`), you retain your copyright, and you grant Teffen Ellis (DBA Sister
   Software) a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use,
   modify, distribute, sublicense, and relicense the contribution — including under the AGPL
   and the commercial license — plus a patent license on AGPL §11 terms. Corporate CLA needed
   instead? Email teffen@sister.software. The complete legal text lives in the repository's
   `CONTRIBUTING.md`.
2. **Coding standard.** TypeScript throughout; linting and formatting are enforced by
   **oxlint + oxfmt** (`yarn lint` must pass — the pre-commit hook runs it on staged files and
   CI runs it repo-wide). Source runs directly under Node (erasable-syntax-only TypeScript: no
   `enum`, no parameter properties); relative imports carry explicit `.ts` extensions. House
   conventions that lint can't express — acronym casing (`parseJSON`, not `parseJson`),
   workspace layout, database idioms — are documented in the repository's `AGENTS.md` and
   apply to all contributions.
3. **Tests.** Tests are co-located (`*.test.ts`, vitest) and `yarn ci:test` must pass. A bug
   fix should arrive with the test that would have caught it. Changes that can move a
   geocoding result face the release gauntlet — the executable regression log, metamorphic
   invariants, and held-out statistical gates described in
   [Methodology](./concepts/methodology.mdx).
4. **Commits and PRs.** Conventional-commit messages (`fix(scope): …`), branched off `main`,
   one concept per PR, CI green (Test + Docs workflows).

Questions that fit none of the above: teffen@sister.software.
