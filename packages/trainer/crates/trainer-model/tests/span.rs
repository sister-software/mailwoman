//! The span scorer's gold segmentation, partition function and gold path score, on small inputs whose answers are
//! enumerated by hand, as the Python trainer's span-scorer test checked its module.

use tch::{Device, Kind, Tensor};
use trainer_export::span::segment_types;
use trainer_model::span::{gold_segments, Segment, SemiMarkovCrf};
use trainer_model::Store;

fn labels() -> Vec<String> {
	let mut out = vec!["O".to_owned()];
	for tag in ["locality", "street", "house_number"] {
		out.push(format!("B-{tag}"));
		out.push(format!("I-{tag}"));
	}
	out
}

#[test]
fn segment_types_put_o_first_and_follow_the_label_order() {
	assert_eq!(
		segment_types(&labels()),
		vec!["O", "locality", "street", "house_number"]
	);
}

#[test]
fn gold_segments_group_a_b_with_its_i_and_stop_at_the_ignore_index() {
	let (labels, types) = (labels(), segment_types(&labels()));
	// B-street I-street O B-house_number, then padding.
	let (segs, ok) = gold_segments(&[3, 4, 0, 5, -100, -100], &labels, &types, -100, 8).unwrap();
	assert!(ok);
	assert_eq!(segs, vec![(0, 2, 2), (2, 1, 0), (3, 1, 3)]);
	// An orphan I- starts a segment.
	let (segs, _) = gold_segments(&[0, 4], &labels, &types, -100, 8).unwrap();
	assert_eq!(segs, vec![(0, 1, 0), (1, 1, 2)]);
	// A span longer than max_span is reported, not truncated.
	let (segs, ok) = gold_segments(&[3, 4, 4, 4], &labels, &types, -100, 3).unwrap();
	assert!(!ok);
	assert_eq!(segs, vec![(0, 4, 2)]);
	assert!(gold_segments(&[99], &labels, &types, -100, 3).is_err());
}

/// Every segmentation of `[0, n)` into spans of at most `max_span`, an `O` span being one unit long.
fn segmentations(n: usize, max_span: usize, types: usize) -> Vec<Vec<Segment>> {
	if n == 0 {
		return vec![Vec::new()];
	}
	let mut out = Vec::new();
	for len in 1..=max_span.min(n) {
		for t in 0..types {
			if t == 0 && len > 1 {
				continue;
			}
			for mut rest in segmentations(n - len, max_span, types) {
				// `rest` covers `[0, n - len)`; this span covers `[n - len, n)`.
				rest.push((n - len, len, t));
				out.push(rest);
			}
		}
	}
	out
}

#[test]
fn the_partition_function_is_the_log_sum_over_every_segmentation() {
	tch::manual_seed(11);
	let (types, max_span, n) = (4i64, 3i64, 5usize);
	let mut store = Store::default();
	let crf = SemiMarkovCrf::new(&mut store, "semi_crf", max_span, types);
	tch::no_grad(|| {
		let _ = crf.transitions.shallow_clone().uniform_(-1.0, 1.0);
		let _ = crf.start_transitions.shallow_clone().uniform_(-1.0, 1.0);
		let _ = crf.end_transitions.shallow_clone().uniform_(-1.0, 1.0);
	});
	let scores = Tensor::randn([1, 6, max_span, types], (Kind::Float, Device::Cpu));
	let lengths = Tensor::from_slice(&[n as i64]);
	let got = crf.log_partition(&scores, &lengths).double_value(&[0]);
	let all = segmentations(n, max_span as usize, types as usize);
	let path_scores: Vec<f64> = all
		.iter()
		.map(|s| {
			crf.score_segmentation(&scores, std::slice::from_ref(s))
				.double_value(&[0])
		})
		.collect();
	let peak = path_scores.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
	let expected = peak + path_scores.iter().map(|s| (s - peak).exp()).sum::<f64>().ln();
	assert!(
		(got - expected).abs() < 1e-4,
		"log Z {got} against the enumeration's {expected}"
	);
	let gold = vec![all[all.len() / 2].clone()];
	let nll = crf.nll(&scores, &gold, &lengths).double_value(&[0]);
	assert!(nll.is_finite() && nll >= -1e-4, "nll {nll}");
}
