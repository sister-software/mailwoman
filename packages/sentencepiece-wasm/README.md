# @mailwoman/sentencepiece-wasm

This package provides the SentencePiece tokenizer compiled to WebAssembly, with native UTF-8 byte offsets for encoded pieces.

Public library. Install with `npm install @mailwoman/sentencepiece-wasm`.

## Encode text

The package contains the WebAssembly binary and its ESM loader. Supply a
compatible `tokenizer.model` separately.

```ts
import createSentencePiece from "@mailwoman/sentencepiece-wasm"

async function encode(modelBytes: Uint8Array, text: string) {
	const module = await createSentencePiece()
	const processor = new module.SentencePieceProcessor()

	try {
		const status = processor.loadFromSerializedProto(modelBytes)

		if (status) throw new Error(status)

		const result = processor.encodeWithOffsets(text)
		if (result.error) throw new Error(result.error)

		return result
	} finally {
		processor.delete()
	}
}
```

Supply model bytes through a file reader or HTTP fetch, then call
`encode(modelBytes, "123 Main Street")`. The tokenizer package has no runtime
dependencies. Applications that encode repeatedly can reuse a loaded processor
and delete it when their tokenizer is disposed.

## Offsets and failures

`loadFromSerializedProto` takes a `Uint8Array`, returns an empty string on
success and returns a status message on failure. Pass binary bytes directly.
A conversion to a JavaScript string changes the model bytes' encoding.

`encodeWithOffsets` returns piece strings, token IDs and corresponding
`begins`/`ends` arrays. Offsets count UTF-8 bytes in the input. They are not
JavaScript UTF-16 string indexes. Convert them before indexing a JavaScript
string, or index the UTF-8 bytes directly.

The binding returns encoding failures in `result.error`. Check that field before
using the arrays.

## Decode and release memory

`decodeIDs` takes the module's `IntVector`:

```ts
const ids = new module.IntVector()

try {
	for (const id of result.ids) ids.push_back(id)
	const text = processor.decodeIDs(ids)
	console.log(text)
} finally {
	ids.delete()
}
```

This fragment runs while the loaded processor and a successful encode result
are still available. Both `SentencePieceProcessor` and `IntVector` own
WebAssembly memory. Call their `delete()` methods when finished.

The loader resolves `sentencepiece.wasm` beside `sentencepiece.mjs` using
`import.meta.url`. A bundled application must preserve or emit that asset.
The binary is also exported as `@mailwoman/sentencepiece-wasm/sentencepiece.wasm`.

## Rebuild the binary

The committed binding currently builds SentencePiece `v0.2.2`.
Consumers use the committed artifacts and do not need Emscripten.

To rebuild, activate an Emscripten SDK and make Git and CMake available. Use a
dedicated SentencePiece checkout because the script checks out its pinned tag.
Then run from the repository root:

```bash
bash packages/sentencepiece-wasm/build.sh
```

`SENTENCEPIECE_SRC` overrides the checkout location. Its default is
`$HOME/tools/sentencepiece`. The script regenerates `sentencepiece.mjs` and
`sentencepiece.wasm` from [`binding.cpp`](binding.cpp). Keep the declaration
file and the training tokenizer compatible with any binding or version change.
The upstream license is preserved in [`LICENSE.sentencepiece`](LICENSE.sentencepiece).

## License

The package declares `AGPL-3.0-only OR LicenseRef-Commercial`.
