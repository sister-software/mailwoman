// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Turn a reps-per-row target into a source weight once the corpus's row counts are known.
//!
//! The mixture allocates draws by weight normalized across sources, and row count never enters, so a source's
//! per-row exposure is `(weight / total_weight) × total_samples / rows`. `source_reps` lets a config state the
//! exposure. With `W` the sum of the positive fixed weights, `S` the run's samples and `D = Σ reps_i × rows_i` over
//! the targeted sources, those sources take `D / S` of the draws, so `total_weight = W / (1 − D / S)` and
//! `weight_i = reps_i × rows_i × total_weight / S`. Their draws come out of the fixed sources' share, `D` must stay
//! below `S`, and at least one source needs a fixed weight to scale against.
//!
//! `S` counts emitted rows, and the emit step's augmented copies make a source emit `f_i` rows per draw relative to
//! the run's mean, so a target is read as `reps_i / f_i` draws per row in both formulas. `f_i` comes from the config's
//! `source_emit_factors`, which the epoch-mixture audit measures, and reads 1 for a source the config gives none.

use crate::config::{RunLength, SamplerConfig, Weights};
use crate::corpus_files::source_row_counts;
use crate::error::{Error, Result};

/// One reps-targeted source's derivation, for the launch log.
#[derive(Debug, Clone, PartialEq)]
pub struct DerivedReps {
	pub source: String,
	/// The configured target: emitted rows per train row over the run.
	pub target_reps_per_row: f64,
	/// The source's emitted rows per draw relative to the run's mean, 1 when the config states none.
	pub emit_factor: f64,
	pub rows: u64,
	pub weight: f64,
}

/// Rows the trainer consumes over the run: every optimizer step reads `batch_size × grad_accum_steps`.
pub fn total_samples(run: &RunLength) -> u64 {
	run.max_steps * run.batch_size * run.grad_accum_steps
}

/// `fixed` with each `source_reps` target merged in as a derived weight, and the derivation per source.
///
/// Refuses a source that carries both a weight and a target, a target with no readable train rows, targets that
/// together demand the run's samples or more, a factor that is not positive, and a factor for a source with no target.
pub fn derive_source_weights(
	fixed: Option<&Weights>,
	source_reps: &Weights,
	emit_factors: Option<&Weights>,
	rows_by_source: &[(String, u64)],
	samples: u64,
) -> Result<(Weights, Vec<DerivedReps>)> {
	let fixed = fixed.cloned().unwrap_or_default();
	let factor_of = factor_reader(source_reps, emit_factors)?;
	if source_reps.is_empty() {
		return Ok((fixed, Vec::new()));
	}
	if samples == 0 {
		return Err(Error::Input(
			"total samples must be positive to derive a weight from reps per row, got 0".into(),
		));
	}
	let mut both: Vec<&str> = source_reps.keys().filter(|s| fixed.contains(s)).collect();
	both.sort_unstable();
	if !both.is_empty() {
		return Err(Error::Input(format!(
			"sources carry both a weight and a reps target: {both:?}; a source takes one or the other"
		)));
	}
	let positive_fixed: f64 = fixed
		.0
		.iter()
		.filter(|(_, w)| *w > 0.0)
		.fold(0.0, |sum, (_, w)| sum + w);
	if positive_fixed <= 0.0 {
		return Err(Error::Input(
			"source_reps need at least one positively weighted source in source_weights to derive against".into(),
		));
	}
	let rows_of = |source: &str| rows_by_source.iter().find(|(s, _)| s == source).map(|&(_, n)| n);
	let mut missing: Vec<&str> = source_reps.keys().filter(|s| rows_of(s).unwrap_or(0) == 0).collect();
	missing.sort_unstable();
	if !missing.is_empty() {
		return Err(Error::Input(format!(
			"reps-targeted sources have no readable train rows in the corpus: {missing:?}"
		)));
	}
	let demanded = source_reps.0.iter().fold(0.0f64, |sum, (s, reps)| {
		sum + reps / factor_of(s) * rows_of(s).expect("checked") as f64
	});
	if demanded >= samples as f64 {
		return Err(Error::Input(format!(
			"source_reps demand {demanded:.0} draws, at or over the run's {samples} samples; lower a reps target or \
			 lengthen the run"
		)));
	}
	let scale = positive_fixed / (1.0 - demanded / samples as f64);
	let mut merged = fixed;
	let mut derived = Vec::new();
	let mut targets: Vec<&(String, f64)> = source_reps.0.iter().collect();
	targets.sort_by(|a, b| a.0.cmp(&b.0));
	for (source, reps) in targets {
		if *reps <= 0.0 {
			return Err(Error::Input(format!(
				"source_reps[{source:?}] must be positive, got {reps}"
			)));
		}
		let rows = rows_of(source).expect("checked");
		let emit_factor = factor_of(source);
		let weight = reps / emit_factor * rows as f64 * scale / samples as f64;
		merged.0.push((source.clone(), weight));
		derived.push(DerivedReps {
			source: source.clone(),
			target_reps_per_row: *reps,
			emit_factor,
			rows,
			weight,
		});
	}
	Ok((merged, derived))
}

/// Each `source_reps` source's emit factor, 1 for a source without one.
///
/// Refuses a factor that is not positive, and a factor for a source with no target.
fn factor_reader<'a>(source_reps: &Weights, emit_factors: Option<&'a Weights>) -> Result<impl Fn(&str) -> f64 + 'a> {
	if let Some(factors) = emit_factors {
		let mut stray: Vec<&str> = factors
			.0
			.iter()
			.map(|(s, _)| s.as_str())
			.filter(|s| !source_reps.contains(s))
			.collect();
		stray.sort_unstable();
		if !stray.is_empty() {
			return Err(Error::Input(format!(
				"source_emit_factors names sources with no source_reps target: {stray:?}"
			)));
		}
		if let Some((source, factor)) = factors.0.iter().find(|(_, f)| *f <= 0.0) {
			return Err(Error::Input(format!(
				"source_emit_factors[{source:?}] must be positive, got {factor}"
			)));
		}
	}
	Ok(move |source: &str| emit_factors.and_then(|f| f.get(source)).unwrap_or(1.0))
}

/// The train mixture's weights: the configured weights with any `source_reps` targets derived from the corpus.
pub fn resolved_source_weights(config: &SamplerConfig) -> Result<Option<Weights>> {
	match &config.source_reps {
		Some(reps) if !reps.is_empty() => {
			let run = config
				.run_length
				.as_ref()
				.ok_or_else(|| Error::Input("source_reps needs run_length to know the run's samples".into()))?;
			let rows = source_row_counts(config, "train")?;
			let (merged, _) = derive_source_weights(
				config.source_weights.as_ref(),
				reps,
				config.source_emit_factors.as_ref(),
				&rows,
				total_samples(run),
			)?;
			Ok(Some(merged))
		}
		_ => Ok(config.source_weights.clone()),
	}
}
