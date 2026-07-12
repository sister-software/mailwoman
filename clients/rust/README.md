# mailwoman-client (Rust)

Typed Rust clients for [Mailwoman](https://mailwoman.sister.software)'s three HTTP drop-in APIs,
**generated at compile time** by [`progenitor`](https://github.com/oxidecomputer/progenitor) from
their OpenAPI specs, exposed as three modules of one crate:

| Module                        | Drop-in for | Endpoints                                   |
| ----------------------------- | ----------- | ------------------------------------------- |
| `mailwoman_client::photon`    | Photon      | `/api`, `/reverse`                          |
| `mailwoman_client::nominatim` | Nominatim   | `/search`, `/reverse`, `/lookup`, `/status` |
| `mailwoman_client::libpostal` | libpostal   | `/parse`, `/expand`                         |

Each module runs `progenitor::generate_api!` over a vendored spec under `openapi/`. The only
hand-written code is the thin constructor layer in `src/lib.rs` (`photon_hosted()`,
`photon_local()`, `nominatim_local()`, `libpostal_local()` — clients pre-pointed at the hosted
trial or the local `serve` ports). See [`../README.md`](../README.md) for the regen command.

> **Note on the spec version.** progenitor parses OpenAPI via the `openapiv3` crate, which only
> understands 3.0.x. Mailwoman's published specs are 3.1, so the regen pipeline down-converts them
> (`scripts/downgrade-spec.py`) before generation; the vendored `openapi/*.yaml` are the 3.0
> derivatives. This is documented and deterministic — not a hand-written client.

## Add it

```toml
[dependencies]
mailwoman-client = "0.1"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

The transport is `reqwest` with **rustls** (no system OpenSSL). rustls' default crypto provider is
`aws-lc-rs`, which builds a small C library — a C compiler and CMake must be on the build host.

## Usage

```rust
use std::num::NonZeroU64;
use mailwoman_client::photon::types::{SearchQ, SearchResponse};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = mailwoman_client::photon_hosted(); // https://photon.sister.software
    let q: SearchQ = "berlin".parse()?;

    // progenitor's positional interface sorts params alphabetically:
    // search(format, lang, lat, layer, limit, lon, osm_tag, q)
    let response = client
        .search(None, None, None, None, NonZeroU64::new(3), None, None, &q)
        .await?;

    if let SearchResponse::PhotonFeatureCollection(fc) = response.into_inner() {
        for feature in &fc.features {
            let [lon, lat] = [feature.geometry.coordinates[0], feature.geometry.coordinates[1]];
            let name = feature.properties.name.as_deref().unwrap_or("?");
            println!("{name} — {lat:.4}, {lon:.4}");
        }
    }
    Ok(())
}
```

`cargo run --example basic` runs exactly this. Verified output (against `https://photon.sister.software`):

```
Berlin (city) — 52.5015, 13.4019 [Germany]
Berlin (city) — 41.6114, -72.7758 [United States]
Berlín (city) — 13.5000, -88.5333 [?]
```

### Self-hosting

`photon_local()` / `nominatim_local()` / `libpostal_local()` point at the local `serve` ports
(2322 / 8080 / 8081). For any other host, construct the module client directly:
`mailwoman_client::nominatim::Client::new("http://…")`. Only Photon has a hosted public trial
endpoint; the Nominatim and libpostal drop-ins are self-host only.

## License

AGPL-3.0-only OR LicenseRef-Commercial (see the [repository](https://github.com/sister-software/mailwoman)).
