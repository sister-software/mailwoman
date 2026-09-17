---
title: Clean fixture
---

# Clean fixture

The resolver returns the highest-scoring candidate and reports its confidence score.
The pipeline emits five components: house number, street, city, region, and ZIP Code.
This page documents the ZIP Code lookup and the geocode endpoint.

```ts
const result = pipeline.run(input)
console.log(result.zipCode)
```

<details>
<summary>What if the input has no ZIP Code?</summary>
The resolver falls back to the city centroid and marks the result as approximate.
</details>

The demo ships two locales today, en-US and fr-FR, each backed by its own weights file.

The trace names the stage that diverged, and the key names the reduction rather than the raw
column. Both are the plain verb, which published prose is free to use.

The higher score wins, and the hand-authored entries take precedence.
The guard rejects requests with a mismatched port, and the API contract requires `message.id`.
The invariant `candidate.distance <= radius` holds for every returned candidate.
The hypothesis that 4-5 digit pieces cause the postcode drop is not yet supported.
Excluding 4-5 digit tokens keeps parity postcode at 0.986.
FR date-name rises from 0.351 to 0.369.
MessageBus delivered the message, and the test suite now passes.
The 4-5 digit pieces account for the whole postcode drop (-9.7pp).
Train this config to 8,000 steps.
