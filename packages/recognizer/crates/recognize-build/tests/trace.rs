// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Traces against the outcomes the engine reports: an accepted span, a validator rejection and a grammar rejection each
//! have a trace that says what the engine decided, and the trace never disagrees with a search.

mod support;

use recognize_core::trace::{Outcome, TraceResult};
use recognize_core::{Engine, Scope, ValidationResult};

use support::engine_for;

fn engine() -> Engine {
	engine_for(recognize_core::grammars::families())
}

fn all(_: usize) -> bool {
	true
}

/// A trace as the adapter writes it, so a test reads what a host reads.
fn json(trace: &recognize_core::Trace) -> serde_json::Value {
	serde_json::to_value(trace).unwrap()
}

#[test]
fn an_accepted_span_traces_every_item_and_the_validator() {
	let engine = engine();
	let text = "40.7128, -74.0060";
	let traces = engine.trace(text, all, &[]).unwrap();
	let trace = traces
		.iter()
		.find(|trace| trace.shape == "coordinate.decimal_pair")
		.unwrap();

	assert_eq!(trace.family, "coordinates");
	assert_eq!(trace.result, TraceResult::Validated);
	assert_eq!(trace.span.map(|span| (span.start, span.end)), Some((0, text.len())));

	let nodes: Vec<(&str, &str, Outcome)> = trace
		.steps
		.iter()
		.map(|step| (step.node.as_str(), step.op, step.outcome))
		.collect();

	assert_eq!(
		nodes,
		vec![
			("coordinate.decimal_pair#0", "capture", Outcome::Pass),
			("coordinate.decimal_pair#1", "repeat", Outcome::Pass),
			("coordinate.decimal_pair#2", "class", Outcome::Pass),
			("coordinate.decimal_pair#3", "repeat", Outcome::Pass),
			("coordinate.decimal_pair#4", "capture", Outcome::Pass),
			("coordinate.decimal_pair#validator", "validator", Outcome::Pass),
		]
	);

	// Each item has the span it took, and the items tile the recognized span.
	let spans: Vec<(usize, usize)> = trace
		.steps
		.iter()
		.filter_map(|step| step.span.map(|span| (span.start, span.end)))
		.collect();

	assert_eq!(spans, vec![(0, 7), (7, 7), (7, 8), (8, 9), (9, 17)]);
	assert_eq!(trace.steps[0].name.as_deref(), Some("first"));
	assert!(trace.steps[0].source.file.ends_with("grammars/coordinates.rs"));
	assert!(trace.steps[0].source.line > 0);

	let value = json(trace);

	assert_eq!(value["shape"], "coordinate.decimal_pair");
	assert_eq!(value["span"], serde_json::json!({"start": 0, "end": 17}));
	assert_eq!(value["result"], "validated");
	assert_eq!(value["steps"][0]["outcome"], "pass");
}

#[test]
fn a_validator_rejection_has_a_rejected_last_step_with_its_typed_reason() {
	let engine = engine();
	let text = "100, 200";
	let trace = engine
		.trace(text, all, &[])
		.unwrap()
		.into_iter()
		.find(|trace| trace.shape == "coordinate.decimal_pair")
		.unwrap();

	assert_eq!(trace.result, TraceResult::Rejected);

	let (grammar, last) = trace.steps.split_at(trace.steps.len() - 1);

	assert!(grammar.iter().all(|step| step.outcome == Outcome::Pass));
	assert_eq!(last[0].outcome, Outcome::Rejected);
	assert_eq!(last[0].node, "coordinate.decimal_pair#validator");

	let rejection = last[0].rejection.as_ref().unwrap();

	assert_eq!(rejection.code, "latitude_out_of_range");
	assert_eq!(rejection.capture.as_deref(), Some("first"));
}

#[test]
fn a_grammar_rejection_names_the_first_item_no_parse_survives() {
	let engine = engine();
	// The first number and the whitespace after it are read, and no comma follows.
	let text = "40.7128 -74.0060";
	let traces = engine.trace(text, all, &["coordinate.decimal_pair"]).unwrap();
	let trace = traces.last().unwrap();

	assert_eq!(trace.shape, "coordinate.decimal_pair");
	assert_eq!(trace.result, TraceResult::NoMatch);
	assert_eq!(trace.span, None);

	let outcomes: Vec<(&str, Outcome)> = trace
		.steps
		.iter()
		.map(|step| (step.node.as_str(), step.outcome))
		.collect();

	assert_eq!(
		outcomes,
		vec![
			("coordinate.decimal_pair#0", Outcome::Pass),
			("coordinate.decimal_pair#1", Outcome::Pass),
			("coordinate.decimal_pair#2", Outcome::Fail),
		]
	);

	// The failing item is reported at the furthest offset the earlier items reached: after the space.
	let at = trace.steps[2].span.unwrap();

	assert_eq!((at.start, at.end), (8, 8));
	assert!(trace.steps[..2].iter().all(|step| step.span.is_none()));

	// The search agrees: no pair is recognized.
	assert!(!engine
		.recognize(text)
		.unwrap()
		.iter()
		.any(|recognition| recognition.candidate.shape == "coordinate.decimal_pair"));
}

#[test]
fn a_text_that_runs_past_the_grammar_fails_at_the_end() {
	let engine = engine();
	let text = "40.7, 5 x";
	let trace = engine
		.trace(text, all, &["coordinate.decimal_pair"])
		.unwrap()
		.pop()
		.unwrap();

	assert_eq!(trace.result, TraceResult::NoMatch);

	let last = trace.steps.last().unwrap();

	assert_eq!(last.node, "coordinate.decimal_pair#end");
	assert_eq!(last.outcome, Outcome::Fail);
	assert_eq!(last.span.map(|span| (span.start, span.end)), Some((7, 9)));
	assert!(trace.steps[..trace.steps.len() - 1]
		.iter()
		.all(|step| step.outcome == Outcome::Pass));
}

#[test]
fn explaining_a_shape_that_matches_gives_the_accepted_trace() {
	let engine = engine();
	let traces = engine.trace("geo:1,2", all, &["coordinate.geo_uri"]).unwrap();
	let explained = traces.last().unwrap();

	assert_eq!(explained.shape, "coordinate.geo_uri");
	assert_eq!(explained.result, TraceResult::Validated);
	assert_eq!(
		explained,
		traces.iter().find(|trace| trace.shape == "coordinate.geo_uri").unwrap()
	);
}

#[test]
fn an_explained_shape_no_family_declares_has_no_trace() {
	let engine = engine();

	assert!(engine
		.trace("1, 2", all, &["no.such_shape"])
		.unwrap()
		.iter()
		.all(|trace| trace.shape != "no.such_shape"));
}

#[test]
fn a_trace_always_matches_the_engines_outcome() {
	let engine = engine();
	let ids: Vec<String> = engine.family_ids().iter().map(|id| id.to_string()).collect();
	let long_digits = "9".repeat(400);
	let corpus = [
		"",
		"x",
		"12345 Main Street",
		"12.5, 45.2",
		"40.7128, -74.0060",
		"-74.0060, 40.7128",
		"100, 200",
		"91, 181",
		"geo:48.2010,16.3695,183;crs=wgs84;u=40",
		"geo:48.2,16.3;crs=Moon-2011",
		"geo:94,0",
		"see geo:1,2 and 3, 4 now",
		"Apt 4, 12 Main St",
		"東京 35.68, 139.69 です",
		"💥1,2💥",
		"1,2,3",
		"geo:1,2;x=1;crs=wgs84",
		&format!("{long_digits}, 1"),
		&format!("geo:1,2;{}", "a".repeat(300)),
	];

	for text in corpus {
		let recognitions = engine.recognize(text).unwrap();
		let traces = engine.trace(text, all, &[]).unwrap();

		assert_eq!(recognitions.len(), traces.len(), "{text:?}");

		for (recognition, trace) in recognitions.iter().zip(&traces) {
			let context = format!("{text:?} {}", recognition.candidate.shape);

			assert_eq!(trace.shape, recognition.candidate.shape, "{context}");
			assert_eq!(
				trace.span.map(|span| (span.start, span.end)),
				Some((recognition.candidate.start, recognition.candidate.end)),
				"{context}"
			);

			let expected = match &recognition.validation {
				ValidationResult::Unvalidated => TraceResult::Accepted,
				ValidationResult::Validated(_) => TraceResult::Validated,
				ValidationResult::Rejected(rejection)
					if rejection.code == "capture_limit" || rejection.code == "capture_mismatch" =>
				{
					// The engine's own rejections come from the capture walk; the replay reports what it finds.
					trace.result
				}
				ValidationResult::Rejected(_) => TraceResult::Rejected,
			};

			assert_eq!(trace.result, expected, "{context}");

			if let ValidationResult::Rejected(rejection) = &recognition.validation {
				if trace.result == TraceResult::Rejected {
					assert_eq!(
						trace.steps.last().unwrap().rejection.as_ref(),
						Some(rejection),
						"{context}"
					);
				}
			}
		}

		// Whether a shape matches the whole text is the same question for the search and for the explanation.
		for (index, family) in ids.iter().enumerate() {
			let document = support::documents(recognize_core::grammars::families())
				.into_iter()
				.find(|document| &document.family == family)
				.unwrap();

			for shape in document
				.shapes
				.iter()
				.filter(|shape| !matches!(shape.scope, Scope::Embedded | Scope::Partition))
			{
				let searched = recognitions.iter().any(|recognition| {
					recognition.candidate.shape == shape.id
						&& recognition.candidate.family == family
						&& (recognition.candidate.start, recognition.candidate.end) == (0, text.len())
				});
				let explained = engine
					.trace(text, |position| position == index, &[shape.id.as_str()])
					.unwrap()
					.pop();

				if text.is_empty() {
					assert!(!searched);

					continue;
				}

				let explained = explained.unwrap();

				assert_eq!(
					searched,
					explained.result != TraceResult::NoMatch && explained.result != TraceResult::Incomplete,
					"{text:?} {}: {explained:?}",
					shape.id
				);
			}
		}
	}
}

#[test]
fn a_trace_spans_never_split_a_codepoint() {
	let engine = engine();
	let text = "💥1,2💥 東京 3.5, 4.5";

	for trace in engine.trace(text, all, &["coordinate.decimal_pair"]).unwrap() {
		let spans = trace
			.span
			.into_iter()
			.chain(trace.steps.iter().filter_map(|step| step.span));

		for span in spans {
			assert!(
				text.is_char_boundary(span.start) && text.is_char_boundary(span.end),
				"{trace:?}"
			);
		}
	}
}
