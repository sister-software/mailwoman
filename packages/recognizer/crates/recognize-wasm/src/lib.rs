// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The WebAssembly boundary for `@mailwoman/recognizer`.
//!
//! The exports form a C ABI that `packages/recognizer/lib/runtime/abi.ts` calls directly, as the registry's adapter does.
//! The caller stages bytes in linear memory with `rcg_alloc`, loads each family's artifact with `rcg_load` and receives
//! a family handle, and then recognizes text with `rcg_recognize`, naming the families to search as a bit mask of
//! handles. One call returns the whole result, in two buffers the module owns and reuses: `rcg_result_ptr` addresses
//! the records and `rcg_json_ptr` addresses the text the records point into. Both stay valid until the next call.
//!
//! The engine is the search runtime and the validators. Family artifacts are data the caller passes after
//! instantiation, so the module's size does not grow with the grammars.
//!
//! Every fallible export returns -1 and records an error code and message that `rcg_error_code`, `rcg_error_ptr` and
//! `rcg_error_len` read. A panic aborts, which a host sees as a WebAssembly trap.
//!
//! # Result records
//!
//! `rcg_recognize` returns the number of recognitions. The records are that many runs of [`RECORD_WORDS`] little-endian
//! `u32` words at `rcg_result_ptr`, in the order of a search, which is by start, end, family and shape:
//!
//! ```text
//! word 0  the family's handle
//! word 1  the shape's position in the family's shape table (see `rcg_shapes`)
//! word 2  start, a UTF-8 byte offset
//! word 3  end, a UTF-8 byte offset
//! word 4  status: 0 unvalidated, 1 validated, 2 rejected
//! word 5  byte offset into the JSON text of the validated payload or the rejection
//! word 6  byte length of that JSON, 0 when the status is 0
//! ```
//!
//! The JSON text at `rcg_json_ptr` holds a validated recognition's payload and a rejected recognition's
//! `{"code":…,"capture":…,"message":…}`, one document per such record. A call whose recognitions are all unvalidated
//! writes no JSON, so no text is built or parsed. The TypeScript side converts the byte offsets to UTF-16 code units.
//!
//! `rcg_trace` is the opt-in path to traces. It searches again, replays each recognition against its family's program
//! and writes the traces as JSON. `rcg_recognize` never calls it, and nothing in the default path builds a trace.
//!
//! `rcg_shapes` writes a family's shape table, the shape IDs in byte order joined by newlines, at `rcg_json_ptr`. The
//! caller reads it once when it loads the family and keeps the strings.
//!
//! `rcg_prefix` answers prefix continuation for a text over the families a mask names. It writes one record of
//! [`PREFIX_WORDS`] words for each shape at `rcg_result_ptr`, in place of the recognition records, and returns the
//! number of records:
//!
//! ```text
//! word 0  the family's handle
//! word 1  the shape's position in the family's shape table (see `rcg_shapes`)
//! word 2  the status: 0 dead, 1 viable, 2 accepted, 3 accepted and extendable, 4 unknown
//! ```
//!
//! `rcg_structure` computes the `structure` family's fields for a text, in one call, and writes them as `u32` words at
//! `rcg_result_ptr` in place of the recognition records. It returns the number of words. The layout, with every offset a
//! UTF-8 byte offset the TypeScript side converts:
//!
//! ```text
//! word 0        the number of tokens, n
//! word 1        the number of segments, m
//! word 2        the number of region abbreviations, r
//! words 3..13   the codepoint count of each script, in the order of recognize_core::charset::Script, Zyyy always 0
//! then n tokens of TOKEN_WORDS words: start, end, class | script << 8
//! then m segments of SEGMENT_WORDS words: start, end, separator
//! then r words: the position among the tokens of each region abbreviation
//! then, when the call names a known-formats family, one word k, the number of hits,
//! and k hits of KNOWN_FORMAT_WORDS words: kind, shape, start, end
//! ```
//!
//! A hit's kind is that of `recognize_core::known_formats::HitKind`, its shape is the position in the known-formats
//! family's shape table, or `u32::MAX` for a PO box, and its offsets are UTF-8 byte offsets.
//!
//! The class codes are those of `recognize_core::structure::TokenClass` and the separator codes those of
//! `recognize_core::structure::Separator`.

use std::cell::RefCell;

use recognize_core::charset::SCRIPTS;
use recognize_core::known_formats::KnownFormats;
use recognize_core::structure::Structure;
use recognize_core::{ArtifactError, Engine, Expected, PrefixStatus, SearchError, ValidationResult};

/// The ABI version the TypeScript loader checks. Bump it on any change to an export's signature or to the result
/// records' layout. Version 4 added `rcg_structure`. Version 5 gave it a known-formats family argument. Version 6 added `rcg_prefix`.
pub const ABI_VERSION: u32 = 6;

/// The words of one prefix record.
pub const PREFIX_WORDS: usize = 3;

/// The words of one known-format hit in a structure result.
pub const KNOWN_FORMAT_WORDS: usize = 4;

/// The `rcg_structure` argument that asks for no known formats.
pub const NO_FAMILY: u32 = u32::MAX;

/// The words before the first token of a structure result: three counts and one count for each script.
pub const STRUCTURE_HEADER_WORDS: usize = 3 + SCRIPTS;

/// The words of one token in a structure result.
pub const TOKEN_WORDS: usize = 3;

/// The words of one segment in a structure result.
pub const SEGMENT_WORDS: usize = 3;

/// The families one instance loads, bounded by the bits of the mask `rcg_recognize` takes.
pub const MAX_FAMILIES: usize = 32;

/// The words of one result record.
pub const RECORD_WORDS: usize = 7;

/// Status words of a result record.
pub mod status {
	pub const UNVALIDATED: u32 = 0;
	pub const VALIDATED: u32 = 1;
	pub const REJECTED: u32 = 2;
}

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
	records: Vec<u32>,
	structure: Structure,
	known: KnownFormats,
	json: Vec<u8>,
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

/// Writes the shape table of the family with handle `family` at `rcg_json_ptr` and returns its byte length, or -1 when
/// no family has that handle. The table is the shape IDs in byte order, joined by newlines.
#[no_mangle]
pub extern "C" fn rcg_shapes(family: u32) -> i32 {
	STATE.with(|state| {
		let mut state = state.borrow_mut();
		let state = &mut *state;
		let shapes = state.engine.shapes(family as usize);

		if shapes.is_empty() {
			state.error_code = code::ARGUMENT;
			state.error_message = "no family has that handle".to_string();

			return -1;
		}

		state.json.clear();

		for (index, shape) in shapes.iter().enumerate() {
			if index > 0 {
				state.json.push(b'\n');
			}

			state.json.extend_from_slice(shape.as_bytes());
		}

		i32::try_from(state.json.len()).unwrap_or(-1)
	})
}

fn search_code(error: &SearchError) -> i32 {
	match error {
		SearchError::InputTooLong { .. } => code::INPUT_TOO_LONG,
		SearchError::NotUTF8 { .. } => code::NOT_UTF8,
		SearchError::Automaton(_) => code::SEARCH,
		SearchError::NoPartition { .. } | SearchError::NoWhole { .. } => code::ARGUMENT,
	}
}

/// Appends a validation's JSON to `json` and returns the record's status, offset and length words.
fn write_validation(json: &mut Vec<u8>, validation: &ValidationResult) -> Result<[u32; 3], String> {
	let start = json.len();
	let word = match validation {
		ValidationResult::Unvalidated => return Ok([status::UNVALIDATED, 0, 0]),
		ValidationResult::Validated(payload) => {
			serde_json::to_writer(&mut *json, payload).map_err(|error| error.to_string())?;
			status::VALIDATED
		}
		ValidationResult::Rejected(rejection) => {
			serde_json::to_writer(&mut *json, rejection).map_err(|error| error.to_string())?;
			status::REJECTED
		}
	};
	let offset = u32::try_from(start).map_err(|_| "the result is too large".to_string())?;
	let length = u32::try_from(json.len() - start).map_err(|_| "the result is too large".to_string())?;

	Ok([word, offset, length])
}

/// Recognizes the UTF-8 text at `ptr` over the families whose handle bit is set in `mask`, and returns the number of
/// result records, or -1. The records are at `rcg_result_ptr` and their JSON at `rcg_json_ptr`.
///
/// # Safety
/// `ptr` must address `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn rcg_recognize(ptr: *const u8, len: usize, mask: u32) -> i32 {
	let bytes = std::slice::from_raw_parts(ptr, len);

	STATE.with(|state| {
		let mut state = state.borrow_mut();
		let state = &mut *state;
		let loaded = state.engine.family_ids().len();

		if loaded < MAX_FAMILIES && mask >> loaded != 0 {
			return fail(state, code::ARGUMENT, "the mask names a family that is not loaded");
		}

		let Ok(text) = std::str::from_utf8(bytes) else {
			return fail(state, code::NOT_UTF8, "the text is not UTF-8");
		};

		let located = match state.engine.locate(text, |index| mask & (1 << index) != 0) {
			Ok(located) => located,
			Err(error) => return fail(state, search_code(&error), error.to_string()),
		};

		state.records.clear();
		state.json.clear();

		for span in &located {
			let (_, validation) = state.engine.validate(*span, text);
			let words = match write_validation(&mut state.json, &validation) {
				Ok(words) => words,
				Err(message) => return fail(state, code::SEARCH, message),
			};

			// A text this engine searches is at most a family's limit of bytes, which fits a word.
			state.records.extend_from_slice(&[
				span.family as u32,
				span.shape as u32,
				span.start as u32,
				span.end as u32,
				words[0],
				words[1],
				words[2],
			]);
		}

		i32::try_from(located.len()).unwrap_or(-1)
	})
}

/// Computes the structural fields of the UTF-8 text at `ptr` with the family whose handle is `family`, and returns the
/// number of `u32` words it wrote at `rcg_result_ptr`, or -1. The layout is in the module documentation. The call
/// overwrites the records `rcg_recognize` wrote, so a caller reads those first.
///
/// When `formats` is a family handle and not [`NO_FAMILY`], the call also computes the known formats of the text's tokens
/// with that family and appends them to the words.
///
/// # Safety
/// `ptr` must address `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn rcg_structure(ptr: *const u8, len: usize, family: u32, formats: u32) -> i32 {
	let bytes = std::slice::from_raw_parts(ptr, len);

	STATE.with(|state| {
		let mut state = state.borrow_mut();
		let state = &mut *state;

		let loaded = state.engine.family_ids().len();

		if family as usize >= loaded || (formats != NO_FAMILY && formats as usize >= loaded) {
			return fail(state, code::ARGUMENT, "no family has that handle");
		}

		let Ok(text) = std::str::from_utf8(bytes) else {
			return fail(state, code::NOT_UTF8, "the text is not UTF-8");
		};

		if let Err(error) = state.engine.structure(family as usize, text, &mut state.structure) {
			return fail(state, search_code(&error), error.to_string());
		}

		if formats != NO_FAMILY {
			if let Err(error) = state
				.engine
				.known_formats(formats as usize, text, &state.structure, &mut state.known)
			{
				return fail(state, search_code(&error), error.to_string());
			}
		}

		let structure = &state.structure;
		let records = &mut state.records;

		records.clear();
		records.push(structure.tokens.len() as u32);
		records.push(structure.segments.len() as u32);
		records.push(structure.regions.len() as u32);
		records.extend_from_slice(&structure.scripts);

		for token in &structure.tokens {
			records.extend_from_slice(&[
				token.start,
				token.end,
				u32::from(token.class as u8) | u32::from(token.script as u8) << 8,
			]);
		}

		for segment in &structure.segments {
			records.extend_from_slice(&[segment.start, segment.end, u32::from(segment.separator as u8)]);
		}

		records.extend_from_slice(&structure.regions);

		if formats != NO_FAMILY {
			records.push(state.known.hits.len() as u32);

			for hit in &state.known.hits {
				records.extend_from_slice(&[u32::from(hit.kind as u8), hit.shape, hit.start, hit.end]);
			}
		}

		i32::try_from(records.len()).unwrap_or(-1)
	})
}

/// The status word of a prefix record.
fn prefix_word(status: PrefixStatus) -> u32 {
	match status {
		PrefixStatus::Dead => 0,
		PrefixStatus::Viable => 1,
		PrefixStatus::Accepted => 2,
		PrefixStatus::AcceptedAndExtendable => 3,
		PrefixStatus::Unknown => 4,
	}
}

/// Answers prefix continuation for the UTF-8 text at `ptr`, for every shape of the families whose handle bit is set in
/// `mask`, and returns the number of records written at `rcg_result_ptr`, or -1. The layout is in the module
/// documentation. The call overwrites the records `rcg_recognize` wrote.
///
/// # Safety
/// `ptr` must address `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn rcg_prefix(ptr: *const u8, len: usize, mask: u32) -> i32 {
	let bytes = std::slice::from_raw_parts(ptr, len);

	STATE.with(|state| {
		let mut state = state.borrow_mut();
		let state = &mut *state;
		let loaded = state.engine.family_ids().len();

		if loaded < MAX_FAMILIES && mask >> loaded != 0 {
			return fail(state, code::ARGUMENT, "the mask names a family that is not loaded");
		}

		let Ok(text) = std::str::from_utf8(bytes) else {
			return fail(state, code::NOT_UTF8, "the text is not UTF-8");
		};

		let statuses = match state.engine.prefix_status(text) {
			Ok(statuses) => statuses,
			Err(error) => return fail(state, search_code(&error), error.to_string()),
		};

		let ids = state.engine.family_ids();
		let mut words = Vec::with_capacity(statuses.len() * PREFIX_WORDS);
		let mut last = (usize::MAX, 0usize);
		let mut missing = false;

		for entry in &statuses {
			let Some(family) = ids.iter().position(|id| *id == entry.family) else {
				continue;
			};

			if mask & (1 << family) == 0 {
				continue;
			}

			// The engine lists a family's shapes in the byte order of the shape table, so the search resumes where the
			// previous shape of the family was found.
			let table = state.engine.shapes(family);
			let from = if last.0 == family { last.1 } else { 0 };

			let Some(shape) = table[from..]
				.iter()
				.position(|id| id.as_str() == entry.shape)
				.map(|offset| from + offset)
				.or_else(|| table.iter().position(|id| id.as_str() == entry.shape))
			else {
				missing = true;

				break;
			};

			last = (family, shape + 1);

			words.extend_from_slice(&[family as u32, shape as u32, prefix_word(entry.status)]);
		}

		if missing {
			return fail(state, code::ARGUMENT, "the engine reported a shape its table lacks");
		}

		state.records = words;

		i32::try_from(state.records.len() / PREFIX_WORDS).unwrap_or(-1)
	})
}

/// Traces the UTF-8 text at `ptr` over the families whose handle bit is set in `mask`, and returns the byte length of
/// the JSON text it wrote at `rcg_json_ptr`, or -1.
///
/// The text is a JSON array of traces: one per recognition, in the order `rcg_recognize` returns them, then one per
/// shape named in the `explain_len` bytes at `explain_ptr`, which are shape IDs joined by newlines. Every span is a
/// UTF-8 byte offset. The call overwrites the JSON `rcg_recognize` wrote, so a caller reads that first. A call that
/// never reaches this export builds no trace.
///
/// # Safety
/// `ptr` must address `len` readable bytes and `explain_ptr` must address `explain_len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn rcg_trace(
	ptr: *const u8,
	len: usize,
	mask: u32,
	explain_ptr: *const u8,
	explain_len: usize,
) -> i32 {
	let bytes = std::slice::from_raw_parts(ptr, len);
	let explain = if explain_len == 0 {
		&[][..]
	} else {
		std::slice::from_raw_parts(explain_ptr, explain_len)
	};

	STATE.with(|state| {
		let mut state = state.borrow_mut();
		let state = &mut *state;
		let loaded = state.engine.family_ids().len();

		if loaded < MAX_FAMILIES && mask >> loaded != 0 {
			return fail(state, code::ARGUMENT, "the mask names a family that is not loaded");
		}

		let (Ok(text), Ok(explain)) = (std::str::from_utf8(bytes), std::str::from_utf8(explain)) else {
			return fail(state, code::NOT_UTF8, "the text or the shape list is not UTF-8");
		};

		let shapes: Vec<&str> = explain.split('\n').filter(|shape| !shape.is_empty()).collect();
		let traces = match state.engine.trace(text, |index| mask & (1 << index) != 0, &shapes) {
			Ok(traces) => traces,
			Err(error) => return fail(state, search_code(&error), error.to_string()),
		};

		state.json.clear();

		if let Err(error) = serde_json::to_writer(&mut state.json, &traces) {
			return fail(state, code::SEARCH, error.to_string());
		}

		match i32::try_from(state.json.len()) {
			Ok(length) => length,
			Err(_) => fail(state, code::SEARCH, "the trace is too large"),
		}
	})
}

/// The address of the last call's result records, valid until the next `rcg_recognize`.
#[no_mangle]
pub extern "C" fn rcg_result_ptr() -> *const u32 {
	STATE.with(|state| state.borrow().records.as_ptr())
}

/// The address of the last call's JSON text, or of the shape table `rcg_shapes` wrote, valid until the next call of
/// either.
#[no_mangle]
pub extern "C" fn rcg_json_ptr() -> *const u8 {
	STATE.with(|state| state.borrow().json.as_ptr())
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

	/// One decoded result record: family handle, shape ID, span, status, and the JSON it points to.
	struct Decoded {
		family: u32,
		shape: String,
		start: u32,
		end: u32,
		status: u32,
		json: Option<serde_json::Value>,
	}

	fn shape_table(family: u32) -> Vec<String> {
		let length = rcg_shapes(family);

		assert!(length >= 0, "{}", message());

		STATE.with(|state| {
			String::from_utf8(state.borrow().json.clone())
				.unwrap()
				.split('\n')
				.map(str::to_string)
				.collect()
		})
	}

	fn recognize(text: &str, mask: u32) -> Vec<Decoded> {
		let count = unsafe { rcg_recognize(text.as_ptr(), text.len(), mask) };

		assert!(count >= 0, "{}", message());

		let (records, json) = STATE.with(|state| {
			let state = state.borrow();

			(state.records.clone(), state.json.clone())
		});

		assert_eq!(records.len(), count as usize * RECORD_WORDS);

		let tables: Vec<Vec<String>> = (0..2).map(shape_table).collect();

		// `shape_table` overwrote the JSON, so the records' JSON is read from the copy taken first.
		records
			.chunks(RECORD_WORDS)
			.map(|record| Decoded {
				family: record[0],
				shape: tables[record[0] as usize][record[1] as usize].clone(),
				start: record[2],
				end: record[3],
				status: record[4],
				json: (record[6] > 0).then(|| {
					serde_json::from_slice(&json[record[5] as usize..(record[5] + record[6]) as usize]).unwrap()
				}),
			})
			.collect()
	}

	// One instance per test thread: `cargo test` runs each test on its own thread, and the state is thread-local.
	#[test]
	fn a_loaded_family_recognizes_text_and_reports_its_payload() {
		assert_eq!(rcg_abi_version(), ABI_VERSION);
		assert_eq!(load("primitives", hash("primitives")), 0);
		assert_eq!(load("coordinates", hash("coordinates")), 1);

		let all = recognize("40.5, -74", 0b11);
		let pair = all
			.iter()
			.find(|recognition| recognition.shape == "coordinate.decimal_pair")
			.unwrap();

		assert_eq!(pair.family, 1);
		assert_eq!(pair.status, status::VALIDATED);
		assert_eq!(pair.json.as_ref().unwrap()["latitude"], 40.5);
		assert_eq!((pair.start, pair.end), (0, 9));

		// A mask that leaves the coordinates family out leaves its shapes out.
		let primitives_only = recognize("40.5, -74", 0b01);

		assert!(primitives_only.iter().all(|recognition| recognition.family == 0));
		assert!(primitives_only[0].status == status::UNVALIDATED);
		assert!(primitives_only[0].json.is_none());
	}

	#[test]
	fn a_trace_call_writes_one_trace_per_recognition_and_the_explained_shapes() {
		assert_eq!(load("primitives", hash("primitives")), 0);
		assert_eq!(load("coordinates", hash("coordinates")), 1);

		let text = "100, 200";
		let explain = "coordinate.geo_uri";
		let length = unsafe { rcg_trace(text.as_ptr(), text.len(), 0b10, explain.as_ptr(), explain.len()) };

		assert!(length > 0, "{}", message());

		let traces: serde_json::Value = STATE.with(|state| {
			let state = state.borrow();

			serde_json::from_slice(&state.json[..length as usize]).unwrap()
		});
		let traces = traces.as_array().unwrap();

		assert_eq!(traces.len(), 2);
		assert_eq!(traces[0]["shape"], "coordinate.decimal_pair");
		assert_eq!(traces[0]["result"], "rejected");
		assert_eq!(
			traces[0]["steps"].as_array().unwrap().last().unwrap()["rejection"]["code"],
			"latitude_out_of_range"
		);
		assert_eq!(traces[1]["shape"], "coordinate.geo_uri");
		assert_eq!(traces[1]["result"], "no_match");
		assert_eq!(traces[1]["steps"][0]["outcome"], "fail");

		// A mask naming a family that is not loaded is an error and not a trap.
		assert_eq!(
			unsafe { rcg_trace(text.as_ptr(), text.len(), 0b100, explain.as_ptr(), 0) },
			-1
		);
		assert_eq!(rcg_error_code(), code::ARGUMENT);
	}

	#[test]
	fn a_prefix_call_writes_one_record_for_each_shape_of_the_masked_families() {
		assert_eq!(load("primitives", hash("primitives")), 0);
		assert_eq!(load("coordinates", hash("coordinates")), 1);

		let coordinates = shape_table(1);
		let position = coordinates
			.iter()
			.position(|shape| shape == "coordinate.decimal_pair")
			.unwrap() as u32;

		let statuses = |text: &str, mask: u32| -> Vec<[u32; 3]> {
			let count = unsafe { rcg_prefix(text.as_ptr(), text.len(), mask) };

			assert!(count >= 0, "{}", message());

			STATE.with(|state| {
				let state = state.borrow();

				assert_eq!(state.records.len(), count as usize * PREFIX_WORDS);

				state
					.records
					.chunks(PREFIX_WORDS)
					.map(|word| [word[0], word[1], word[2]])
					.collect()
			})
		};

		let whole = statuses("40.5, -74", 0b10);

		assert_eq!(whole.len(), coordinates.len());
		assert!(whole.iter().all(|record| record[0] == 1));
		assert!(matches!(
			whole.iter().find(|record| record[1] == position).unwrap()[2],
			2 | 3
		));

		let partial = statuses("40.5,", 0b10);

		assert_eq!(partial.iter().find(|record| record[1] == position).unwrap()[2], 1);

		let dead = statuses("zzz", 0b10);

		assert_eq!(dead.iter().find(|record| record[1] == position).unwrap()[2], 0);

		// A mask that leaves a family out leaves its shapes out, and a mask naming no loaded family is refused.
		assert!(statuses("40.5,", 0b01).iter().all(|record| record[0] == 0));
		assert_eq!(unsafe { rcg_prefix("1".as_ptr(), 1, 0b100) }, -1);
		assert_eq!(rcg_error_code(), code::ARGUMENT);
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

		let long = "1".repeat(70_000);

		assert_eq!(unsafe { rcg_recognize(long.as_ptr(), long.len(), 1) }, -1);
		assert_eq!(rcg_error_code(), code::INPUT_TOO_LONG);
		assert!(message().contains("70000"), "{}", message());

		assert_eq!(rcg_shapes(7), -1);
		assert_eq!(rcg_error_code(), code::ARGUMENT);
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
