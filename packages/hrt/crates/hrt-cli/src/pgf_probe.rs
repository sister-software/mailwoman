// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! `hrt pgf-probe <pgf-encoding.zip> <names.txt> <out.tsv>` encodes each line of a name list with the fork's
//! registered fonts and writes the name and its encoded codepoints, in the first two columns of the table
//! `packages/hrt/parity/PgfProbe.java` writes, for a line-by-line comparison.

use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::Ordering;

use hrt_profile::pgf::{FontRegistry, FORK_FONTS};

pub fn probe(zip: &Path, names: &Path, out: &Path) -> Result<(usize, u64), Box<dyn std::error::Error>> {
	let registry = FontRegistry::from_zip(zip, &FORK_FONTS)?;
	let text = fs::read_to_string(names)?;
	let mut writer = io::BufWriter::new(fs::File::create(out)?);
	let mut lines = 0;
	for line in text.lines() {
		let encoded: Vec<String> = registry
			.encode_registered_scripts(line)
			.chars()
			.map(|c| u32::from(c).to_string())
			.collect();
		writeln!(writer, "{line}\t{}", encoded.join(" "))?;
		lines += 1;
	}
	writer.flush()?;
	Ok((lines, registry.missing_glyphs.load(Ordering::Relaxed)))
}
