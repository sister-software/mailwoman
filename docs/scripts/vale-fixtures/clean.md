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
