// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from Planetiler 0.10.2's util/SortKey (Apache-2.0, Copyright Michael Barry).

//! Packing several ordered criteria into one feature sort key, as Planetiler's `SortKey` does.
//!
//! Each criterion is quantized into a number of levels, and the key is the mixed-radix number of those levels, offset
//! to start at the lowest sort key. A criterion whose range runs high to low orders descending.

use hrt_sort::key::{SORT_KEY_MAX, SORT_KEY_MIN};

const MAX: i64 = SORT_KEY_MAX as i64 - SORT_KEY_MIN as i64;

/// A sort key being built from criteria in priority order.
#[derive(Clone, Copy, Debug)]
pub struct SortKey {
	possible_values: i64,
	result: i32,
}

fn double_range_to_int(value: f64, min: f64, max: f64, levels: i32) -> i32 {
	(levels - 1).min((((value - min) / (max - min)) * f64::from(levels)).floor() as i32)
}

impl SortKey {
	pub fn order_by_int(value: i32, start: i32, end: i32) -> Self {
		SortKey {
			possible_values: 1,
			result: 0,
		}
		.then_by_int(value, start, end)
	}

	/// Orders by an integer from `start` to `end`, clamped; with `start > end` larger values come first.
	pub fn then_by_int(self, value: i32, start: i32, end: i32) -> Self {
		if start > end {
			return self.then_by_int(start - value, end, start);
		}
		self.accumulate(value.clamp(start, end), start, end + 1 - start)
	}

	/// Orders by the logarithm of `value` from `start` to `end` in `levels` steps; with `start > end` larger values
	/// come first.
	pub fn then_by_log(self, value: f64, start: f64, end: f64, levels: i32) -> Self {
		if start > end {
			return self.then_by_log(start / value, end, start, levels);
		}
		let value = value.clamp(start, end);
		let level = double_range_to_int(value.ln(), start.ln(), end.ln(), levels);
		self.accumulate(level, 0, levels)
	}

	fn accumulate(mut self, value: i32, min: i32, levels: i32) -> Self {
		self.possible_values *= i64::from(levels);
		assert!(
			self.possible_values <= MAX,
			"too many possible sort key values: {}",
			self.possible_values
		);
		self.result = self.result * levels + value - min;
		self
	}

	pub fn get(self) -> i32 {
		self.result + SORT_KEY_MIN
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn criteria_pack_in_priority_order() {
		let key = |first, second| SortKey::order_by_int(first, 0, 9).then_by_int(second, 0, 9).get();
		assert!(key(1, 9) < key(2, 0));
		assert!(key(2, 0) < key(2, 1));
		assert_eq!(key(0, 0), SORT_KEY_MIN);
		// A descending range puts larger values first.
		let descending = |value| SortKey::order_by_int(value, 10, 0).get();
		assert!(descending(9) < descending(1));
		// Larger populations come first on a descending log scale.
		let population = |value: f64| {
			SortKey::order_by_int(0, 0, 1)
				.then_by_log(value, 40_000_000.0, 1.0, 65)
				.get()
		};
		assert!(population(5_000_000.0) < population(5_000.0));
	}
}
