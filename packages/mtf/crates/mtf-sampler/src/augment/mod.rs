// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Training-time augmentation: copies of a row with a field written another way.
//!
//! Nine augmentations fire independently, each with its configured probability: directional expansion, the
//! ordinal-street swap, region-postcode glue, region-abbreviation expansion, lowercase, punctuation drop, all-caps,
//! the postcode move and grouping characters. The original row is always emitted first, so every probability is an
//! additive copy rate.
//!
//! The order of the draws is an interface. The directional and region draws are always made; every other
//! augmentation draws only when its probability is positive, so a configuration that leaves a knob at 0 consumes no
//! randomness for it and its stream stays identical to the configurations written before the knob existed.

pub mod grouping;
pub mod postcode_move;
pub mod splice;
pub mod tables;

use crate::config::AugmentProbabilities;
use crate::error::{Error, Result};
use crate::pyrandom::PyRandom;
use crate::row::Row;
use mtf_channels::python_text::{is_alpha, is_digit};
use postcode_move::{move_postcode, PostcodeLayouts, SkipReason};
use std::collections::HashMap;
use tables::{lookup, DIRECTIONALS, ORDINAL_STREETS, STREET_FAMILY_LABELS, US_STATES};

/// What happened to each postcode-move draw: moved, or the reason it was skipped.
#[derive(Debug, Clone, Default)]
pub struct PostcodeMoveOutcomes(pub HashMap<&'static str, u64>);

impl PostcodeMoveOutcomes {
	fn count(&mut self, outcome: &'static str) {
		*self.0.entry(outcome).or_default() += 1;
	}
}

fn require_parallel(row: &Row) -> Result<()> {
	if row.tokens.len() != row.labels.len() {
		return Err(Error::Row(format!(
			"tokens/labels length mismatch: {} vs {} in {:?}",
			row.tokens.len(),
			row.labels.len(),
			row.raw
		)));
	}
	Ok(())
}

/// The rows one sampled row becomes: the row itself, then each augmented copy that fires, in draw order.
///
/// The list stops at the first error, which the stream raises when it reaches it, so a row the consumer never asks
/// for cannot fail the stream.
pub fn augment_row(
	row: &Row,
	rng: &mut PyRandom,
	p: &AugmentProbabilities,
	postcode_move_prob: f64,
	layouts: Option<&PostcodeLayouts>,
	outcomes: &mut PostcodeMoveOutcomes,
) -> Vec<Result<Row>> {
	let mut out = vec![Ok(row.clone())];
	if let Err(e) = augment_copies(row, rng, p, postcode_move_prob, layouts, outcomes, &mut out) {
		out.push(Err(e));
	}
	out
}

fn augment_copies(
	row: &Row,
	rng: &mut PyRandom,
	p: &AugmentProbabilities,
	postcode_move_prob: f64,
	layouts: Option<&PostcodeLayouts>,
	outcomes: &mut PostcodeMoveOutcomes,
	out: &mut Vec<Result<Row>>,
) -> Result<()> {
	let tokens = &row.tokens;
	let labels = &row.labels;

	if rng.random() < p.directional {
		let indices: Vec<usize> = (0..tokens.len())
			.filter(|&i| lookup(&DIRECTIONALS, &tokens[i]).is_some())
			.collect();
		if !indices.is_empty() {
			let idx = indices[rng.choice_index(indices.len())?];
			let expansion = lookup(&DIRECTIONALS, &tokens[idx]).expect("filtered above");
			out.push(Ok(splice::splice_expansion(row, idx, expansion)?));
		}
	}

	if p.ordinal > 0.0 && rng.random() < p.ordinal {
		require_parallel(row)?;
		let indices: Vec<usize> = (0..tokens.len())
			.filter(|&i| {
				lookup(&ORDINAL_STREETS, &tokens[i]).is_some() && STREET_FAMILY_LABELS.contains(&labels[i].as_str())
			})
			.collect();
		if !indices.is_empty() {
			let idx = indices[rng.choice_index(indices.len())?];
			let expansion = lookup(&ORDINAL_STREETS, &tokens[idx]).expect("filtered above");
			out.push(Ok(splice::splice_expansion(row, idx, expansion)?));
		}
	}

	if p.glue > 0.0 && rng.random() < p.glue {
		let label = |i: usize| -> Result<&str> {
			labels
				.get(i)
				.map(String::as_str)
				.ok_or_else(|| Error::Row(format!("label index {i} out of range for {:?}", row.raw)))
		};
		let mut indices = Vec::new();
		for i in 0..tokens.len().saturating_sub(1) {
			let region = matches!(label(i)?, "B-region" | "I-region");
			if region
				&& label(i + 1)? == "B-postcode"
				&& tokens[i].chars().last().is_some_and(is_alpha)
				&& tokens[i + 1].chars().next().is_some_and(is_digit)
			{
				indices.push(i);
			}
		}
		if !indices.is_empty() {
			let idx = indices[rng.choice_index(indices.len())?];
			out.push(Ok(splice::glue_region_postcode(row, idx)?));
		}
	}

	if rng.random() < p.region {
		require_parallel(row)?;
		let indices: Vec<usize> = (0..tokens.len())
			.filter(|&i| {
				lookup(&US_STATES, &tokens[i]).is_some() && matches!(labels[i].as_str(), "B-region" | "I-region")
			})
			.collect();
		if !indices.is_empty() {
			let idx = indices[rng.choice_index(indices.len())?];
			let expansion = lookup(&US_STATES, &tokens[idx]).expect("filtered above");
			out.push(Ok(splice::splice_expansion(row, idx, expansion)?));
		}
	}

	if p.case > 0.0 && rng.random() < p.case {
		if let Some(lowered) = splice::lowercase_row(row)? {
			out.push(Ok(lowered));
		}
	}

	if p.punct_drop > 0.0 && rng.random() < p.punct_drop {
		if let Some(dropped) = splice::drop_separator_punct(row)? {
			out.push(Ok(dropped));
		}
	}

	if p.upper_case > 0.0 && rng.random() < p.upper_case {
		if let Some(uppered) = splice::upper_case_row(row)? {
			out.push(Ok(uppered));
		}
	}

	if postcode_move_prob > 0.0 && rng.random() < postcode_move_prob {
		let layouts = layouts.ok_or_else(|| {
			Error::Input("augment.postcode_move is positive and no postcode_layouts_path is configured".into())
		})?;
		match move_postcode(row, layouts)? {
			Ok(moved) => {
				outcomes.count("moved");
				out.push(Ok(moved));
			}
			Err(reason) => outcomes.count(SkipReason::as_str(reason)),
		}
	}

	if p.grouping > 0.0 && rng.random() < p.grouping {
		if let Some(grouped) = grouping::group_row(row, rng)? {
			out.push(Ok(grouped));
		}
	}
	Ok(())
}
