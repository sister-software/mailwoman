// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! CPython 3.12's `random.Random`, for the methods the training sampler and the corpus builders draw.
//!
//! The generator is MT19937 seeded the way CPython seeds it: an integer seed's absolute value becomes the key's
//! 32-bit words, least significant first, and a string seed is first replaced by the integer whose big-endian bytes
//! are the string's UTF-8 followed by their SHA-512 digest (CPython's `version=2` seeding). Every method draws its
//! words in CPython's order, including the rejection loop of `_randbelow`, so equal seeds give equal draws.
//!
//! Only these methods are implemented: `random`, `getrandbits` (up to 128 bits), `randrange`, `randint`, `choice`,
//! `choices`, `shuffle` and `sample` (without `counts`). Populations are passed by size and indices are returned.

use sha2::{Digest, Sha512};

const N: usize = 624;
const M: usize = 397;
const MATRIX_A: u32 = 0x9908_b0df;
const UPPER_MASK: u32 = 0x8000_0000;
const LOWER_MASK: u32 = 0x7fff_ffff;

/// A seed CPython accepts: an integer of any sign, or a string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Seed<'a> {
	Int(i128),
	Str(&'a str),
}

/// A CPython-compatible Mersenne Twister.
#[derive(Clone)]
pub struct PyRandom {
	mt: [u32; N],
	index: usize,
}

/// A request CPython would refuse with `ValueError` or `IndexError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrawError(pub String);

impl std::fmt::Display for DrawError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(&self.0)
	}
}

impl std::error::Error for DrawError {}

/// The 32-bit words of a non-negative integer given as big-endian bytes, least significant first; `[0]` for zero.
fn key_words(big_endian: &[u8]) -> Vec<u32> {
	let trimmed: &[u8] = {
		let first = big_endian.iter().position(|&b| b != 0).unwrap_or(big_endian.len());
		&big_endian[first..]
	};
	if trimmed.is_empty() {
		return vec![0];
	}
	trimmed
		.rchunks(4)
		.map(|chunk| chunk.iter().fold(0u32, |word, &b| (word << 8) | u32::from(b)))
		.collect()
}

impl PyRandom {
	/// A generator seeded as `random.Random(seed)` seeds it.
	pub fn new(seed: Seed<'_>) -> Self {
		let key = match seed {
			Seed::Int(n) => key_words(&n.unsigned_abs().to_be_bytes()),
			Seed::Str(s) => {
				let mut bytes = s.as_bytes().to_vec();
				let digest = Sha512::digest(&bytes);
				bytes.extend_from_slice(&digest);
				key_words(&bytes)
			}
		};
		let mut rng = Self { mt: [0; N], index: N };
		rng.init_by_array(&key);
		rng
	}

	fn init_genrand(&mut self, seed: u32) {
		self.mt[0] = seed;
		for i in 1..N {
			let previous = self.mt[i - 1];
			self.mt[i] = 1_812_433_253u32
				.wrapping_mul(previous ^ (previous >> 30))
				.wrapping_add(i as u32);
		}
		self.index = N;
	}

	fn init_by_array(&mut self, key: &[u32]) {
		self.init_genrand(19_650_218);
		let (mut i, mut j) = (1usize, 0usize);
		for _ in 0..N.max(key.len()) {
			let previous = self.mt[i - 1];
			self.mt[i] = (self.mt[i] ^ (previous ^ (previous >> 30)).wrapping_mul(1_664_525))
				.wrapping_add(key[j])
				.wrapping_add(j as u32);
			i += 1;
			j += 1;
			if i >= N {
				self.mt[0] = self.mt[N - 1];
				i = 1;
			}
			if j >= key.len() {
				j = 0;
			}
		}
		for _ in 0..N - 1 {
			let previous = self.mt[i - 1];
			self.mt[i] =
				(self.mt[i] ^ (previous ^ (previous >> 30)).wrapping_mul(1_566_083_941)).wrapping_sub(i as u32);
			i += 1;
			if i >= N {
				self.mt[0] = self.mt[N - 1];
				i = 1;
			}
		}
		self.mt[0] = 0x8000_0000;
	}

	fn twist(&mut self) {
		for k in 0..N {
			let y = (self.mt[k] & UPPER_MASK) | (self.mt[(k + 1) % N] & LOWER_MASK);
			let mag = if y & 1 == 1 { MATRIX_A } else { 0 };
			self.mt[k] = self.mt[(k + M) % N] ^ (y >> 1) ^ mag;
		}
		self.index = 0;
	}

	/// The next 32-bit output, `genrand_uint32`.
	pub fn next_u32(&mut self) -> u32 {
		if self.index >= N {
			self.twist();
		}
		let mut y = self.mt[self.index];
		self.index += 1;
		y ^= y >> 11;
		y ^= (y << 7) & 0x9d2c_5680;
		y ^= (y << 15) & 0xefc6_0000;
		y ^ (y >> 18)
	}

	/// `random()`: a float in [0, 1) with 53 random bits.
	pub fn random(&mut self) -> f64 {
		let a = f64::from(self.next_u32() >> 5);
		let b = f64::from(self.next_u32() >> 6);
		(a * 67_108_864.0 + b) * (1.0 / 9_007_199_254_740_992.0)
	}

	/// `getrandbits(k)` for `k <= 128`.
	pub fn getrandbits(&mut self, k: u32) -> u128 {
		assert!(k <= 128, "getrandbits supports at most 128 bits");
		if k == 0 {
			return 0;
		}
		if k <= 32 {
			return u128::from(self.next_u32() >> (32 - k));
		}
		let mut value = 0u128;
		let mut remaining = k;
		let mut shift = 0;
		while remaining > 0 {
			let mut word = self.next_u32();
			if remaining < 32 {
				word >>= 32 - remaining;
			}
			value |= u128::from(word) << shift;
			shift += 32;
			remaining = remaining.saturating_sub(32);
		}
		value
	}

	/// `_randbelow(n)`: a uniform integer in [0, n), drawn by rejection from `n.bit_length()` bits.
	pub fn randbelow(&mut self, n: u128) -> u128 {
		assert!(n > 0, "randbelow needs a positive bound");
		let k = 128 - n.leading_zeros();
		let mut r = self.getrandbits(k);
		while r >= n {
			r = self.getrandbits(k);
		}
		r
	}

	/// `randrange(start, stop)` with step 1.
	pub fn randrange(&mut self, start: i128, stop: i128) -> Result<i128, DrawError> {
		if stop <= start {
			return Err(DrawError(format!("empty range in randrange({start}, {stop})")));
		}
		Ok(start + self.randbelow((stop - start) as u128) as i128)
	}

	/// `randrange(stop)`.
	pub fn randrange_below(&mut self, stop: i128) -> Result<i128, DrawError> {
		if stop <= 0 {
			return Err(DrawError(format!("empty range in randrange({stop})")));
		}
		Ok(self.randbelow(stop as u128) as i128)
	}

	/// `randint(a, b)`, both ends included.
	pub fn randint(&mut self, a: i128, b: i128) -> Result<i128, DrawError> {
		self.randrange(a, b + 1)
	}

	/// The index `choice` picks from a sequence of length `len`.
	pub fn choice_index(&mut self, len: usize) -> Result<usize, DrawError> {
		if len == 0 {
			return Err(DrawError("cannot choose from an empty sequence".to_owned()));
		}
		Ok(self.randbelow(len as u128) as usize)
	}

	/// `shuffle(items)` in place.
	pub fn shuffle<T>(&mut self, items: &mut [T]) {
		for i in (1..items.len()).rev() {
			let j = self.randbelow((i + 1) as u128) as usize;
			items.swap(i, j);
		}
	}

	/// The indices `sample(population, k)` picks from a population of size `n`, in pick order.
	pub fn sample_indices(&mut self, n: usize, k: usize) -> Result<Vec<usize>, DrawError> {
		if k > n {
			return Err(DrawError("sample larger than population or is negative".to_owned()));
		}
		let mut setsize = 21usize;
		if k > 5 {
			// `4 ** ceil(log(k * 3, 4))`, computed as CPython computes `math.log(x, 4)`.
			let exponent = ((k as f64 * 3.0).ln() / 4f64.ln()).ceil() as u32;
			setsize += 4usize.pow(exponent);
		}
		let mut result = Vec::with_capacity(k);
		if n <= setsize {
			let mut pool: Vec<usize> = (0..n).collect();
			for i in 0..k {
				let j = self.randbelow((n - i) as u128) as usize;
				result.push(pool[j]);
				pool[j] = pool[n - i - 1];
			}
		} else {
			let mut selected = std::collections::HashSet::with_capacity(k);
			for _ in 0..k {
				let mut j = self.randbelow(n as u128) as usize;
				while selected.contains(&j) {
					j = self.randbelow(n as u128) as usize;
				}
				selected.insert(j);
				result.push(j);
			}
		}
		Ok(result)
	}

	/// The indices `choices(population, k=k)` picks from a population of size `n` without weights.
	pub fn choices_uniform(&mut self, n: usize, k: usize) -> Vec<usize> {
		let size = n as f64;
		(0..k).map(|_| (self.random() * size).floor() as usize).collect()
	}

	/// The indices `choices(population, cum_weights=cum_weights, k=k)` picks.
	///
	/// A caller passing `weights` accumulates them first, left to right, as `itertools.accumulate` does.
	pub fn choices_cumulative(&mut self, cum_weights: &[f64], k: usize) -> Result<Vec<usize>, DrawError> {
		let total = *cum_weights
			.last()
			.ok_or_else(|| DrawError("choices needs a population".to_owned()))?;
		if total <= 0.0 {
			return Err(DrawError("total of weights must be greater than zero".to_owned()));
		}
		if !total.is_finite() {
			return Err(DrawError("total of weights must be finite".to_owned()));
		}
		let hi = cum_weights.len() - 1;
		Ok((0..k)
			.map(|_| {
				let x = self.random() * total;
				// `bisect_right(cum_weights, x, 0, hi)`.
				cum_weights[..hi].partition_point(|&w| w <= x)
			})
			.collect())
	}
}

/// Running sums of `weights`, left to right, as `itertools.accumulate` produces them.
pub fn accumulate(weights: &[f64]) -> Vec<f64> {
	weights
		.iter()
		.scan(0.0, |sum, &w| {
			*sum += w;
			Some(*sum)
		})
		.collect()
}
