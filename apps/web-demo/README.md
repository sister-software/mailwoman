# `apps/web-demo` — live parser demo

Small server-side demo that loads a `@mailwoman/neural-weights-*` ONNX model and serves a single-page UI for pasting an address and seeing per-token labels + confidence + decoded components.

Hosted at <https://mailwoman.sister.software/> (gated by Cloudflare; behind the playpen host's nginx → systemd `mailwoman-demo.service` on `127.0.0.1:8888`).

## What it shows

- Per-token BIO label + confidence (color-coded chips with confidence bars)
- Decoded components dict (the `first-occurrence-wins` reduction)
- Mean token confidence + model filename
- 7 preset examples covering bitter-lesson kryptonite cases
- Raw JSON response for power users

## Stack

- **Backend**: Python 3.12 + onnxruntime + sentencepiece + numpy. Single-file `server.py`. Built-in `http.server` (no framework dependency). Loads model + tokenizer once on startup; per-request inference is <50 ms on CPU.
- **Frontend**: One `index.html` file, embedded CSS + JS, no build step.

## Configuration (env vars)

| var                   | default                                         | purpose                  |
| --------------------- | ----------------------------------------------- | ------------------------ |
| `PORT`                | `8888`                                          | bind port                |
| `MAILWOMAN_MODEL`     | `/data/models/quantized/model-v0.1.0-int8.onnx` | ONNX file path           |
| `MAILWOMAN_TOKENIZER` | `/data/models/tokenizer/v0.1.0/tokenizer.model` | SentencePiece model path |

Swap to v0.2.0 weights by changing `MAILWOMAN_MODEL` — no code change.

## Run locally

```sh
python3 -m venv venv
venv/bin/pip install onnxruntime sentencepiece numpy
venv/bin/python server.py
# open http://localhost:8888/
```

## Production deployment (playpen host)

See [`playpen/docs/docs/runbooks/adding-a-public-service.md`](../../playpen) for the full pattern. Short version:

- Files installed to `/opt/mailwoman-demo/{server.py,index.html,venv/}` on the playpen host
- `mailwoman-demo.service` systemd unit binds `127.0.0.1:8888`
- nginx server block `mailwoman.sister.software` proxies through host nginx (port 8080) — see `/etc/nginx/sites-available/mailwoman-demo`
- Cloudflare tunnel routes the public hostname to `localhost:8080`
- No authentik gating (public demo)

## What this does NOT do (yet)

- **No browser-side WebGPU** — server-side inference only. The full WebGPU/onnxruntime-web path (per `#47`) needs SentencePiece-in-WASM, which is a real research task. Server-side is fine for the demo; WebGPU is a future enhancement.
- **No rule-baseline comparison** — doesn't yet run mailwoman's existing `AddressRouter` alongside for A/B comparison
- **No request logging or rate limiting** — single-user demo, not a service
- **No history** — query state is client-side only; refresh loses it

## How to update when v0.2.0+ ships

1. Replace the int8 ONNX at `/mnt/playpen/mailwoman-data/models/quantized/`
2. `sudo systemctl restart mailwoman-demo.service`
3. Confirm via `curl -X POST https://mailwoman.sister.software/parse -d '{"text":"..."}'`

The model card warning banner in `index.html` should also be updated to reflect the new version's quality bracket.
