# @mailwoman/activity-lexicon

The reviewed activity-phrase lexicon for the [mailwoman](https://www.npmjs.com/package/mailwoman) geocoder: the surface forms a person types for an activity (`pick up a prescription` → `obtain_medication`), each entry carrying the committed record that attests it and the locales it applies to.

Recognition only. This package states nothing about the world — which establishments afford an activity, in which country, on whose authority — that knowledge lives in `@mailwoman/geographic-model`, and a phrase here is valid only when it names an activity concept that model carries. Zero runtime dependencies.

## Provenance discipline

Every entry belongs to one of four attestation classes — a committed query, a derived form of one, a clause quoted from the compiled concept's description, or a regional register copied from a committed synonym — and the test suite re-checks each attestation against its source on every run. [`data/PROVENANCE.md`](./data/PROVENANCE.md) records the rules. An entry without a checkable attestation does not load.

## Release posture

**Do not depend on this package yet.** Its npm name has not been published; it joins the coordinated mailwoman release after the one-time first publish establishes the name (`scripts/bless-package.ts` in the repository — an operator step). Until then it is a sanctioned release absence, recorded in `scripts/release-stage.ts`. When blessed, the change is the same three edits `@mailwoman/geographic-model` made: the `.release-it.json` entry, the sanctioned-absence removal, and the arithmetic in `AGENTS.md` and `scripts/release-stage.test.ts`.

## License

AGPL-3.0-only OR LicenseRef-Commercial. See the repository root for details.
