# Publishing the API clients

These clients are **not published yet**. The name `mailwoman-client` is available and reserved-by-intent
on **both** registries (verified 404 on `pypi.org/pypi/mailwoman-client/json` and
`crates.io/api/v1/crates/mailwoman-client`, 2026-07-12). This is the runbook for the first publish and
every one after. Nothing here runs automatically — an operator runs it deliberately.

Both packages version independently from the npm `@mailwoman/*` workspaces (they track the OpenAPI
contract, not the engine release). They are not part of `yarn release` / the `publish.yml` CI flow.

---

## Python → PyPI (`mailwoman-client`)

### One-time account setup

1. Create a PyPI account at <https://pypi.org/account/register/> and enable 2FA.
2. Pick one of the two auth routes below.

### Route A — API token (simplest for the first manual publish)

1. <https://pypi.org/manage/account/token/> → create a token. For the very first upload the project
   does not exist yet, so scope the token to **"Entire account"**; after the first publish, replace it
   with a token scoped to just the `mailwoman-client` project.
2. Build, check, upload (verified locally — `twine check` PASSES on both artifacts):

   ```bash
   cd clients/python
   rm -rf dist
   uv build                        # -> dist/mailwoman_client-<v>-py3-none-any.whl + .tar.gz
   uvx twine check dist/*          # metadata sanity
   uvx twine upload dist/*         # username: __token__   password: pypi-AgEI...
   ```

   `uv publish --token pypi-AgEI...` (or `UV_PUBLISH_TOKEN`) is an equivalent one-shot alternative to
   the `twine upload` line.

### Route B — Trusted Publishing (recommended once a release workflow exists)

PyPI Trusted Publishing (OIDC) works even though `sister-software/mailwoman` is private — it verifies a
GitHub OIDC identity, not a public source attestation (this is the key difference from npm provenance,
which the repo's `publish.yml` keeps off for exactly that reason). Configure a **pending publisher** at
<https://pypi.org/manage/account/publishing/> (project `mailwoman-client`, owner `sister-software`, repo
`mailwoman`, the workflow filename, optional environment), then a GitHub Actions job with
`permissions: id-token: write` calls `pypa/gh-action-pypi-publish` — no token stored anywhere.

### Verify

```bash
python -m venv /tmp/vv && /tmp/vv/bin/pip install mailwoman-client
/tmp/vv/bin/python -c "from mailwoman_client import PhotonClient; print(PhotonClient.hosted()._base_url)"
```

---

## Rust → crates.io (`mailwoman-client`)

### One-time account setup

1. Sign in at <https://crates.io/> with GitHub and confirm your email (crates.io refuses to publish until
   the email is verified).
2. <https://crates.io/settings/tokens> → **New Token** (scope `publish-new` + `publish-update`). Then:

   ```bash
   cargo login <crates.io-token>
   ```

### Publish

`cargo package` already succeeds locally (10 files, license SPDX `AGPL-3.0-only OR LicenseRef-Commercial`
validated). Dry-run, then publish:

```bash
cd clients/rust
cargo publish --dry-run          # re-runs progenitor + compiles the packaged crate in isolation
cargo publish
```

Notes:

- The vendored `openapi/*.yaml` (the 3.0 down-converts) ship in the crate; `scripts/downgrade-spec.py`
  does not, and isn't needed at build time. The `include` in `Cargo.toml` pins exactly what ships.
- Consumers build `aws-lc-rs` (rustls' default crypto provider), which needs a **C compiler + CMake** on
  the build host. Call this out in release notes if that's a concern for your audience.

### Verify

```bash
cargo new /tmp/rr && cd /tmp/rr
cargo add mailwoman-client tokio -F tokio/macros -F tokio/rt-multi-thread
cargo build
```
