// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! `hrt render-dump`: every tile piece the renderer produces for the parity profile, in the line format of
//! `packages/hrt/parity/RenderDump.java`.
//!
//! Each line is `<z>/<x>/<y> <layer> <id> <geometry type> <scale> s<sort key> g<group or -> <commands>`, so sorting the
//! Java and Rust outputs and comparing them shows each piece the two renderers produce differently.

use std::io::{self, BufWriter, Write};
use std::path::Path;
use std::sync::Mutex;

use hrt_osm::{pass1, pass2};
use hrt_render::{GeometryType, RenderConfig, RenderCounts, RenderedFeature, Renderer};

use hrt_profile::Profile;

fn type_name(geom_type: GeometryType) -> &'static str {
	match geom_type {
		GeometryType::Unknown => "UNKNOWN",
		GeometryType::Point => "POINT",
		GeometryType::Line => "LINE",
		GeometryType::Polygon => "POLYGON",
	}
}

fn line(rendered: &RenderedFeature, layers: &[&str]) -> String {
	let group = rendered
		.group
		.map_or("-".to_owned(), |g| format!("{}:{}", g.id, g.limit));
	let commands = rendered
		.geometry
		.commands
		.iter()
		.map(u32::to_string)
		.collect::<Vec<_>>()
		.join(",");
	format!(
		"{}/{}/{} {} {} {} {} s{} g{} {}\n",
		rendered.z,
		rendered.x,
		rendered.y,
		layers[rendered.layer as usize],
		rendered.id,
		type_name(rendered.geometry.geom_type),
		rendered.geometry.scale,
		rendered.sort_key,
		group,
		commands
	)
}

/// Writes every rendered piece of `input` under `profile` to standard output and returns the renderer's counts.
pub fn dump(input: &Path, profile: &impl Profile) -> io::Result<RenderCounts> {
	let state = pass1(input, |relation| profile.keep_relation(relation))?;
	let out = Mutex::new(BufWriter::new(io::stdout()));
	let totals = Mutex::new(RenderCounts::default());
	// RenderDump.java builds its renderer's config without the input's bounds, so the dump renders whole-world extents.
	let config = RenderConfig::world(profile.max_zoom());
	pass2(input, &state, |source| {
		let mut text = String::new();
		for emitted in profile.process(source) {
			let mut emit = |rendered: RenderedFeature| text.push_str(&line(&rendered, profile.layers()));
			let mut renderer = Renderer::new(config, &mut emit);
			renderer.render(&emitted.feature);
			let counts = renderer.counts;
			totals.lock().unwrap().add(&counts);
		}
		if !text.is_empty() {
			let _ = out.lock().unwrap().write_all(text.as_bytes());
		}
	})?;
	out.into_inner().unwrap().flush()?;
	Ok(totals.into_inner().unwrap())
}
