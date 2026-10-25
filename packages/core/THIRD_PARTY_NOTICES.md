# Third-Party Notices — @mailwoman/core

`@mailwoman/core` is distributed under AGPL-3.0-only. Its npm package bundles no data. The vendored
reference data it once carried ships in `@mailwoman/dictionaries`, whose own notices file lists it.
The full project-wide notices list, including data and tools used only when developing Mailwoman, is at
<https://github.com/sister-software/mailwoman/blob/main/THIRD_PARTY_NOTICES.md>.

## Code

**Pelias Parser** — MIT. `@mailwoman/core` began as a TypeScript fork of
[Pelias Parser](https://github.com/pelias/parser). Three modules in this package derive from it
and remain under the MIT license: `lib/tokenization/Graph.ts` from `tokenization/Graph.js`,
`lib/tokenization/Span.ts` from `tokenization/Span.js`, and `lib/tokenization/normalizer.ts`
from `tokenization/normalizer.js`. The rule-based classifiers and `ExclusiveCartesianSolver`,
also derived from Pelias, were removed in v7.0.0 and are in no published package; the last
standalone release carrying them is `@mailwoman/classifiers@6.x`.

The MIT license requires that its copyright notice and permission notice accompany copies of
the software it covers, so both are reproduced here rather than linked:

> The MIT License (MIT)
>
> Copyright (c) 2019 Pelias Contributors
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software
> and associated documentation files (the "Software"), to deal in the Software without
> restriction, including without limitation the rights to use, copy, modify, merge, publish,
> distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
> Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
> BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
