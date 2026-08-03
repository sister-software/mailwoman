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

Enter your ZIP Code and postal code below; we also see geo-code and lat/long typos.
