// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The emit step: the rows one sampled row becomes.
//!
//! Two policies apply between the sampler and the consumer, augmentation (with a per-source opt-out) and affix
//! relabeling, in that order, because the relabel must see the label-inheriting directional expansions the
//! augmentation produces (#511). Every consumer that emits rows, the training stream and the audits, calls this one
//! function, so the two policies cannot diverge between them (#2243).

use crate::augment::postcode_move::PostcodeLayouts;
use crate::augment::{augment_row, PostcodeMoveOutcomes};
use crate::config::AugmentProbabilities;
use crate::error::Result;
use crate::pyrandom::PyRandom;
use crate::relabel::{relabel_row, AffixRelabelLexicon};
use crate::row::Row;
use std::sync::Arc;

/// Sources the postcode move skips, because their producers already write the postcode on a side their layout does
/// not use: G-NAF's postcode-before-street rows, the Czech postcode-first preposition recipe under its current and
/// retired spellings, the KR `postcode_first` register, and GeoNames postal's `postcode locality` rows.
pub fn postcode_move_excluded(source: &str) -> bool {
	matches!(source, "gnaf" | "geonames-postal" | "juso-kr" | "localdata-kr")
		|| ["rendered", "synth"].iter().any(|prefix| {
			["", "-v20", "-v21"]
				.iter()
				.any(|suffix| source == format!("{prefix}-cz-pcfirst-preposition{suffix}"))
		})
}

/// Everything that decides what one sampled row becomes.
pub struct EmitPolicy {
	pub augment: AugmentProbabilities,
	/// Sources that bypass augmentation entirely. The relabel still applies to them.
	pub excluded_sources: Vec<String>,
	pub relabel: Option<Arc<AffixRelabelLexicon>>,
	pub layouts: Option<Arc<PostcodeLayouts>>,
	/// Each postcode-move draw counted as moved or under its skip reason.
	pub postcode_move_outcomes: PostcodeMoveOutcomes,
}

impl EmitPolicy {
	pub fn augments_source(&self, source: &str) -> bool {
		self.augment.any() && !self.excluded_sources.iter().any(|s| s == source)
	}

	/// The rows `row` becomes, ending at the first error.
	pub fn emit(&mut self, row: Row, rng: &mut PyRandom) -> Vec<Result<Row>> {
		if self.augments_source(&row.source) {
			let move_prob = if postcode_move_excluded(&row.source) {
				0.0
			} else {
				self.augment.postcode_move
			};
			let mut out = augment_row(
				&row,
				rng,
				&self.augment,
				move_prob,
				self.layouts.as_deref(),
				&mut self.postcode_move_outcomes,
			);
			if let Some(lexicon) = &self.relabel {
				for item in &mut out {
					if let Ok(augmented) = item {
						if let Err(e) = relabel_row(augmented, lexicon) {
							*item = Err(e);
						}
					}
				}
				if let Some(at) = out.iter().position(Result::is_err) {
					out.truncate(at + 1);
				}
			}
			out
		} else if let Some(lexicon) = &self.relabel {
			let mut row = row;
			match relabel_row(&mut row, lexicon) {
				Ok(_) => vec![Ok(row)],
				Err(e) => vec![Err(e)],
			}
		} else {
			vec![Ok(row)]
		}
	}
}
