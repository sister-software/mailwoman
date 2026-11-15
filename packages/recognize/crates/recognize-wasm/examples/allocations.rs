// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Counts the heap allocations of one `Engine::recognize` call and of one `rcg_recognize` call, with a counting global
//! allocator, over the inputs of the benchmark.
//!
//! The default call path builds no trace, so its count is the count a build without tracing has. The example is run on
//! the commit before the trace work and on the commit after it, and the two tables must be equal.
//!
//! Usage: `cargo run --release -p recognize-wasm --example allocations`

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use recognize_core::Engine;
use recognize_wasm::{rcg_load, rcg_recognize, rcg_trace};

struct Counting;

static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
static BYTES: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
	unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
		ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
		BYTES.fetch_add(layout.size(), Ordering::Relaxed);
		System.alloc(layout)
	}

	unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
		System.dealloc(pointer, layout)
	}

	unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
		ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
		BYTES.fetch_add(size, Ordering::Relaxed);
		System.realloc(pointer, layout, size)
	}
}

#[global_allocator]
static COUNTING: Counting = Counting;

const WHITE_HOUSE: &str = "1600 Pennsylvania Avenue NW, Washington, DC 20500, United States of America";

fn artifact(family: &str) -> Vec<u8> {
	let path = format!("{}/../../data/artifacts/{family}.rca1", env!("CARGO_MANIFEST_DIR"));

	std::fs::read(path).expect("the committed artifact exists")
}

/// The allocations and bytes one call of `run` makes, after one call that warms any lazy state.
fn measure(mut run: impl FnMut()) -> (usize, usize) {
	run();

	let (allocations, bytes) = (ALLOCATIONS.load(Ordering::Relaxed), BYTES.load(Ordering::Relaxed));

	run();

	(
		ALLOCATIONS.load(Ordering::Relaxed) - allocations,
		BYTES.load(Ordering::Relaxed) - bytes,
	)
}

fn main() {
	let white_house_four = WHITE_HOUSE.repeat(4);
	let inputs: Vec<&str> = vec![
		"68161",
		"SW1A 1AA",
		"350 5th Ave, New York, NY 10118",
		"〒100-0001 東京都千代田区千代田1-1",
		"金龍酒家, 12 Gerrard Street, London WC2H 7JS",
		"40.7128, -74.0060",
		"geo:40.7128,-74.0060",
		&white_house_four,
	];

	let mut engine = Engine::new();

	for family in ["primitives", "coordinates"] {
		let bytes = artifact(family);
		let hash = recognize_core::declared::declarations_hash(family).unwrap();

		engine
			.load_checked(
				&bytes,
				&recognize_core::Expected {
					ir_hash: None,
					declarations_hash: Some(hash),
				},
			)
			.unwrap();

		let handle = unsafe { rcg_load(bytes.as_ptr(), bytes.len(), hash.as_ptr(), hash.len()) };

		assert!(handle >= 0);
	}

	println!("| Input | Engine::recognize allocations | bytes | rcg_recognize allocations | bytes |");
	println!("| --- | --- | --- | --- | --- |");

	let mut trace_rows = Vec::new();

	for input in inputs {
		let (engine_allocations, engine_bytes) = measure(|| {
			std::hint::black_box(engine.recognize(input).unwrap());
		});
		let (adapter_allocations, adapter_bytes) = measure(|| {
			std::hint::black_box(unsafe { rcg_recognize(input.as_ptr(), input.len(), 0b11) });
		});
		let label: String = input.chars().take(40).collect();

		println!("| `{label}` | {engine_allocations} | {engine_bytes} | {adapter_allocations} | {adapter_bytes} |");

		// The opt-in path, for scale. It is the only call that builds a trace.
		let (trace_allocations, trace_bytes) = measure(|| {
			std::hint::black_box(unsafe { rcg_trace(input.as_ptr(), input.len(), 0b11, [].as_ptr(), 0) });
		});

		trace_rows.push(format!("| `{label}` | {trace_allocations} | {trace_bytes} |"));
	}

	println!("\n| Input | rcg_trace allocations (tracing on) | bytes |");
	println!("| --- | --- | --- |");

	for row in trace_rows {
		println!("{row}");
	}
}
