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

The trace records the stage that diverged, and the key identifies the reduction rather than the
raw column. Column names and file names stay as written, because `NamesVerb` refuses only the verb.

The higher score wins, and the hand-authored entries take precedence.
The guard rejects requests with a mismatched port, and the API interface requires `message.id`.
The invariant `candidate.distance <= radius` holds for every returned candidate.
The hypothesis that 4-5 digit pieces cause the postcode drop is not yet supported.
The 2,000-step probe kept parity postcode at 0.986 after it excluded 4–5 digit tokens.
FR date-name rises from 0.351 to 0.369.
MessageBus delivered the message, and the test suite now passes.
The 4-5 digit pieces account for the whole postcode drop (-9.7pp).
Train this config to 8,000 steps.
The provenance grade of a zoning row is either `authoritative` or `inferred`.
Each row has exactly one provenance grade. The grades never merge.
Each artifact contains rows of one provenance grade only.

# Anything after this point has a stable shape.

# Everything here uses the same framing.

# String values preserve their original spelling.

# Sibling nodes share the parent identifier.

# Meaning depends on the surrounding record.

# During a retry, the client reuses its request id.

# Versioning follows the package release.

# Hugging Face hosts model artifacts.

# Birling Gap appears in the source gazetteer.

# Wyoming appears in a state-name field.

# Nursing appears as a source category.

> Awaiting source data, the report remains incomplete.

## Preserved source titles

_Towards Monosemanticity: Decomposing Language Models With Dictionary Learning._
_Right for the Right Reasons: Training Differentiable Models by Constraining their Explanations._
_Shortcut Learning in Deep Neural Networks._
_Measuring Calibration in Deep Learning._
