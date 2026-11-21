// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! With tracing off, the search and the result path build no trace. This file holds one test, because the count of
//! traces built is per process and a second test in the same binary would add to it.

mod support;

use recognizer_core::trace::traces_built;

use support::engine_for;

#[test]
fn a_call_that_does_not_ask_for_a_trace_builds_none() {
	let engine = engine_for(recognizer_core::grammars::families());
	let texts = [
		"68161",
		"12.5, 45.2",
		"geo:40.7128,-74.0060",
		"see 1, 2 and geo:3,4;u=5 now",
		"100, 200",
	];

	assert_eq!(traces_built(), 0);

	for text in texts {
		engine.search(text).unwrap();
		engine.locate(text, |_| true).unwrap();
		engine.recognize(text).unwrap();
	}

	assert_eq!(traces_built(), 0, "the default path built a trace");

	// The opt-in path does build them, so the counter is a measure and not a constant.
	let built = engine.trace("12.5, 45.2", |_| true, &[]).unwrap().len();

	assert!(built > 0);
	assert_eq!(traces_built(), built);
}
