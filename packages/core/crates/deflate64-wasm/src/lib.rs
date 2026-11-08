// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The WebAssembly boundary for `@mailwoman/core`'s Deflate64 inflater.
//!
//! The exports form a C ABI that `packages/core/lib/fs/deflate64.ts` calls directly. The caller
//! creates a decoder with `d64_new`, stages a compressed chunk in linear memory allocated by
//! `d64_alloc`, and calls `d64_inflate` with that chunk and a caller-owned output span. The call
//! decompresses until the output span is full, the chunk is spent, or the stream ends, and
//! `d64_consumed` and `d64_written` then read how far it got. The decoder holds the 128 KiB output
//! window of the `deflate64` crate and nothing that grows with the member, so a member of any size
//! streams through a fixed amount of memory.

use deflate64::InflaterManaged;

/// What `d64_inflate` answers.
pub mod status {
	/// The stream has not ended: pass more input, or call again to drain a full output span.
	pub const MORE: i32 = 0;
	/// The final block has been decoded and every byte it produced has been written.
	pub const DONE: i32 = 1;
	/// The compressed bytes are not a valid Deflate64 stream.
	pub const DATA_ERROR: i32 = -1;
}

/// One member's inflater and the counts of its last call.
pub struct Decoder {
	inflater: InflaterManaged,
	consumed: usize,
	written: usize,
}

impl Decoder {
	/// A decoder at the start of a Deflate64 stream.
	pub fn new() -> Box<Self> {
		Box::new(Self {
			inflater: InflaterManaged::new(),
			consumed: 0,
			written: 0,
		})
	}

	/// Inflates from `input` into `output` and answers a [`status`] code.
	///
	/// [`Decoder::consumed`] and [`Decoder::written`] report the counts of this call.
	pub fn inflate(&mut self, input: &[u8], output: &mut [u8]) -> i32 {
		let result = self.inflater.inflate(input, output);

		self.consumed = result.bytes_consumed;
		self.written = result.bytes_written;

		if result.data_error || self.inflater.errored() {
			status::DATA_ERROR
		} else if self.inflater.finished() {
			status::DONE
		} else {
			status::MORE
		}
	}

	/// The input bytes the last call consumed.
	pub fn consumed(&self) -> usize {
		self.consumed
	}

	/// The output bytes the last call wrote.
	pub fn written(&self) -> usize {
		self.written
	}
}

fn layout(len: usize) -> std::alloc::Layout {
	std::alloc::Layout::from_size_align(len.max(1), 8).expect("a length that fits a layout")
}

/// Allocates `len` bytes the caller fills and later frees with `d64_dealloc` and the same length.
#[no_mangle]
pub extern "C" fn d64_alloc(len: usize) -> *mut u8 {
	// SAFETY: the layout has a non-zero size.
	unsafe { std::alloc::alloc(layout(len)) }
}

/// Frees memory from `d64_alloc`.
///
/// # Safety
/// `ptr` and `len` must come from one `d64_alloc` call that has not been freed.
#[no_mangle]
pub unsafe extern "C" fn d64_dealloc(ptr: *mut u8, len: usize) {
	std::alloc::dealloc(ptr, layout(len));
}

/// Creates a decoder and returns its handle, which `d64_free` releases.
#[no_mangle]
pub extern "C" fn d64_new() -> *mut Decoder {
	Box::into_raw(Decoder::new())
}

/// Releases a decoder.
///
/// # Safety
/// `decoder` must come from `d64_new` and not have been freed.
#[no_mangle]
pub unsafe extern "C" fn d64_free(decoder: *mut Decoder) {
	drop(Box::from_raw(decoder));
}

/// Inflates `input_len` bytes at `input` into the `output_len` bytes at `output`.
///
/// Returns a [`status`] code.
///
/// # Safety
/// `decoder` must be a live handle from `d64_new`; `input` must address `input_len` readable bytes and
/// `output` must address `output_len` writable bytes, and the two spans must not overlap.
#[no_mangle]
pub unsafe extern "C" fn d64_inflate(
	decoder: *mut Decoder,
	input: *const u8,
	input_len: usize,
	output: *mut u8,
	output_len: usize,
) -> i32 {
	let decoder = &mut *decoder;
	let input = if input_len == 0 {
		&[]
	} else {
		std::slice::from_raw_parts(input, input_len)
	};
	let output = std::slice::from_raw_parts_mut(output, output_len);

	decoder.inflate(input, output)
}

/// The input bytes the last `d64_inflate` call consumed.
///
/// # Safety
/// `decoder` must be a live handle from `d64_new`.
#[no_mangle]
pub unsafe extern "C" fn d64_consumed(decoder: *const Decoder) -> usize {
	(*decoder).consumed()
}

/// The output bytes the last `d64_inflate` call wrote.
///
/// # Safety
/// `decoder` must be a live handle from `d64_new`.
#[no_mangle]
pub unsafe extern "C" fn d64_written(decoder: *const Decoder) -> usize {
	(*decoder).written()
}
