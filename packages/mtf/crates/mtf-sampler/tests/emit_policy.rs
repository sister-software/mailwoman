// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The emit step excludes a source from augmentation by its name, whatever the probabilities, and passes every row
//! through when no probability is live.
use mtf_sampler::emit::EmitPolicy;
use mtf_sampler::pyrandom::{PyRandom, Seed};
use mtf_sampler::{AugmentProbabilities, Row};

const EXCLUDED: &str = "synth-bare-postcode";
const AUGMENTED: &str = "tiger";

fn quiet_lane(source: &str) -> Row {
	Row {
		raw: format!("0 quiet lane {source}"),
		tokens: vec!["0".into(), "quiet".into(), "lane".into(), source.into()],
		labels: vec!["O".into(); 4],
		country: Some("US".into()),
		source: source.into(),
		spans: None,
	}
}

fn policy(augment: AugmentProbabilities) -> EmitPolicy {
	EmitPolicy {
		augment,
		excluded_sources: vec![EXCLUDED.to_owned()],
		relabel: None,
		layouts: None,
		postcode_move_outcomes: Default::default(),
	}
}

#[test]
fn an_excluded_source_passes_through_with_every_probability_live() {
	let mut policy = policy(AugmentProbabilities {
		upper_case: 1.0,
		..Default::default()
	});
	assert!(policy.augment.any(), "the policy augments");
	assert!(!policy.augments_source(EXCLUDED));
	assert!(policy.augments_source(AUGMENTED));
	assert_eq!(
		policy
			.emit(quiet_lane(EXCLUDED), &mut PyRandom::new(Seed::Int(0)))
			.len(),
		1
	);
	assert_eq!(
		policy
			.emit(quiet_lane(AUGMENTED), &mut PyRandom::new(Seed::Int(0)))
			.len(),
		2
	);
}

#[test]
fn all_zero_probabilities_pass_every_row_through() {
	let mut policy = policy(AugmentProbabilities::default());
	assert!(!policy.augment.any());
	for source in [EXCLUDED, AUGMENTED] {
		assert_eq!(
			policy.emit(quiet_lane(source), &mut PyRandom::new(Seed::Int(0))).len(),
			1,
			"{source}"
		);
	}
}
