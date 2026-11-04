// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! A set of non-negative integers stored as sorted inclusive ranges, for the filled-tile rows of a polygon column.

/// A set of integers held as sorted, disjoint, non-adjacent inclusive ranges.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RangeSet {
	ranges: Vec<(i32, i32)>,
}

impl RangeSet {
	pub fn new() -> Self {
		RangeSet::default()
	}

	pub fn is_empty(&self) -> bool {
		self.ranges.is_empty()
	}

	pub fn contains(&self, value: i32) -> bool {
		match self.ranges.binary_search_by(|&(lo, _)| lo.cmp(&value)) {
			Ok(_) => true,
			Err(0) => false,
			Err(index) => self.ranges[index - 1].1 >= value,
		}
	}

	/// Iterates the members in ascending order.
	pub fn iter(&self) -> impl Iterator<Item = i32> + '_ {
		self.ranges.iter().flat_map(|&(lo, hi)| lo..=hi)
	}

	fn combine(&self, other: &RangeSet, keep: impl Fn(bool, bool) -> bool) -> RangeSet {
		// Sweep the range boundaries of both sets as half-open intervals and keep the stretches where `keep` holds.
		let mut points: Vec<i64> = Vec::with_capacity((self.ranges.len() + other.ranges.len()) * 2);
		for &(lo, hi) in self.ranges.iter().chain(&other.ranges) {
			points.push(i64::from(lo));
			points.push(i64::from(hi) + 1);
		}
		points.sort_unstable();
		points.dedup();
		let mut out: Vec<(i32, i32)> = Vec::new();
		for window in points.windows(2) {
			let (start, end) = (window[0], window[1]);
			let probe = start as i32;
			if keep(self.contains(probe), other.contains(probe)) {
				match out.last_mut() {
					Some(last) if i64::from(last.1) + 1 == start => last.1 = (end - 1) as i32,
					_ => out.push((start as i32, (end - 1) as i32)),
				}
			}
		}
		RangeSet { ranges: out }
	}

	/// Flips membership of every value from `start` to `end`, inclusive.
	pub fn xor_range(&mut self, start: i32, end: i32) {
		let other = RangeSet {
			ranges: vec![(start, end)],
		};
		*self = self.combine(&other, |a, b| a != b);
	}

	pub fn intersect(&self, other: &RangeSet) -> RangeSet {
		self.combine(other, |a, b| a && b)
	}

	pub fn add_all(&mut self, other: &RangeSet) {
		*self = self.combine(other, |a, b| a || b);
	}

	pub fn remove_all(&mut self, other: &RangeSet) {
		*self = self.combine(other, |a, b| a && !b);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn xor_toggles_and_intersect_keeps_overlap() {
		let mut left = RangeSet::new();
		left.xor_range(2, 9);
		left.xor_range(5, 6);
		assert_eq!(left.iter().collect::<Vec<_>>(), vec![2, 3, 4, 7, 8, 9]);
		let mut right = RangeSet::new();
		right.xor_range(4, 7);
		assert_eq!(left.intersect(&right).iter().collect::<Vec<_>>(), vec![4, 7]);
		left.remove_all(&right);
		assert_eq!(left.iter().collect::<Vec<_>>(), vec![2, 3, 8, 9]);
		left.add_all(&right);
		assert_eq!(left.iter().collect::<Vec<_>>(), (2..=9).collect::<Vec<_>>());
		assert!(left.contains(9) && !left.contains(10) && !left.contains(1));
	}
}
