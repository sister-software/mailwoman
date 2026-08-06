---
title: Dirty fixture
source-of-truth: true
---

import ObviouslyBrokenComponent from "@site/src/components/ObviouslyBrokenComponent";

# Dirty fixture

This file exists to trip every Mailwoman Vale rule on purpose. It also carries an
import line, a JSX tag, a code fence, and a `<details>` block that each contain
banned words — none of those four should be flagged, because they are ignored by
`.vale.ini`'s TokenIgnores/BlockIgnores, not because the words themselves are safe.

<BadgeObviouslyRobust label="basically fine, ignored" />

```ts
// obviously this comment is robust, comprehensive, and myriad in scope — ignored, it's inside a fence
const ignored = true
```

<details>
<summary>obviously robust summary text — ignored</summary>
This basically comprehensive paragraph inside the details block should also be ignored.
</details>

This design is obviously, basically, and clearly a robust and comprehensive rewrite.

This module is load-bearing and it's not just a convenience wrapper; it is the north star.

The resolver decides to drop low-confidence spans before the pipeline gives up.

The false-positive rate is fairly high, and it happens often near the tile boundary.

This design is seamless, so be honest about the tradeoffs — she was genuine about
the mistake, and the drop rate is significant near the tile boundary.

Enter your ZIP Code and postal code below; we also see geo-code and lat/long typos.

Setting this up is as simple as pasting an access token.
The effortless installer handles the rest, and after that it just works.

Point the datalayer at a data-layer alias, run a text search, then a coordinate lookup.

The FTS5 full-text search index is deliberately NOT a hit here — the `text search` swap
carries a leading-character guard so the shipped FTS vocabulary survives the rule.

The centre of the neighbourhood is 400 metres away, one kilometre — or one metre,
depending on rounding — from the sorting centres in the adjacent neighbourhoods and the
neighbouring towns several kilometres further on.

We normalise the licence text, then normalising it again after normalisation is
normalised, and the batch job normalises everything else; the licences were licenced
and the rows were labelled during labelling, which is a capitalisation problem we
capitalise, capitalised and capitalises around.

Two negative assertions for Spelling.yml live on the next line, and both must stay
quiet: the placetype identifier `neighbourhood` and the Nominatim field `licence` are
backticked, so the markdown parser hands neither to the rule.

```json
{ "licence": "ODbL", "placetype": "neighbourhood", "radius_metres": 400 }
```
