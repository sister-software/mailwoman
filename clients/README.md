# clients/

Generated, typed API clients for Mailwoman's three HTTP drop-in servers — the Photon-compatible
autocomplete API, the Nominatim-compatible geocoding API, and the libpostal-compatible parse/expand
API. One client per language, each covering all three drop-ins:

| Dir                   | Package (registry)             | Generator                                                                              |
| --------------------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| [`python/`](./python) | `mailwoman-client` (PyPI)      | [`openapi-python-client`](https://github.com/openapi-generators/openapi-python-client) |
| [`rust/`](./rust)     | `mailwoman-client` (crates.io) | [`progenitor`](https://github.com/oxidecomputer/progenitor)                            |

These are **not** yarn workspaces — they're standalone Python / Rust projects with their own
tooling (`ruff`, `cargo`), deliberately outside the JS monorepo (the `corpus-python/` precedent).
Each has its own lint/format config. The root `oxfmt` gate does format the Markdown + `pyproject.toml`
here (oxfmt covers `.md`/`.toml`), so keep those in house style; it leaves the generated `.py`/`.rs`
and the vendored `.yaml` alone, and `oxlint` finds no JS to lint. Build artifacts (`.venv/`,
`target/`, `*.egg-info/`, `.ruff_cache/`, `Cargo.lock`) are git-ignored; the generated source **is**
committed (it is the shipped client).

## The generated-from-spec contract

The client code under `python/mailwoman_client/{photon,nominatim,libpostal}/` and the vendored specs
under `rust/openapi/` are **generated** — do not hand-edit them; they are overwritten on regen. The
only hand-written code is the thin ergonomics layer (`python/mailwoman_client/__init__.py`,
`rust/src/lib.rs`): friendly client classes/constructors with a default `base_url`. To publish, see
[`PUBLISHING.md`](./PUBLISHING.md).

The source of truth is each workspace's `openapi.yaml` (`photon/`, `nominatim/`, `libpostal/` at the
repo root), also served at `https://mailwoman.sister.software/openapi/*.yaml`.

## Regenerate

Run these after the specs change. Both loops read the three specs relative to the repo root.

### Python (`clients/python`)

`openapi-python-client` emits fully relative imports, so the three specs compose as sibling
subpackages under one distributable with no post-processing:

```bash
cd clients/python
for name in photon nominatim libpostal; do
  uvx --from openapi-python-client openapi-python-client generate \
    --path "../../$name/openapi.yaml" \
    --meta none \
    --output-path "mailwoman_client/$name" \
    --overwrite
done
# The generator drops a .ruff_cache under each output dir — remove it.
find mailwoman_client -name .ruff_cache -type d -prune -exec rm -rf {} +
```

### Rust (`clients/rust`)

progenitor parses OpenAPI via the `openapiv3` crate, which only supports 3.0.x. The specs are 3.1,
so regen down-converts them first (deterministic; `scripts/downgrade-spec.py`), then `cargo build`
runs progenitor's `generate_api!` macro over the down-converted specs at compile time:

```bash
cd clients/rust
for name in photon nominatim libpostal; do
  uv run --with pyyaml python scripts/downgrade-spec.py "../../$name/openapi.yaml" "openapi/$name.yaml"
done
cargo build
```

## Smoke

Both clients are verified against the hosted Photon trial endpoint (`https://photon.sister.software`):

```bash
# Python
cd clients/python && uv run --extra dev pytest            # tests/test_smoke_live.py
cd clients/python && uv run python examples/search_berlin.py

# Rust
cd clients/rust && cargo run --example basic
```

Both print the same three "berlin" hits (Berlin DE, Berlin CT, Berlín SV).
