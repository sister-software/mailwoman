// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Ported from the basemaps fork's text/FontRegistry and text/TextEngine (BSD-3-Clause, Protomaps).

//! Positioned-glyph-font (pgf) encoding of names in scripts MapLibre cannot shape.
//!
//! MapLibre lays glyphs out one codepoint at a time, which draws Devanagari wrongly. The fork shapes such a name with
//! its font, looks each positioned glyph up in an encoding table, and writes the result as a string of Private Use
//! Area codepoints, one per glyph. A style that reads the `pgf:` attribute draws it with a fontstack whose PUA glyphs
//! are those positioned glyphs, so MapLibre places them without shaping.
//!
//! The table key is the glyph id and its offset and advance in 1/64ths of a 1000-unit em. Java computes these values
//! from `Font.layoutGlyphVector` on a 1-point font: HarfBuzz positions in 16.16 fixed point, and advances from
//! FreeType's linear advance. This port computes the same values. The advance is FreeType's formula on the `hmtx`
//! advance. The offset is the shaper's GPOS offset rescaled to 16.16, plus the difference between the shaped
//! advances and the metric advances of the glyphs before it, as Java's `xPosition - sumXAdvances` gives.
//!
//! `pgf-encoding.zip` holds one top-level folder with `fonts/<name>.ttf` and `encoding/<name>-v<version>.csv`.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use harfrust::{
	Buffer, ClusterLevel, Direction, Feature, Font, FontFuncs, GlyphId, Script, ShapeOptions, ShaperFont, Tag,
};

use crate::names::get_script;

/// The fonts the fork registers, as `Basemap.main` loads them: name, encoding version and script.
pub const FORK_FONTS: [(&str, &str, &str); 1] = [("NotoSansDevanagari-Regular", "1", "Devanagari")];

/// The codepoint Java writes for a glyph the table lacks: `!`.
const MISSING_GLYPH: u32 = 33;

/// The offsets Java tries around a glyph's computed key, in order, as (x offset delta, x advance delta).
const DELTAS: [(i32, i32); 41] = [
	(0, 0),
	(-1, 0),
	(0, 1),
	(0, -1),
	(1, 0),
	(-2, 0),
	(-1, 1),
	(-1, -1),
	(0, 2),
	(0, -2),
	(1, 1),
	(1, -1),
	(2, 0),
	(-3, 0),
	(-2, 1),
	(-2, -1),
	(-1, 2),
	(-1, -2),
	(0, 3),
	(0, -3),
	(1, 2),
	(1, -2),
	(2, 1),
	(2, -1),
	(3, 0),
	(-4, 0),
	(-3, 1),
	(-3, -1),
	(-2, 2),
	(-2, -2),
	(-1, 3),
	(-1, -3),
	(0, 4),
	(0, -4),
	(1, 3),
	(1, -3),
	(2, 2),
	(2, -2),
	(3, 1),
	(3, -1),
	(4, 0),
];

/// An encoding-table key: glyph id, x offset, y offset, x advance and y advance, the last four in 1/64ths of a
/// 1000-unit em.
type GlyphKey = (u32, i32, i32, i32, i32);

#[derive(Debug)]
pub enum PgfError {
	Io(io::Error),
	Zip(zip::result::ZipError),
	/// The archive lacks a file the registry needs.
	Missing(String),
	/// A table row or the font could not be read.
	Malformed(String),
}

impl std::fmt::Display for PgfError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			PgfError::Io(error) => write!(f, "{error}"),
			PgfError::Zip(error) => write!(f, "{error}"),
			PgfError::Missing(name) => write!(f, "{name} is not in the archive"),
			PgfError::Malformed(text) => write!(f, "{text}"),
		}
	}
}

impl std::error::Error for PgfError {}

impl From<io::Error> for PgfError {
	fn from(error: io::Error) -> Self {
		PgfError::Io(error)
	}
}

impl From<zip::result::ZipError> for PgfError {
	fn from(error: zip::result::ZipError) -> Self {
		PgfError::Zip(error)
	}
}

/// One registered font: its file, its encoding table, and the Unicode block its script's segments are drawn from.
pub struct FontBundle {
	pub name: String,
	pub version: String,
	/// The script name, as `names::get_script` returns it.
	pub script: String,
	block: (char, char),
	hb_script: Script,
	font: Font,
	units_per_em: u16,
	/// The `hmtx` advance of each glyph id, in font units.
	advances: Vec<u16>,
	encoding: HashMap<GlyphKey, u32>,
}

/// The fonts registered from `pgf-encoding.zip`.
#[derive(Default)]
pub struct FontRegistry {
	bundles: Vec<FontBundle>,
	/// Glyphs encoded as `!` because the table held no key within the deltas.
	pub missing_glyphs: AtomicU64,
}

/// The Unicode block of a script's segments, Java's `\p{In<script>}`, and the script's HarfBuzz tag.
fn script_block(script: &str) -> Option<((char, char), Script)> {
	match script {
		"Devanagari" => Some((('\u{0900}', '\u{097F}'), Script::DEVANAGARI)),
		_ => None,
	}
}

/// The archive's top-level folder: the first directory entry whose only slash is its last character.
fn top_level_folder(archive: &mut zip::ZipArchive<File>) -> Option<String> {
	(0..archive.len()).find_map(|index| {
		let entry = archive.by_index(index).ok()?;
		let name = entry.name().ok()?;
		(entry.is_dir() && name.find('/') == Some(name.len() - 1)).then(|| name[..name.len() - 1].to_owned())
	})
}

fn read_entry(archive: &mut zip::ZipArchive<File>, name: &str) -> Result<Vec<u8>, PgfError> {
	let mut entry = archive.by_name(name).map_err(|_| PgfError::Missing(name.to_owned()))?;
	let mut bytes = Vec::new();
	entry.read_to_end(&mut bytes)?;
	Ok(bytes)
}

/// Parses an encoding table: a header row, then `index,x_offset,y_offset,x_advance,y_advance,codepoint` rows. A later
/// row with the same key replaces an earlier one, as Java's `HashMap.put` does.
fn parse_encoding(text: &str) -> Result<HashMap<GlyphKey, u32>, PgfError> {
	let mut encoding = HashMap::new();
	for line in text.lines().skip(1) {
		let parts: Vec<&str> = line.split(',').collect();
		let field = |index: usize| -> Result<i64, PgfError> {
			parts
				.get(index)
				.and_then(|part| part.trim().parse::<i64>().ok())
				.ok_or_else(|| PgfError::Malformed(format!("encoding row {line:?}")))
		};
		let key = (
			field(0)? as u32,
			field(1)? as i32,
			field(2)? as i32,
			field(3)? as i32,
			field(4)? as i32,
		);
		encoding.insert(key, field(5)? as u32);
	}
	Ok(encoding)
}

/// Reads `unitsPerEm` from `head` and every glyph's advance from `hmtx`.
fn read_metrics(font: &[u8]) -> Result<(u16, Vec<u16>), PgfError> {
	let malformed = || PgfError::Malformed("the font's head, hhea, maxp or hmtx table".into());
	let u16_at = |at: usize| -> Result<u16, PgfError> {
		font.get(at..at + 2)
			.map(|bytes| u16::from_be_bytes([bytes[0], bytes[1]]))
			.ok_or_else(malformed)
	};
	let u32_at = |at: usize| -> Result<u32, PgfError> {
		font.get(at..at + 4)
			.map(|bytes| u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
			.ok_or_else(malformed)
	};
	let table = |tag: &[u8; 4]| -> Result<usize, PgfError> {
		let count = usize::from(u16_at(4)?);
		(0..count)
			.find(|index| font.get(12 + 16 * index..16 + 16 * index) == Some(tag.as_slice()))
			.map(|index| u32_at(12 + 16 * index + 8).map(|offset| offset as usize))
			.ok_or_else(malformed)?
	};
	let units_per_em = u16_at(table(b"head")? + 18)?;
	let long_metrics = usize::from(u16_at(table(b"hhea")? + 34)?);
	let glyphs = usize::from(u16_at(table(b"maxp")? + 4)?);
	let hmtx = table(b"hmtx")?;
	if long_metrics == 0 || units_per_em == 0 {
		return Err(malformed());
	}
	let advances = (0..glyphs)
		.map(|glyph| u16_at(hmtx + 4 * glyph.min(long_metrics - 1)))
		.collect::<Result<Vec<_>, _>>()?;
	Ok((units_per_em, advances))
}

impl FontRegistry {
	/// Registers `fonts`, given as (name, version, script), from a `pgf-encoding.zip`, as the fork's
	/// `FontRegistry.loadFontBundle` does for each.
	pub fn from_zip(path: &Path, fonts: &[(&str, &str, &str)]) -> Result<Self, PgfError> {
		let mut archive = zip::ZipArchive::new(File::open(path)?)?;
		let top = top_level_folder(&mut archive).ok_or_else(|| PgfError::Missing("a top-level folder".into()))?;
		let mut registry = FontRegistry::default();
		for &(name, version, script) in fonts {
			let (block, hb_script) = script_block(script)
				.ok_or_else(|| PgfError::Malformed(format!("no Unicode block is known for the script {script}")))?;
			let font = read_entry(&mut archive, &format!("{top}/fonts/{name}.ttf"))?;
			let table = read_entry(&mut archive, &format!("{top}/encoding/{name}-v{version}.csv"))?;
			let encoding = parse_encoding(
				std::str::from_utf8(&table)
					.map_err(|error| PgfError::Malformed(format!("{name} encoding: {error}")))?,
			)?;
			let (units_per_em, advances) = read_metrics(&font)?;
			let font = Font::new(font, 0).ok_or_else(|| PgfError::Malformed(format!("{name}.ttf is not a font")))?;
			registry.bundles.retain(|bundle| bundle.script != script);
			registry.bundles.push(FontBundle {
				name: name.to_owned(),
				version: version.to_owned(),
				script: script.to_owned(),
				block,
				hb_script,
				font,
				units_per_em,
				advances,
				encoding,
			});
		}
		Ok(registry)
	}

	pub fn bundles(&self) -> &[FontBundle] {
		&self.bundles
	}

	/// Returns whether a font is registered for `script`.
	pub fn has_script(&self, script: &str) -> bool {
		self.bundles.iter().any(|bundle| bundle.script == script)
	}

	/// The fork's `TextEngine.encodeRegisteredScripts`: each segment in a registered script encoded with its font,
	/// and every other segment unchanged.
	pub fn encode_registered_scripts(&self, text: &str) -> String {
		let blocks: Vec<(char, char)> = self.bundles.iter().map(|bundle| bundle.block).collect();
		let mut out = String::new();
		for segment in segment(text, &blocks) {
			let script = get_script(&segment);
			match self.bundles.iter().find(|bundle| bundle.script == script) {
				Some(bundle) => out.push_str(&self.encode(bundle, &segment)),
				None => out.push_str(&segment),
			}
		}
		out
	}

	/// The fork's `TextEngine.encode`: one PUA codepoint per shaped glyph.
	fn encode(&self, bundle: &FontBundle, text: &str) -> String {
		let mut out = String::new();
		for glyph in java_glyph_keys(bundle, text) {
			let codepoint = codepoint_from_glyph(&bundle.encoding, glyph).unwrap_or_else(|| {
				self.missing_glyphs.fetch_add(1, Ordering::Relaxed);
				MISSING_GLYPH
			});
			out.push(char::from_u32(codepoint).unwrap_or('!'));
		}
		out
	}
}

/// The fork's `TextEngine.segment`: maximal runs of characters inside and outside the registered scripts' `blocks`,
/// or the whole text when no block is registered.
fn segment(text: &str, blocks: &[(char, char)]) -> Vec<String> {
	if text.is_empty() {
		return Vec::new();
	}
	if blocks.is_empty() {
		return vec![text.to_owned()];
	}
	let mut segments: Vec<String> = Vec::new();
	let mut inside: Option<bool> = None;
	for c in text.chars() {
		let here = blocks.iter().any(|&(first, last)| (first..=last).contains(&c));
		match segments.last_mut() {
			Some(last) if inside == Some(here) => last.push(c),
			_ => {
				segments.push(c.to_string());
				inside = Some(here);
			}
		}
	}
	segments
}

/// The first table entry among the deltas around `key`, as the fork's `codepointFromGlyph` searches.
fn codepoint_from_glyph(encoding: &HashMap<GlyphKey, u32>, key: GlyphKey) -> Option<u32> {
	let (index, x_offset, y_offset, x_advance, y_advance) = key;
	DELTAS.iter().find_map(|&(delta_offset, delta_advance)| {
		encoding
			.get(&(
				index,
				x_offset + delta_offset,
				y_offset,
				x_advance + delta_advance,
				y_advance,
			))
			.copied()
	})
}

/// FreeType's linear advance at one pixel per em, in 16.16 fixed point: `FT_MulDiv(advance, x_scale, 64)` with
/// `x_scale = FT_DivFix(64, units_per_em)`, both rounding half away from zero.
fn linear_advance(advance: u16, units_per_em: u16) -> i64 {
	let upem = i64::from(units_per_em);
	let x_scale = (64 * 65_536 + upem / 2) / upem;
	(i64::from(advance) * x_scale + 32) / 64
}

/// Java's `(int) Math.floor(1000.0 * value / 64.0)`.
fn to_key_units(value: f64) -> i32 {
	(1000.0 * value / 64.0).floor() as i32
}

/// HarfBuzz's scale for the JDK's 1-point font: one point in 16.16 fixed point.
const JDK_SCALE: i32 = 65_536;

/// The JDK's advance callback: FreeType's linear advance in 16.16, in place of the scaled `hmtx` advance.
struct LinearAdvances<'a>(&'a FontBundle);

impl FontFuncs for LinearAdvances<'_> {
	fn glyph_h_advance(&self, _font: &ShaperFont, glyph: GlyphId) -> i32 {
		self.0.linear_advance(glyph.to_u32()) as i32
	}
}

impl FontBundle {
	fn linear_advance(&self, glyph: u32) -> i64 {
		let design = self.advances.get(glyph as usize).copied().unwrap_or(0);
		linear_advance(design, self.units_per_em)
	}

	/// Shapes `text` as the JDK's `SunLayoutEngine.shape` does for a Devanagari run of a 1-point font: left to right,
	/// with no language, monotone character clusters, and kerning and standard ligatures off. Returns each glyph's id,
	/// x offset and x advance in 16.16.
	fn shape(&self, text: &str) -> Vec<(u32, i32, i32)> {
		let funcs = LinearAdvances(self);
		let font = ShaperFont::new(&self.font)
			.with_scale(JDK_SCALE)
			.with_font_funcs(Some(&funcs));
		let mut buffer = Buffer::new();
		buffer.push_str(text);
		buffer.set_direction(Direction::LeftToRight);
		buffer.set_script(Some(self.hb_script));
		buffer.set_cluster_level(ClusterLevel::MonotoneCharacters);
		let features = [
			Feature::new(Tag::new(b"kern"), 0, ..),
			Feature::new(Tag::new(b"liga"), 0, ..),
		];
		if harfrust::shape(&font, &mut buffer, ShapeOptions::new().features(&features)).is_err() {
			return Vec::new();
		}
		buffer
			.glyph_infos()
			.iter()
			.zip(buffer.glyph_positions())
			.map(|(info, position)| (info.glyph_id, position.x_offset, position.x_advance))
			.collect()
	}
}

/// The table key Java computes for each glyph of `text`.
///
/// The JDK stores each glyph's position as a float sum of the shaped advances plus the glyph's offset, and
/// `GlyphMetrics` gives the FreeType metric advance. `TextEngine.encode` takes the key offset as the position less the
/// float sum of the metric advances before it.
fn java_glyph_keys(bundle: &FontBundle, text: &str) -> Vec<GlyphKey> {
	let scale = 1.0f32 / 65_536.0;
	let mut x = 0.0f32;
	let mut sum_advances = 0.0f32;
	let mut keys = Vec::new();
	for (glyph, x_offset, x_advance) in bundle.shape(text) {
		let advance = bundle.linear_advance(glyph) as f32 / 65_536.0;
		let position = x + x_offset as f32 * scale;
		let offset = f64::from(position) - f64::from(sum_advances);
		keys.push((glyph, to_key_units(offset), 0, to_key_units(f64::from(advance)), 0));
		x += x_advance as f32 * scale;
		sum_advances = (f64::from(sum_advances) + f64::from(advance)) as f32;
	}
	keys
}

#[cfg(test)]
mod tests {
	use super::*;

	/// The cases of the fork's `TextEngineTest.testSegment`.
	#[test]
	fn text_splits_into_runs_inside_and_outside_the_registered_blocks() {
		let devanagari = [('\u{0900}', '\u{097F}')];
		assert_eq!(segment("काठमाडौँ 123", &devanagari), vec!["काठमाडौँ", " 123"]);
		assert_eq!(segment("काठमाडौँ काठमाडौँ", &devanagari), vec!["काठमाडौँ", " ", "काठमाडौँ"]);
		assert_eq!(
			segment("काठमाडौँ తెలుగు Hello! काठमाडौँ", &devanagari),
			vec!["काठमाडौँ", " తెలుగు Hello! ", "काठमाडौँ"]
		);
		assert_eq!(segment("తెలుగు Hello!", &devanagari), vec!["తెలుగు Hello!"]);
		assert_eq!(segment("काठमाडौँ", &[]), vec!["काठमाडौँ"]);
		assert!(segment("", &devanagari).is_empty());
	}

	#[test]
	fn the_linear_advance_is_freetypes_at_one_pixel_per_em() {
		// 259 font units of a 1000-unit em: x_scale 4194, so 259 * 4194 / 64 = 16972.6, rounded to 16973.
		assert_eq!(linear_advance(259, 1000), 16_973);
		assert_eq!(linear_advance(0, 1000), 0);
	}

	#[test]
	fn the_delta_search_takes_the_first_entry_in_javas_order() {
		let mut encoding = HashMap::new();
		encoding.insert((66, 0, 0, 4, 0), 63_743);
		encoding.insert((66, -1, 0, 4, 0), 63_000);
		assert_eq!(codepoint_from_glyph(&encoding, (66, 0, 0, 4, 0)), Some(63_743));
		assert_eq!(codepoint_from_glyph(&encoding, (66, 1, 0, 4, 0)), Some(63_743));
		assert_eq!(codepoint_from_glyph(&encoding, (66, 0, 0, 9, 0)), None);
	}

	#[test]
	fn a_later_table_row_replaces_an_earlier_one() {
		let encoding =
			parse_encoding("index,x_offset,y_offset,x_advance,y_advance,codepoint\n66,0,0,4,0,1\n66,0,0,4,0,2\n")
				.unwrap();
		assert_eq!(encoding[&(66, 0, 0, 4, 0)], 2);
	}
}
