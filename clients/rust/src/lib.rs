//! Typed Rust clients for Mailwoman's three HTTP drop-in geocoding APIs.
//!
//! Each submodule is generated at compile time by [`progenitor`]'s `generate_api!` proc-macro
//! from the OpenAPI 3.1 spec vendored under `openapi/` — nothing here is hand-written except the
//! thin default-`base_url` constructors below. Regenerate by refreshing the vendored specs (see
//! `clients/README.md`); there is no code to hand-edit.
//!
//! ```no_run
//! # async fn run() -> Result<(), Box<dyn std::error::Error>> {
//! let client = mailwoman_client::photon_hosted();
//! let fc = client.search().q("berlin").limit(3).send().await?;
//! for feature in &fc.features {
//!     println!("{:?}", feature.properties);
//! }
//! # Ok(()) }
//! ```

/// Photon-compatible autocomplete / reverse geocoding client (`/api`, `/reverse`).
pub mod photon {
    progenitor::generate_api!("openapi/photon.yaml");
}

/// Nominatim-compatible geocoding client (`/search`, `/reverse`, `/lookup`, `/status`).
pub mod nominatim {
    progenitor::generate_api!("openapi/nominatim.yaml");
}

/// libpostal-compatible parse / expand client (`/parse`, `/expand`).
pub mod libpostal {
    progenitor::generate_api!("openapi/libpostal.yaml");
}

/// The hosted public Photon trial endpoint (conservative rate limits). Only Photon has a hosted
/// trial; the Nominatim and libpostal drop-ins are self-host only.
pub const PHOTON_HOSTED_BASE_URL: &str = "https://photon.sister.software";

/// Default local `npx @mailwoman/photon serve` base URL.
pub const PHOTON_LOCAL_BASE_URL: &str = "http://127.0.0.1:2322";
/// Default local `npx @mailwoman/nominatim serve` base URL.
pub const NOMINATIM_LOCAL_BASE_URL: &str = "http://127.0.0.1:8080";
/// Default local `npx @mailwoman/libpostal serve` base URL.
pub const LIBPOSTAL_LOCAL_BASE_URL: &str = "http://127.0.0.1:8081";

/// A Photon client pointed at the hosted public trial endpoint ([`PHOTON_HOSTED_BASE_URL`]).
pub fn photon_hosted() -> photon::Client {
    photon::Client::new(PHOTON_HOSTED_BASE_URL)
}

/// A Photon client pointed at a local `serve` server ([`PHOTON_LOCAL_BASE_URL`]).
pub fn photon_local() -> photon::Client {
    photon::Client::new(PHOTON_LOCAL_BASE_URL)
}

/// A Nominatim client pointed at a local `serve` server ([`NOMINATIM_LOCAL_BASE_URL`]).
pub fn nominatim_local() -> nominatim::Client {
    nominatim::Client::new(NOMINATIM_LOCAL_BASE_URL)
}

/// A libpostal client pointed at a local `serve` server ([`LIBPOSTAL_LOCAL_BASE_URL`]).
pub fn libpostal_local() -> libpostal::Client {
    libpostal::Client::new(LIBPOSTAL_LOCAL_BASE_URL)
}
