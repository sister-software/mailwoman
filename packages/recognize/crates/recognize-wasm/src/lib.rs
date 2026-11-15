// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The WebAssembly boundary for `@mailwoman/recognize`.
//!
//! The exports form a C ABI that `packages/recognize/lib/runtime/abi.ts` calls directly, as the registry's adapter does.
//! The caller stages bytes in linear memory with `rcg_alloc`, loads each family's artifact with `rcg_load` and receives
//! a family handle, and then recognizes text with `rcg_recognize`, naming the families to search as a bit mask of
//! handles. The result is one JSON document in a buffer the module owns: `rcg_result_ptr` and the returned length
//! locate it, and it stays valid until the next call.
//!
//! The engine is the search runtime and the validators. Family artifacts are data the caller passes after
//! instantiation, so the module's size does not grow with the grammars.
//!
//! Every fallible export returns -1 and records an error code and message that `rcg_error_code`, `rcg_error_ptr` and
//! `rcg_error_len` read. A panic aborts, which a host sees as a WebAssembly trap.
//!
//! # Result document
//!
//! ```text
//! { "recognitions": [ { "family": "coordinates", "shape": "coordinate.decimal_pair",
//!                       "start": 3, "end": 20,
//!                       "validation": { "status": "validated", "payload": { … } } } ],
//!   "fields": {} }
//! ```
//!
//! `start` and `end` are UTF-8 byte offsets, and the TypeScript side converts them to UTF-16 code units. `validation`
//! is `{"status":"unvalidated"}`, `{"status":"validated","payload":…}` or
//! `{"status":"rejected","rejection":{"code":…,"capture":…,"message":…}}`. `fields` holds each family's own result
//! fields, which no family declares yet, so it is always an empty object.

use std::cell::RefCell;

use recognize_core::declared::Payload;
use recognize_core::{ArtifactError, Engine, Expected, Rejection, SearchError, ValidationResult};
use serde::Serialize;

/// The ABI version the TypeScript loader checks. Bump it on any change to an export's signature or to the result
/// document's shape.
pub const ABI_VERSION: u32 = 1;

/// The families one instance loads, bounded by the bits of the mask `rcg_recognize` takes.
pub const MAX_FAMILIES: usize = 32;

/// Error codes `rcg_error_code` answers.
pub mod code {
	/// The artifact failed validation.
	pub const ARTIFACT: i32 = 1;
	/// The artifact's declarations hash differs from the expected one or from the engine's own.
	pub const DECLARATIONS_HASH: i32 = 2;
	/// The text is longer than a family admits.
	pub const INPUT_TOO_LONG: i32 = 3;
	/// The text is not UTF-8.
	pub const NOT_UTF8: i32 = 4;
	/// The automaton stopped the search.
	pub const SEARCH: i32 = 5;
	/// An argument was out of range: no family handle, too many families, or a bad hash.
	pub const ARGUMENT: i32 = 6;
}

#[derive(Default)]
struct State {
	engine: Engine,
	result: Vec<u8>,
	error_code: i32,
	error_message: String,
}

thread_local! {
	static STATE: RefCell<State> = RefCell::new(State::default());
}

fn fail(state: &mut State, code: i32, message: impl Into<String>) -> i32 {
	state.error_code = code;
	state.error_message = message.into();
	-1
}

/// Allocations hold bytes the engine reads as `u32`, so each is 8-byte aligned.
const ALIGN: usize = 8;

fn layout(len: usize) -> std::alloc::Layout {
	std::alloc::Layout::from_size_align(len.max(1), ALIGN).expect("a length that fits a layout")
}

/// The ABI version this module implements.
#[no_mangle]
pub extern "C" fn rcg_abi_version() -> u32 {
	ABI_VERSION
}

/// Allocates `len` bytes the caller fills and later frees with `rcg_dealloc` and the same length.
#[no_mangle]
pub extern "C" fn rcg_alloc(len: usize) -> *mut u8 {
	// SAFETY: the layout has a non-zero size.
	unsafe { std::alloc::alloc(layout(len)) }
}

/// Frees memory from `rcg_alloc`.
///
/// # Safety
/// `ptr` and `len` must come from one `rcg_alloc` call that has not been freed.
#[no_mangle]
pub unsafe extern "C" fn rcg_dealloc(ptr: *mut u8, len: usize) {
	std::alloc::dealloc(ptr, layout(len));
}

/// The code of the last error, or 0.
#[no_mangle]
pub extern "C" fn rcg_error_code() -> i32 {
	STATE.with(|state| state.borrow().error_code)
}

/// The address of the last error's message, UTF-8, valid until the next failing call.
#[no_mangle]
pub extern "C" fn rcg_error_ptr() -> *const u8 {
	STATE.with(|state| state.borrow().error_message.as_ptr())
}

/// The byte length of the last error's message.
#[no_mangle]
pub extern "C" fn rcg_error_len() -> usize {
	STATE.with(|state| state.borrow().error_message.len())
}

/// Loads one family artifact and returns its handle, or -1.
///
/// The artifact is refused when its declarations hash differs from the 64 ASCII bytes at `hash_ptr`, and when it differs
/// from the declarations this module was built with. The engine copies what it needs, so the caller may free the
/// artifact's bytes afterwards.
///
/// # Safety
/// `ptr` must address `len` readable bytes and `hash_ptr` must address `hash_len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn rcg_load(ptr: *const u8, len: usize, hash_ptr: *const u8, hash_len: usize) -> i32 {
	let bytes = std::slice::from_raw_parts(ptr, len);
	let hash = std::slice::from_raw_parts(hash_ptr, hash_len);

	STATE.with(|state| {
		let mut state = state.borrow_mut();

		if state.engine.family_ids().len() >= MAX_FAMILIES {
			return fail(
				&mut state,
				code::ARGUMENT,
				format!("an instance loads at most {MAX_FAMILIES} families"),
			);
		}

		let Ok(hash) = std::str::from_utf8(hash) else {
			return fail(&mut state, code::ARGUMENT, "the expected declarations hash is not text");
		};

		let loaded = state.engine.load_checked(
			bytes,
			&Expected {
				ir_hash: None,
				declarations_hash: Some(hash),
			},
		);

		match loaded {
			Ok(()) => i32::try_from(state.engine.family_ids().len() - 1).expect("at most 32 families"),
			Err(error @ ArtifactError::DeclarationsHash { .. }) => {
				fail(&mut state, code::DECLARATIONS_HASH, error.to_string())
			}
			Err(error) => fail(&mut state, code::ARTIFACT, error.to_string()),
		}
	})
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum Validation<'a> {
	Unvalidated,
	Validated { payload: &'a Payload },
	Rejected { rejection: &'a Rejection },
}

#[derive(Serialize)]
struct Recognized<'a> {
	family: &'a str,
	shape: &'a str,
	start: usize,
	end: usize,
	validation: Validation<'a>,
}

#[derive(Serialize)]
struct Document<'a> {
	recognitions: Vec<Recognized<'a>>,
	fields: Empty,
}

/// The per-family result fields: none yet. A family that declares fields adds them here without a change to the ABI.
#[derive(Serialize)]
struct Empty {}

/// Recognizes the UTF-8 text at `ptr` over the families whose handle bit is set in `mask`, and returns the byte length
/// of the result document, or -1. The document is at `rcg_result_ptr`.
///
/// # Safety
/// `ptr` must address `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn rcg_recognize(ptr: *const u8, len: usize, mask: u32) -> i32 {
	let bytes = std::slice::from_raw_parts(ptr, len);

	STATE.with(|state| {
		let mut state = state.borrow_mut();
		let loaded = state.engine.family_ids().len();

		if loaded < MAX_FAMILIES && mask >> loaded != 0 {
			return fail(&mut state, code::ARGUMENT, "the mask names a family that is not loaded");
		}

		let Ok(text) = std::str::from_utf8(bytes) else {
			return fail(&mut state, code::NOT_UTF8, "the text is not UTF-8");
		};

		// The buffer is taken first so the recognitions can borrow the engine while the document is written.
		let mut buffer = std::mem::take(&mut state.result);
		let outcome = state.engine.recognize_in(text, |index| mask & (1 << index) != 0);
		let recognitions = match outcome {
			Ok(recognitions) => recognitions,
			Err(error) => {
				let code = match error {
					SearchError::InputTooLong { .. } => code::INPUT_TOO_LONG,
					SearchError::NotUTF8 { .. } => code::NOT_UTF8,
					SearchError::Automaton(_) => code::SEARCH,
				};

				return fail(&mut state, code, error.to_string());
			}
		};

		let document = Document {
			recognitions: recognitions
				.iter()
				.map(|recognition| Recognized {
					family: recognition.candidate.family,
					shape: recognition.candidate.shape,
					start: recognition.candidate.start,
					end: recognition.candidate.end,
					validation: match &recognition.validation {
						ValidationResult::Unvalidated => Validation::Unvalidated,
						ValidationResult::Validated(payload) => Validation::Validated { payload },
						ValidationResult::Rejected(rejection) => Validation::Rejected { rejection },
					},
				})
				.collect(),
			fields: Empty {},
		};
		buffer.clear();

		let written = serde_json::to_writer(&mut buffer, &document).is_ok();

		drop(recognitions);
		state.result = buffer;

		if !written {
			return fail(&mut state, code::SEARCH, "the result did not serialize");
		}

		match i32::try_from(state.result.len()) {
			Ok(length) => length,
			Err(_) => fail(&mut state, code::SEARCH, "the result is too large"),
		}
	})
}

/// The address of the last result document, valid until the next `rcg_recognize`.
#[no_mangle]
pub extern "C" fn rcg_result_ptr() -> *const u8 {
	STATE.with(|state| state.borrow().result.as_ptr())
}

#[cfg(test)]
mod tests {
	use super::*;

	fn artifact(family: &str) -> Vec<u8> {
		let path = format!("{}/../../data/artifacts/{family}.rca1", env!("CARGO_MANIFEST_DIR"));

		std::fs::read(path).expect("the committed artifact exists")
	}

	fn hash(family: &str) -> &'static str {
		recognize_core::declared::declarations_hash(family).unwrap()
	}

	fn load(family: &str, expected: &str) -> i32 {
		let bytes = artifact(family);

		unsafe { rcg_load(bytes.as_ptr(), bytes.len(), expected.as_ptr(), expected.len()) }
	}

	fn message() -> String {
		STATE.with(|state| state.borrow().error_message.clone())
	}

	fn recognize(text: &str, mask: u32) -> serde_json::Value {
		let length = unsafe { rcg_recognize(text.as_ptr(), text.len(), mask) };

		assert!(length >= 0, "{}", message());

		let bytes = STATE.with(|state| state.borrow().result.clone());

		assert_eq!(bytes.len(), length as usize);
		serde_json::from_slice(&bytes).unwrap()
	}

	// One instance per test thread: `cargo test` runs each test on its own thread, and the state is thread-local.
	#[test]
	fn a_loaded_family_recognizes_text_and_reports_its_payload() {
		assert_eq!(rcg_abi_version(), ABI_VERSION);
		assert_eq!(load("primitives", hash("primitives")), 0);
		assert_eq!(load("coordinates", hash("coordinates")), 1);

		let all = recognize("40.5, -74", 0b11);
		let pair = all["recognitions"]
			.as_array()
			.unwrap()
			.iter()
			.find(|recognition| recognition["shape"] == "coordinate.decimal_pair")
			.unwrap();

		assert_eq!(pair["validation"]["status"], "validated");
		assert_eq!(pair["validation"]["payload"]["latitude"], 40.5);
		assert_eq!(all["fields"], serde_json::json!({}));

		// A mask that leaves the coordinates family out leaves its shapes out.
		let primitives_only = recognize("40.5, -74", 0b01);

		assert!(primitives_only["recognitions"]
			.as_array()
			.unwrap()
			.iter()
			.all(|recognition| recognition["family"] == "primitives"));
		assert!(primitives_only["recognitions"][0]["validation"]["status"] == "unvalidated");
	}

	#[test]
	fn an_artifact_with_another_declarations_hash_is_refused_with_a_clear_message() {
		assert_eq!(load("primitives", &"0".repeat(64)), -1);
		assert_eq!(rcg_error_code(), code::DECLARATIONS_HASH);
		assert!(message().contains("declarations hash"), "{}", message());
	}

	#[test]
	fn bad_arguments_are_errors_and_not_traps() {
		let text = "1, 2";

		assert_eq!(unsafe { rcg_recognize(text.as_ptr(), text.len(), 1) }, -1);
		assert_eq!(rcg_error_code(), code::ARGUMENT);

		let bytes = [0xFFu8];

		assert_eq!(load("primitives", hash("primitives")), 0);
		assert_eq!(unsafe { rcg_recognize(bytes.as_ptr(), 1, 1) }, -1);
		assert_eq!(rcg_error_code(), code::NOT_UTF8);

		let long = "1".repeat(5000);

		assert_eq!(unsafe { rcg_recognize(long.as_ptr(), long.len(), 1) }, -1);
		assert_eq!(rcg_error_code(), code::INPUT_TOO_LONG);
		assert!(message().contains("5000"), "{}", message());
	}

	#[test]
	fn a_corrupt_artifact_is_refused() {
		let mut bytes = artifact("primitives");
		let expected = hash("primitives");

		bytes[0] = b'X';

		assert_eq!(
			unsafe { rcg_load(bytes.as_ptr(), bytes.len(), expected.as_ptr(), expected.len()) },
			-1
		);
		assert_eq!(rcg_error_code(), code::ARTIFACT);
	}
}
