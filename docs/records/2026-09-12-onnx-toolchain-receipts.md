# ONNX toolchain receipts — onnxscript 0.7.2 and the onnxruntime producer/consumer gap

Two pins that decide the shipped ONNX graph carried open questions. Both are now measured. The
headline is that one of them did not answer the way the pin comment assumed.

## The rig

Every measurement below is a local A/B in which exactly one package differs. The control is that
exporting the checkpoint at
`$MAILWOMAN_DATA_ROOT/scratch-825/nsplice/bsplice-expanded` under `onnxscript==0.7.0` reproduces the
`model.onnx` sitting beside that checkpoint **byte for byte**
(`sha256:1ff163662dd0d03fa2cfb80db72dc8c392ba5083c0ec33637fabbfb2837824f9`). That file was written
on 2026-07-03 by the Modal image, so the local rig is a faithful stand-in for the image and the only
variable is the package under test.

Without that control the comparison would be a local export against a months-old artifact, which
conflates every pin that moved in between — which is the shape of receipt the previous bump took,
and why it could only report a yes/no on bytes.

## 1. onnxscript 0.7.0 → 0.7.2 changes the graph

Not byte-neutral, unlike the `onnx` 1.21.0 → 1.22.0 bump whose receipt this one was expected to
mirror.

|                   | 0.7.0       | 0.7.2                |
| ----------------- | ----------- | -------------------- |
| fp32 bytes        | 134,687,767 | 134,690,343 (+2,576) |
| int8 bytes        | 33,816,556  | 33,816,563 (+7)      |
| fp32 nodes        | 391         | 379 (−12)            |
| fp32 initializers | 99          | 105 (+6)             |
| initializer bytes | 134,633,816 | 134,634,000 (+184)   |

The twelve nodes 0.7.2 removes are all shape plumbing — one `Mul`, nine `Concat`, two `Reshape` —
and the six initializers it adds are the folded constants. `opset` stays 17, `ir_version` stays 10,
the input and output names are unchanged, and **no weight tensor changed**: of the 98 initializers
present in both graphs, zero differ in bytes. The int8 graph shows the same delta exactly.

The risk in a fold like that is folding a _dynamic_ dimension into a constant, which pins the graph
to the length it was traced at and fails only at some other length. It did not:

| sequence     | fp32                    | int8                    |
| ------------ | ----------------------- | ----------------------- |
| 8            | bit-equal               | bit-equal               |
| 64           | bit-equal               | bit-equal               |
| 128 (traced) | bit-equal               | bit-equal               |
| 192          | both refuse identically | both refuse identically |

The 192 refusal is the 128-row position-embedding table, not a regression — the two graphs refuse
with the same error.

**Consequence for whoever rebuilds an artifact:** a rebuild of anything exported before this pin
will differ in md5 and be correct. `REPRODUCIBILITY.md` said a differing md5 with a passing
promotion eval meant toolchain drift; that instruction is now wrong on its own and has been
rewritten.

## 2. The producer/consumer gap: Python was behind its own consumer

The memory note recorded this as "onnxruntime-web 1.29.0, current release 1.30.0, so the Python side
is four minors behind." The npm half of that is wrong: `onnxruntime-web`'s `latest` dist-tag **is**
1.29.0, and every 1.30.0 on npm is a `-dev.` prerelease. The browser was on current stable; the
Python side was pinned three minors behind the runtime executing its output.

Bumping Python `onnxruntime` 1.26.0 → 1.29.0 to match is **graph-neutral**. Quantizing one fixed
fp32 under each produces a byte-identical int8:

```
sha256 1e9184be72e74af6f89a43dc3f2e3f3d71d024c778c0cbd42f0b25da36617ca6   (both)
opset 17 · 508 nodes · 169 initializers · 385 value_info                  (both)
```

So the bump cannot move what ships.

The two runtimes do **not** execute that graph identically. Running the shipped
`model-v440-suffix-boundary-v2-step-060000-int8.onnx` under each, on inputs written to disk once and
read by both processes so the feed is provably the same:

| probe                                 | worst logit Δ | argmax flips            |
| ------------------------------------- | ------------- | ----------------------- |
| random ids + gaussian channels        | 7.8e-02       | 3 / 200 tokens          |
| ten real addresses, shipped tokenizer | 9.8e-02       | **0 / 172 real tokens** |

The random-input flips are ill-conditioning, not signal: an int8 model's logits on uniform-random
token ids are near-degenerate, so the argmax there is decided by noise. On real addresses the
decision the decoder reads is unchanged on every token of every address.

The right reading is therefore not "the gap was harmless." It is that a graph quantized by one
runtime and served by another was being checked by an instrument that is not the one in the user's
hands, and the difference between those instruments is about 1e-1 on a logit — comfortably enough to
flip a token whose top two labels are close. Closing the gap costs nothing, since the artifact is
byte-identical either way.

`verify_toolchain.py` now refuses a gap between the pyproject pin and both npm call sites, so the
next bump of either side is caught rather than discovered.

## What was not done

The fp32 → int8 → browser path was not re-verified on a real iOS device. The mobile-Safari WebGPU
invariant that `app.py`'s pin comment names is unchanged by either bump on every measurable axis —
opset 17, the same quantization op scheme, the `value_info` strip still exercised, byte-identical
int8 across the runtime bump — but CI cannot exercise WebGPU and neither can this rig. A bump that
_did_ move the opset or the quant scheme would still be a Safari decision requiring a device.
