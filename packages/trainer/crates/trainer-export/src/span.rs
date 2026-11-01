//! The span scorer's segment types and the `semi-crf-transitions.json` sidecar beside a span-scorer graph.
//!
//! The graph's `span_scores` output carries no transition table, so the browser decoder (`@mailwoman/neural`'s
//! `semi-markov-decode.ts`) reads `segment_types`, `max_span` and the three transition tables from the sidecar, as
//! `export/package_weights.py::export_semi_crf_transitions` wrote it.

use crate::checkpoint::StateDict;
use crate::config::ModelConfig;
use crate::{fail, Result};

/// The sidecar's file name beside `model.onnx`.
pub const SEMI_CRF_TRANSITIONS_FILE: &str = "semi-crf-transitions.json";

/// `_derive_segment_types`: `O`, then each tag in the order the BIO labels first name it.
pub fn segment_types(labels: &[String]) -> Vec<String> {
	let mut types = vec!["O".to_owned()];
	for label in labels {
		if label == "O" {
			continue;
		}
		let component = label.split_once('-').map_or(label.as_str(), |(_, c)| c);
		if !types.iter().any(|t| t == component) {
			types.push(component.to_owned());
		}
	}
	types
}

/// The sidecar's fields, in the order the Python writer wrote them. Each score is the float32 widened to float64.
#[derive(Debug)]
pub struct SemiCrfTransitions {
	pub segment_types: Vec<String>,
	pub max_span: usize,
	pub transitions: Vec<Vec<f64>>,
	pub start_transitions: Vec<f64>,
	pub end_transitions: Vec<f64>,
}

/// Python's `repr` of a finite float: the shortest digits that round-trip, in fixed notation when the decimal
/// exponent is from -4 to 15, and otherwise as `d.ddde±XX`.
pub fn python_float(value: f64) -> Result<String> {
	if !value.is_finite() {
		return Err(fail!("semi-crf-transitions: {value} has no JSON form"));
	}
	let scientific = format!("{value:e}");
	let (mantissa, exponent) = scientific
		.split_once('e')
		.ok_or_else(|| fail!("{scientific} has no exponent"))?;
	let exponent: i32 = exponent.parse().map_err(|_| fail!("{scientific} has a bad exponent"))?;
	if !(-4..16).contains(&exponent) {
		let sign = if exponent < 0 { '-' } else { '+' };
		return Ok(format!("{mantissa}e{sign}{:02}", exponent.abs()));
	}
	let fixed = format!("{value}");
	Ok(if fixed.contains('.') {
		fixed
	} else {
		format!("{fixed}.0")
	})
}

impl SemiCrfTransitions {
	/// The sidecar as `json.dumps(indent=2)` writes it, with a trailing newline.
	pub fn to_json(&self) -> Result<String> {
		let list = |values: &[f64], indent: &str| -> Result<String> {
			if values.is_empty() {
				return Ok("[]".to_owned());
			}
			let items = values
				.iter()
				.map(|&v| Ok(format!("{indent}  {}", python_float(v)?)))
				.collect::<Result<Vec<_>>>()?;
			Ok(format!("[\n{}\n{indent}]", items.join(",\n")))
		};
		let types = self
			.segment_types
			.iter()
			.map(|t| serde_json::to_string(t).map(|s| format!("    {s}")))
			.collect::<std::result::Result<Vec<_>, _>>()
			.map_err(|e| fail!("semi-crf-transitions: {e}"))?;
		let rows = self
			.transitions
			.iter()
			.map(|row| Ok(format!("    {}", list(row, "    ")?)))
			.collect::<Result<Vec<_>>>()?;
		Ok(format!(
			"{{\n  \"segment_types\": [\n{}\n  ],\n  \"max_span\": {},\n  \"transitions\": [\n{}\n  ],\n  \
			 \"start_transitions\": {},\n  \"end_transitions\": {}\n}}\n",
			types.join(",\n"),
			self.max_span,
			rows.join(",\n"),
			list(&self.start_transitions, "  ")?,
			list(&self.end_transitions, "  ")?,
		))
	}
}

/// The sidecar for a span-scorer checkpoint, or `None` for a checkpoint without the scorer.
///
/// The segment types come from the checkpoint's `id2label`, and their count must equal the transition table's width.
pub fn semi_crf_transitions(config: &ModelConfig, state: &StateDict) -> Result<Option<SemiCrfTransitions>> {
	if !config.use_span_scorer {
		return Ok(None);
	}
	let labels = config.labels()?;
	if labels.is_empty() {
		return Err(fail!(
			"a span-scorer checkpoint needs id2label to name its segment types"
		));
	}
	let types = segment_types(&labels);
	let n = types.len();
	let table = state.f32("semi_crf.transitions", &[n, n])?;
	let row = |name: &str| -> Result<Vec<f64>> { Ok(state.f32(name, &[n])?.iter().map(|&v| f64::from(v)).collect()) };
	let transitions: Vec<Vec<f64>> = table
		.chunks(n)
		.map(|r| r.iter().map(|&v| f64::from(v)).collect())
		.collect();
	Ok(Some(SemiCrfTransitions {
		segment_types: types,
		max_span: config.max_span,
		transitions,
		start_transitions: row("semi_crf.start_transitions")?,
		end_transitions: row("semi_crf.end_transitions")?,
	}))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn floats_print_as_python_repr_prints_them() {
		let cases = [
			(1.0, "1.0"),
			(-0.0, "-0.0"),
			(0.0001, "0.0001"),
			(-8.288714161608368e-05, "-8.288714161608368e-05"),
			(f64::from(0.1f32), "0.10000000149011612"),
			(1e15, "1000000000000000.0"),
			(1e16, "1e+16"),
			(1.5e-300, "1.5e-300"),
		];
		for (value, expected) in cases {
			assert_eq!(python_float(value).unwrap(), expected, "{value}");
		}
		assert!(python_float(f64::NAN).is_err());
	}

	#[test]
	fn the_sidecar_is_laid_out_as_json_dumps_indent_2() {
		let sidecar = SemiCrfTransitions {
			segment_types: vec!["O".into(), "street".into()],
			max_span: 2,
			transitions: vec![vec![0.5, -1.0], vec![0.0, 2.0]],
			start_transitions: vec![0.25, 0.0],
			end_transitions: vec![],
		};
		let expected = "{\n  \"segment_types\": [\n    \"O\",\n    \"street\"\n  ],\n  \"max_span\": 2,\n  \
		                \"transitions\": [\n    [\n      0.5,\n      -1.0\n    ],\n    [\n      0.0,\n      2.0\n    ]\n  \
		                ],\n  \"start_transitions\": [\n    0.25,\n    0.0\n  ],\n  \"end_transitions\": []\n}\n";
		assert_eq!(sidecar.to_json().unwrap(), expected);
		assert_eq!(
			segment_types(&["O".into(), "B-street".into(), "I-street".into(), "B-unit".into()]),
			["O", "street", "unit"]
		);
	}
}
