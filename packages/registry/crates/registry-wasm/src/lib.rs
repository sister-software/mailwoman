// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The WebAssembly boundary for `@mailwoman/registry`.
//!
//! The exports form a C ABI that `packages/registry/lib/wasm.ts` calls directly. The caller stages
//! artifact bytes in linear memory with `rgy_alloc`, registers them with `rgy_load` and receives a
//! handle; a batch call then takes handles, a packed input span and a caller-owned output span, and
//! processes the whole batch in one boundary crossing. No call allocates after `rgy_load`.
//!
//! Every fallible export returns a negative value, and `rgy_error` reads the last error's code.
//! The module is built twice, once with `simd128` and once without; `rgy_simd` reports which.

use registry_core::{lookup, Artifact, Bitset, Error};
use std::cell::RefCell;

/// The most artifacts one instance registers. Three serve the collision batch; the rest are headroom.
const MAX_HANDLES: usize = 8;

struct Loaded {
	ptr: *const u8,
	len: usize,
}

thread_local! {
	static HANDLES: RefCell<Vec<Loaded>> = const { RefCell::new(Vec::new()) };
	static LAST_ERROR: RefCell<i32> = const { RefCell::new(0) };
}

/// Error codes `rgy_error` answers, stable across builds.
fn code_of(error: Error) -> i32 {
	match error {
		Error::Truncated => 1,
		Error::Magic => 2,
		Error::Version(_) => 3,
		Error::Flags(_) => 4,
		Error::Reserved => 5,
		Error::Length => 6,
		Error::HeaderUTF8 => 7,
		Error::Layout => 8,
		Error::SectionBounds(_) => 9,
		Error::UnknownRequiredKind(_) => 10,
		Error::Encoding(_, _) => 11,
		Error::ElementWidth(_) => 12,
		Error::Count(_) => 13,
		Error::KeySpace(_) => 14,
		Error::Offsets => 15,
		Error::StringUTF8 => 16,
		Error::MissingSection(_) => 17,
		Error::Capacity => 18,
		Error::Overlap => 19,
	}
}

/// The error code for a handle that was never issued.
const BAD_HANDLE: i32 = 20;
/// The error code for more loads than `MAX_HANDLES`.
const TOO_MANY: i32 = 21;

fn fail(code: i32) -> i32 {
	LAST_ERROR.with(|error| *error.borrow_mut() = code);
	-1
}

/// Allocations hold bytes read as `u32` and `f64`, so every one is 8-byte aligned.
const ALIGN: usize = 8;

fn layout(len: usize) -> std::alloc::Layout {
	std::alloc::Layout::from_size_align(len.max(1), ALIGN).expect("a length that fits a layout")
}

/// Allocates `len` bytes the caller fills and later frees with `rgy_dealloc` and the same length.
#[no_mangle]
pub extern "C" fn rgy_alloc(len: usize) -> *mut u8 {
	// SAFETY: the layout has a non-zero size.
	unsafe { std::alloc::alloc(layout(len)) }
}

/// Frees memory from `rgy_alloc`.
///
/// # Safety
/// `ptr` and `len` must come from one `rgy_alloc` call that has not been freed, and no loaded
/// artifact may still point into it.
#[no_mangle]
pub unsafe extern "C" fn rgy_dealloc(ptr: *mut u8, len: usize) {
	std::alloc::dealloc(ptr, layout(len));
}

/// The last error's code, or 0.
#[no_mangle]
pub extern "C" fn rgy_error() -> i32 {
	LAST_ERROR.with(|error| *error.borrow())
}

/// Whether this build carries the `simd128` kernels.
#[no_mangle]
pub extern "C" fn rgy_simd() -> i32 {
	cfg!(target_feature = "simd128") as i32
}

/// Validates an artifact staged at `ptr` and returns its handle, or -1.
///
/// The bytes stay where they are: the handle borrows them, so the caller keeps the allocation alive
/// for as long as the handle is used.
///
/// # Safety
/// `ptr` must address `len` readable bytes that stay valid and unchanged until the instance is dropped.
#[no_mangle]
pub unsafe extern "C" fn rgy_load(ptr: *const u8, len: usize) -> i32 {
	let bytes = std::slice::from_raw_parts(ptr, len);

	if let Err(error) = Artifact::parse(bytes) {
		return fail(code_of(error));
	}

	HANDLES.with(|handles| {
		let mut handles = handles.borrow_mut();

		if handles.len() >= MAX_HANDLES {
			return fail(TOO_MANY);
		}

		handles.push(Loaded { ptr, len });
		handles.len() as i32 - 1
	})
}

fn with_bitsets<R>(handles_in: &[i32], run: impl FnOnce(&[Bitset]) -> Result<R, Error>) -> Result<R, i32> {
	HANDLES.with(|handles| {
		let handles = handles.borrow();
		let mut artifacts = Vec::with_capacity(handles_in.len());

		for handle in handles_in {
			let loaded = usize::try_from(*handle)
				.ok()
				.and_then(|index| handles.get(index))
				.ok_or(BAD_HANDLE)?;
			// SAFETY: `rgy_load` validated these bytes and the caller keeps them alive.
			let bytes = unsafe { std::slice::from_raw_parts(loaded.ptr, loaded.len) };
			let artifact = Artifact::parse(bytes).map_err(code_of)?;

			artifacts.push(Bitset::from_artifact(&artifact).map_err(code_of)?);
		}

		run(&artifacts).map_err(code_of)
	})
}

/// Classifies `count` packed three-letter codes against the alpha-3, airport and collision bitsets.
///
/// `input` holds `count * 3` bytes; `output` receives `count` masks (`lookup::mask`). Returns the
/// count written, or -1.
///
/// # Safety
/// The spans must be readable and writable for their lengths and must not overlap.
#[no_mangle]
pub unsafe extern "C" fn rgy_classify_many(
	country: i32,
	airport: i32,
	collision: i32,
	input: *const u8,
	count: usize,
	output: *mut u8,
) -> i32 {
	let packed = std::slice::from_raw_parts(input, count.saturating_mul(3));
	let out = std::slice::from_raw_parts_mut(output, count);

	match with_bitsets(&[country, airport, collision], |sets| {
		lookup::classify_many(&sets[0], &sets[1], &sets[2], packed, count, out)
	}) {
		Ok(written) => written as i32,
		Err(code) => fail(code),
	}
}

/// Tests `count` packed codes against one bitset, writing 1, 0 or `mask::INVALID` each.
///
/// # Safety
/// As for `rgy_classify_many`; the input span holds `count` codes of the bitset's arity (three bytes
/// for a numeric key).
#[no_mangle]
pub unsafe extern "C" fn rgy_test_many(handle: i32, input: *const u8, count: usize, output: *mut u8) -> i32 {
	let out = std::slice::from_raw_parts_mut(output, count);

	match with_bitsets(&[handle], |sets| {
		let arity = sets[0].arity();
		let width = if arity == 0 { 3 } else { arity as usize };
		let packed = std::slice::from_raw_parts(input, count.saturating_mul(width));

		lookup::test_many(&sets[0], packed, count, out)
	}) {
		Ok(written) => written as i32,
		Err(code) => fail(code),
	}
}
