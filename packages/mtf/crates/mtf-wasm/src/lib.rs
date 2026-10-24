// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The WebAssembly boundary for `@mailwoman/mtf`.
//!
//! The exports form a C ABI that `packages/mtf/lib/index.ts` calls directly. A loaded model is an
//! opaque handle that owns its output buffers. An encode or decode overwrites the previous result
//! for that handle, so the caller copies a result out before its next call on the same model.
//!
//! Every fallible export returns a negative value or a null handle on failure and leaves the message
//! where `mtf_error_ptr` and `mtf_error_len` read it.

use mtf_core::Processor;
use std::cell::RefCell;

/// Words per encoded piece in the `u32` output buffer: id, begin, end, piece offset, piece length.
const PIECE_WORDS: usize = 5;

/// A loaded model and its reusable output buffers, opaque to the caller.
pub struct Handle {
	processor: Processor,
	words: Vec<u32>,
	bytes: Vec<u8>,
}

thread_local! {
	static LAST_ERROR: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn set_error(message: String) {
	LAST_ERROR.with(|e| *e.borrow_mut() = message.into_bytes());
}

/// Input buffers hold `u32` IDs as well as bytes, so every allocation is 8-byte aligned.
const INPUT_ALIGN: usize = 8;

fn input_layout(len: usize) -> std::alloc::Layout {
	std::alloc::Layout::from_size_align(len.max(1), INPUT_ALIGN).expect("input length fits a layout")
}

/// Allocates `len` bytes the caller fills and later passes to `mtf_dealloc` with the same length.
#[no_mangle]
pub extern "C" fn mtf_alloc(len: usize) -> *mut u8 {
	// SAFETY: the layout has a non-zero size.
	unsafe { std::alloc::alloc(input_layout(len)) }
}

/// Frees memory from `mtf_alloc`.
///
/// # Safety
/// `ptr` and `len` must come from one `mtf_alloc` call that has not been freed.
#[no_mangle]
pub unsafe extern "C" fn mtf_dealloc(ptr: *mut u8, len: usize) {
	std::alloc::dealloc(ptr, input_layout(len));
}

#[no_mangle]
pub extern "C" fn mtf_error_ptr() -> *const u8 {
	LAST_ERROR.with(|e| e.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn mtf_error_len() -> usize {
	LAST_ERROR.with(|e| e.borrow().len())
}

/// Loads a serialized SentencePiece model, returning a handle or null.
///
/// # Safety
/// `ptr..ptr + len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn mtf_model_load(ptr: *const u8, len: usize) -> *mut Handle {
	let bytes = std::slice::from_raw_parts(ptr, len);
	match Processor::from_model_proto(bytes) {
		Ok(processor) => Box::into_raw(Box::new(Handle {
			processor,
			words: Vec::new(),
			bytes: Vec::new(),
		})),
		Err(e) => {
			set_error(e.to_string());
			std::ptr::null_mut()
		}
	}
}

/// Frees a model handle.
///
/// # Safety
/// `handle` must come from `mtf_model_load` and must not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn mtf_model_free(handle: *mut Handle) {
	if !handle.is_null() {
		drop(Box::from_raw(handle));
	}
}

/// # Safety
/// `handle` must be a live handle from `mtf_model_load`.
#[no_mangle]
pub unsafe extern "C" fn mtf_vocab_size(handle: *const Handle) -> usize {
	(*handle).processor.vocab_size()
}

/// Encodes UTF-8 text, returning the piece count or -1.
///
/// Piece `i` occupies words `5i..5i + 5` of `mtf_words_ptr`: id, begin, end, and the offset and
/// length of its UTF-8 text in `mtf_bytes_ptr`.
///
/// # Safety
/// `handle` must be live and `ptr..ptr + len` must hold valid UTF-8.
#[no_mangle]
pub unsafe extern "C" fn mtf_encode(handle: *mut Handle, ptr: *const u8, len: usize) -> i32 {
	let handle = &mut *handle;
	let Ok(text) = std::str::from_utf8(std::slice::from_raw_parts(ptr, len)) else {
		set_error("encode input is not UTF-8".into());
		return -1;
	};
	match handle.processor.encode(text) {
		Ok(pieces) => {
			handle.words.clear();
			handle.bytes.clear();
			handle.words.reserve(pieces.len() * PIECE_WORDS);
			for p in &pieces {
				handle.words.extend_from_slice(&[
					p.id,
					p.begin as u32,
					p.end as u32,
					handle.bytes.len() as u32,
					p.piece.len() as u32,
				]);
				handle.bytes.extend_from_slice(p.piece.as_bytes());
			}
			pieces.len() as i32
		}
		Err(e) => {
			set_error(e.to_string());
			-1
		}
	}
}

/// Decodes `count` IDs into UTF-8 text in `mtf_bytes_ptr`, returning its length or -1.
///
/// # Safety
/// `handle` must be live and `ids..ids + count` must be readable `u32`s.
#[no_mangle]
pub unsafe extern "C" fn mtf_decode(handle: *mut Handle, ids: *const u32, count: usize) -> i32 {
	let handle = &mut *handle;
	let ids = if count == 0 {
		&[][..]
	} else {
		std::slice::from_raw_parts(ids, count)
	};
	match handle.processor.decode(ids) {
		Ok(text) => {
			handle.bytes.clear();
			handle.bytes.extend_from_slice(text.as_bytes());
			handle.bytes.len() as i32
		}
		Err(e) => {
			set_error(e.to_string());
			-1
		}
	}
}

/// # Safety
/// `handle` must be live.
#[no_mangle]
pub unsafe extern "C" fn mtf_words_ptr(handle: *const Handle) -> *const u32 {
	(*handle).words.as_ptr()
}

/// # Safety
/// `handle` must be live.
#[no_mangle]
pub unsafe extern "C" fn mtf_bytes_ptr(handle: *const Handle) -> *const u8 {
	(*handle).bytes.as_ptr()
}
