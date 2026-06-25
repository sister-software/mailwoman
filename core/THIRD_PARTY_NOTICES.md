# Third-Party Notices — @mailwoman/core

`@mailwoman/core` is distributed under AGPL-3.0-only. Its npm package bundles the
third-party reference data listed below (under `data/`) and is redistributed to every
consumer of this package. The full project-wide notices list, including data and tools used
only when developing Mailwoman, is at
<https://github.com/sister-software/mailwoman/blob/main/THIRD_PARTY_NOTICES.md>.

## Code

**Pelias Parser** — MIT. Portions of `@mailwoman/core` (the tokenizer, rule-based
classifiers, and solver) derive from [Pelias Parser](https://github.com/pelias/parser) and
remain under the MIT license.

## Bundled data

**libpostal dictionaries** — MIT. The address-component dictionaries under
`data/libpostal/` and `data/internal/dictionaries/libpostal/` are from
[libpostal](https://github.com/openvenues/libpostal) (© 2015 openvenues). Full license text:
`data/libpostal/LICENSE`.

**Google libaddressinput (chromium-i18n)** — Apache-2.0. The per-country address metadata
under `data/chromium-i18n/ssl-address/` is from Google's
[libaddressinput](https://github.com/google/libaddressinput), fetched from
`chromium-i18n.appspot.com/ssl-address`. Full license text: `data/chromium-i18n/LICENSE`.

**Who's On First** — community/various. The reference dictionaries under
`data/whosonfirst/` are derived from [Who's On First](https://whosonfirst.org/), whose data
draws on several sources with their own licenses. See
<https://www.whosonfirst.org/docs/licenses/>.
