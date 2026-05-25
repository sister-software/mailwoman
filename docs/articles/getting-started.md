---
sidebar_position: 2
title: Getting started
description: Install Mailwoman and parse your first address in 5 minutes.
---

# Getting started

Mailwoman parses address strings into structured components and resolves them against open gazetteer data. It runs in Node.js and the browser.

## Installation

```bash npm2yarn
npm install mailwoman @mailwoman/neural @mailwoman/neural-weights-en-us
```

This installs the CLI, the neural runtime, and the US English model weights (~25 MB). For French addresses, add `@mailwoman/neural-weights-fr-fr`.

## Your first parse

### Node.js

```ts
import { NeuralAddressClassifier } from "@mailwoman/neural"

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const tree = await classifier.parse("350 5th Ave, New York, NY 10118")

for (const node of tree.roots) {
	console.log(`${node.tag}: "${node.value}" (confidence: ${node.confidence.toFixed(2)})`)
}
```

Output:

```
house_number: "350" (confidence: 0.94)
street: "5th Ave" (confidence: 0.72)
locality: "New York" (confidence: 0.65)
region: "NY" (confidence: 0.88)
postcode: "10118" (confidence: 0.91)
```

### CLI

```bash
mailwoman parse "350 5th Ave, New York, NY 10118"
```

Add `--resolve` to look up components against the Who's On First gazetteer:

```bash
mailwoman parse "350 5th Ave, New York, NY 10118" --resolve --resolve-db ./wof.sqlite
```

Output format options: `--format json` (default), `--format tuple`, `--format xml`.

### Browser

```ts
import { loadNeuralClassifierFromUrls } from "@mailwoman/neural-web"

const classifier = await loadNeuralClassifierFromUrls({
	modelUrl: "/mailwoman/model.onnx",
	tokenizerUrl: "/mailwoman/tokenizer.model",
})

const tree = await classifier.parse("350 5th Ave, New York, NY 10118")
```

See the [demo page](/demo) for a live example with map integration.

## Using the staged pipeline

The `classifier.parse()` call above uses a direct neural path. For the full staged pipeline — normalize → query shape → kind classify → phrase group → token classify → resolve — use `createRuntimePipeline`:

```ts
import { createRuntimePipeline } from "mailwoman"
import { NeuralAddressClassifier } from "@mailwoman/neural"

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const pipeline = createRuntimePipeline({ classifier })

const result = await pipeline("350 5th Ave, New York, NY 10118")
// result.tree — the parsed address
// result.timing — per-stage wall-clock breakdown
// result.queryShape — structural input priors
// result.kind — query category (structured_address, postcode_only, etc.)
// result.phraseProposals — span boundaries from the phrase grouper
```

Fast-path routing: bare postcodes and single localities skip the neural classifier automatically.

## Adding resolution

The resolver turns parsed components into place IDs and coordinates:

```ts
import { createWofResolver } from "@mailwoman/core/resolver"

const resolver = await createWofResolver({ dbPath: "./wof.sqlite" })
const pipeline = createRuntimePipeline({ classifier, resolver })

const result = await pipeline("350 5th Ave, New York, NY 10118")
// result.tree roots now carry wof:id + lat/lon for matched components
```

## Honest caveats

- **The resolver is administrative/postcode-level**, not rooftop. It returns place centroids (locality, region, postcode), not delivery-point coordinates.
- **Neural model quality varies by component.** `house_number` F1 is 0.79. `street` and `venue` are lower. Coarse components (country, region, locality) are better served by the rule-based WOF dictionary classifiers in the hybrid pipeline.
- **Non-Latin scripts have limited support.** The current tokenizer (v0.1.0, 16K vocab) falls back to raw bytes on CJK, Cyrillic, and other non-Latin scripts.
- **Browser cold load is ~60 MB** (25 MB model + 35 MB gazetteer). Cached after first visit.
- **Full-parse exact match is low** (~8% on the golden set). The model is early-stage. The architecture is additive — rule classifiers handle what the model doesn't.

## Where to go next

- [Status](/docs/status) — what ships, what's experimental
- [API reference](/docs/api) — type signatures and configuration
- [How it works now](/docs/understanding/our-approach/how-it-works-now) — the staged pipeline in detail
- [Why a neural parser?](/docs/understanding/our-approach/why-a-neural-parser) — the motivation
