//! Forward-geocode "berlin" against the hosted Photon trial endpoint and print the top 3 hits.
//!
//! Run: `cargo run --example basic` (hits https://photon.sister.software).
//!
//! Note the alphabetical parameter order — progenitor's positional interface sorts an operation's
//! parameters by name, so `search` takes `(format, lang, lat, layer, limit, lon, osm_tag, q)`.

use std::num::NonZeroU64;

use mailwoman_client::photon::types::{SearchQ, SearchResponse};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = mailwoman_client::photon_hosted(); // https://photon.sister.software
    let q: SearchQ = "berlin".parse().expect("non-empty query");

    let response = client
        .search(None, None, None, None, NonZeroU64::new(3), None, None, &q)
        .await?;

    let features = match response.into_inner() {
        SearchResponse::PhotonFeatureCollection(fc) => fc.features,
        SearchResponse::Array(_) => unreachable!("GeoJSON is the default; JSON-LD needs format=jsonld"),
    };

    for feature in &features {
        let coords = &feature.geometry.coordinates; // [lon, lat]
        let props = &feature.properties;
        let name = props.name.as_deref().unwrap_or("?");
        let kind = props.type_.as_deref().unwrap_or("?");
        let country = props.country.as_deref().unwrap_or("?");
        println!("{name} ({kind}) — {:.4}, {:.4} [{country}]", coords[1], coords[0]);
    }

    assert_eq!(features.len(), 3, "expected 3 features");
    assert_eq!(features[0].properties.type_.as_deref(), Some("city"));
    Ok(())
}
