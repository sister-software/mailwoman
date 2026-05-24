# @mailwoman/neural-web

Browser-side mailwoman neural runtime — drop-in for [`@mailwoman/neural`](https://www.npmjs.com/package/@mailwoman/neural) when targeting a static-asset deploy. Pairs the existing SentencePiece tokenizer + BIO decoder with an [`onnxruntime-web`](https://www.npmjs.com/package/onnxruntime-web) inference path (WebGPU primary, WASM SIMD fallback).

Path B of the demo plan — see [sister-software/mailwoman#98](https://github.com/sister-software/mailwoman/issues/98).

## Status

**v0.1.0 — scaffold + end-to-end smoke test.** `WebOnnxRunner` implements the `NeuralRunner` interface and is composable into `NeuralAddressClassifier` exactly like `OnnxRunner` from `@mailwoman/neural`. Test suite runs the real `@mailwoman/neural-weights-en-us` model through the WASM execution provider in Node — WebGPU is the production-time fast path but isn't testable in Node.

## Quick start

```ts
import { loadNeuralClassifierFromUrls } from "@mailwoman/neural-web"

const classifier = await loadNeuralClassifierFromUrls({
	modelUrl: "/static/mailwoman/model.onnx",
	tokenizerUrl: "/static/mailwoman/tokenizer.model",
	runner: {
		// Optional. If your bundler doesn't put ort .wasm files in the default location,
		// point this at where you serve them.
		wasmPathsRoot: "/static/ort/",
	},
})

const tree = await classifier.parse("123 Main St, Springfield, IL 62704")
console.log(tree.roots)
```

For lower-level control, use `WebOnnxRunner` directly:

```ts
import { WebOnnxRunner, MailwomanTokenizer, NeuralAddressClassifier } from "@mailwoman/neural-web"

const runner = await WebOnnxRunner.fromUrl("/static/mailwoman/model.onnx", { useWebGpu: true })
const tokenizer = await MailwomanTokenizer.loadFromBase64(/* base64 of tokenizer.model */)
const classifier = new NeuralAddressClassifier({ tokenizer, runner })
```

## Execution provider strategy

`WebOnnxRunner` attempts WebGPU first (10× faster than WASM on supported devices — Chromium 113+, Safari Tech Preview, hardware-dependent). If the WebGPU probe fails (no adapter, browser doesn't expose it, etc.), it transparently falls back to the WASM execution provider. Set `useWebGpu: false` to skip the probe entirely — useful in test environments where the failure path adds latency.

## Bundling

This package ships compiled TypeScript only. The `onnxruntime-web` runtime ships its own `.wasm` assets — your bundler needs to serve them. The package's defaults point at a CDN; production deploys typically self-host:

```ts
import { loadNeuralClassifierFromUrls } from "@mailwoman/neural-web"

// Copy node_modules/onnxruntime-web/dist/*.wasm into your /public dir during build,
// then point the runner at them:
const classifier = await loadNeuralClassifierFromUrls({
	modelUrl: "/static/mailwoman/model.onnx",
	tokenizerUrl: "/static/mailwoman/tokenizer.model",
	runner: { wasmPathsRoot: "/ort-wasm/" },
})
```

## Why not extend `@mailwoman/neural` directly?

`@mailwoman/neural` depends on `onnxruntime-node`, which ships native binaries and breaks in a browser bundle. The classifier surface itself is runtime-agnostic — it only needs a `NeuralRunner` (a structural interface with `infer(ids): Promise<InferResult>`). Splitting the runner lets both implementations co-exist without forcing browser bundlers to dead-code-eliminate native code.

## License

AGPL-3.0-only.
