# @mailwoman/activity-lexicon

The reviewed activity-phrase lexicon for the [mailwoman](https://www.npmjs.com/package/mailwoman) geocoder: the surface forms a person types for an activity (`pick up a prescription` → `obtain_medication`), each entry carrying the committed record that attests it and the locales it applies to.

Recognition only. This package states nothing about the world — which establishments afford an activity, in which country, on whose authority — that knowledge lives in `@mailwoman/geographic-model`, and a phrase here is valid only when it names an activity concept that model carries. Zero runtime dependencies.

## Provenance discipline

Every entry belongs to one of four attestation classes — a committed query, a derived form of one, a clause quoted from the compiled concept's description, or a regional register copied from a committed synonym — and the test suite re-checks each attestation against its source on every run. [`data/PROVENANCE.md`](./data/PROVENANCE.md) records the rules. An entry without a checkable attestation does not load.

## Release posture

**Do not depend on version `0.0.0`.** It exists to establish the package name. The first supported release ships with the next coordinated mailwoman release, and the API is unstable until a `1.x`.

## License

AGPL-3.0-only OR LicenseRef-Commercial. See the repository root for details.
