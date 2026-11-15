// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Times the stages of one `rcg_recognize` call inside the engine, with no boundary in the way: the search, the capture
//! extraction and validation, and the serialization of the result.
//!
//! Each stage runs alone in its own loop, so the timer's cost is one reading per loop and not one per call. The
//! search-only loop calls `Engine::search`; the recognition loop calls `Engine::recognize` and so contains the search;
//! the export loop calls `rcg_recognize` and so contains both. The differences are the stages.
//!
//! Usage: `cargo run --release -p recognize-wasm --example stages [-- --json]`

use std::hint::black_box;
use std::time::Instant;

use recognize_core::Engine;
use recognize_wasm::{rcg_load, rcg_recognize};

const WARM_UP_CALLS: usize = 20_000;
const TIMED_CALLS: usize = 200_000;

const WHITE_HOUSE: &str = "1600 Pennsylvania Avenue NW, Washington, DC 20500, United States of America";

fn artifact(family: &str) -> Vec<u8> {
	let path = format!("{}/../../data/artifacts/{family}.rca1", env!("CARGO_MANIFEST_DIR"));

	std::fs::read(path).expect("the committed artifact exists")
}

fn microseconds(mut run: impl FnMut()) -> f64 {
	for _ in 0..WARM_UP_CALLS {
		run();
	}

	let start = Instant::now();

	for _ in 0..TIMED_CALLS {
		run();
	}

	start.elapsed().as_secs_f64() * 1e6 / TIMED_CALLS as f64
}

fn main() {
	let white_house_four = WHITE_HOUSE.repeat(4);
	let ones = "1".repeat(300);
	let inputs: Vec<&str> = vec![
		&ones,
		"68161",
		"SW1A 1AA",
		"350 5th Ave, New York, NY 10118",
		"〒100-0001 東京都千代田区千代田1-1",
		"金龍酒家, 12 Gerrard Street, London WC2H 7JS",
		&white_house_four,
	];

	let mut engine = Engine::new();

	for family in ["primitives", "coordinates"] {
		let bytes = artifact(family);
		let hash = recognize_core::declared::declarations_hash(family).unwrap();

		engine.load(&bytes).expect("the artifact loads");

		let handle = unsafe { rcg_load(bytes.as_ptr(), bytes.len(), hash.as_ptr(), hash.len()) };

		assert!(handle >= 0);
	}

	// The `postal` family belongs to `@mailwoman/postcode`, and its declarations hash is the one its artifact embeds.
	let postal = std::fs::read(format!(
		"{}/../../../postcode/data/artifacts/postal.rca1",
		env!("CARGO_MANIFEST_DIR")
	))
	.expect("the committed postal artifact exists");

	engine.load(&postal).expect("the postal artifact loads");

	let hash = engine.header("postal").unwrap().declarations_hash.clone();
	let handle = unsafe { rcg_load(postal.as_ptr(), postal.len(), hash.as_ptr(), hash.len()) };

	assert!(handle >= 0);

	println!("| Input | UTF-8 bytes | Candidates | search | search + extract + validate | rcg_recognize (all) |");
	println!("| --- | --- | --- | --- | --- | --- |");

	for input in inputs {
		let candidates = engine.search(input).unwrap().len();
		let search = microseconds(|| {
			black_box(engine.search(black_box(input)).unwrap().len());
		});
		let recognize = microseconds(|| {
			black_box(engine.recognize(black_box(input)).unwrap().len());
		});
		let export = microseconds(|| {
			black_box(unsafe { rcg_recognize(black_box(input).as_ptr(), input.len(), 0b111) });
		});
		let label: String = input.chars().take(40).collect();

		println!(
			"| `{label}` | {} | {candidates} | {search:.2} | {recognize:.2} | {export:.2} |",
			input.len()
		);
	}
}
