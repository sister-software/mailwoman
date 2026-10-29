// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! A reps-per-row target derives the source weight that produces that exposure, leaves the fixed weights alone, and
//! is refused with a reason when it cannot be met.
use mtf_sampler::source_reps::{derive_source_weights, total_samples};
use mtf_sampler::{RunLength, Weights};

fn weights(pairs: &[(&str, f64)]) -> Weights {
	Weights(pairs.iter().map(|&(k, w)| (k.to_owned(), w)).collect())
}

fn run(max_steps: u64, batch_size: u64) -> u64 {
	total_samples(&RunLength {
		max_steps,
		batch_size,
		grad_accum_steps: 1,
	})
}

/// A 60,000-step run at batch size 128.
fn samples() -> u64 {
	run(60_000, 128)
}

/// Fixed weights that sum to 168.
fn fixed() -> Weights {
	weights(&[
		("ban", 100.0),
		("tiger", 56.0),
		("synth-trailing-region-es-v23", 6.0),
		("synth-trailing-region-gb-v23", 6.0),
	])
}

fn rows() -> Vec<(String, u64)> {
	[
		("synth-bare-country-v23", 277),
		("synth-trailing-region-es-v23", 53_078),
		("ban", 2_000_000),
		("tiger", 1_000_000),
	]
	.iter()
	.map(|&(s, n)| (s.to_owned(), n))
	.collect()
}

/// The reps per row `weights` give `source` over the fixture run.
fn reps(weights: &Weights, source: &str) -> f64 {
	let total: f64 = weights.0.iter().filter(|(_, w)| *w > 0.0).map(|(_, w)| w).sum();
	let rows = rows().into_iter().find(|(s, _)| s == source).unwrap().1;
	weights.get(source).unwrap() / total * samples() as f64 / rows as f64
}

fn assert_close(actual: f64, expected: f64, tolerance: f64) {
	assert!(
		(actual - expected).abs() <= tolerance,
		"{actual} is not within {tolerance} of {expected}"
	);
}

#[test]
fn a_target_of_five_lands_at_five_reps_per_row() {
	let (merged, derived) = derive_source_weights(
		Some(&fixed()),
		&weights(&[("synth-bare-country-v23", 5.0)]),
		&rows(),
		samples(),
	)
	.unwrap();
	assert_close(reps(&merged, "synth-bare-country-v23"), 5.0, 5.0e-6);
	assert_close(derived[0].weight, 0.0302, 0.0005);
	// The fixed weights stay unchanged. The targeted source's draws come out of their share.
	for (source, weight) in fixed().0 {
		assert_eq!(merged.get(&source), Some(weight), "{source}");
	}
}

#[test]
fn a_source_with_a_weight_cannot_take_a_target_and_two_targets_hold_together() {
	let error =
		derive_source_weights(Some(&fixed()), &weights(&[("tiger", 3.0)]), &rows(), samples()).expect_err("an error");
	assert!(error.to_string().contains("both a weight and a reps target"), "{error}");

	let (merged, derived) = derive_source_weights(
		Some(&weights(&[("ban", 100.0)])),
		&weights(&[("synth-bare-country-v23", 40.0), ("synth-trailing-region-es-v23", 8.0)]),
		&rows(),
		samples(),
	)
	.unwrap();
	assert_close(reps(&merged, "synth-bare-country-v23"), 40.0, 40.0e-6);
	assert_close(reps(&merged, "synth-trailing-region-es-v23"), 8.0, 8.0e-6);
	assert_eq!(derived.len(), 2);
}

#[test]
fn no_targets_leave_the_weights_as_they_were() {
	let (merged, derived) = derive_source_weights(Some(&fixed()), &Weights::default(), &rows(), samples()).unwrap();
	assert_eq!((merged, derived.len()), (fixed(), 0));
	let (merged, derived) = derive_source_weights(None, &Weights::default(), &rows(), samples()).unwrap();
	assert_eq!((merged, derived.len()), (Weights::default(), 0));
}

#[test]
fn each_refusal_names_its_reason() {
	let refusal = |fixed: &Weights, targets: &[(&str, f64)], samples: u64| {
		derive_source_weights(Some(fixed), &weights(targets), &rows(), samples)
			.expect_err("an error")
			.to_string()
	};
	let message = refusal(&fixed(), &[("synth-missing", 5.0)], samples());
	assert!(message.contains("no readable train rows"), "{message}");
	let message = refusal(&Weights::default(), &[("synth-bare-country-v23", 5.0)], samples());
	assert!(message.contains("at least one positively weighted source"), "{message}");
	let message = refusal(&weights(&[("tiger", 1.0)]), &[("ban", 5.0)], run(10, 128));
	assert!(message.contains("at or over the run's"), "{message}");
	let message = refusal(&fixed(), &[("synth-bare-country-v23", 0.0)], samples());
	assert!(message.contains("must be positive"), "{message}");
}
