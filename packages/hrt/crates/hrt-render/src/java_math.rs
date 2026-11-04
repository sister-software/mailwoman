// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Translated from fdlibm 5.3 (e_hypot.c, s_atan.c, e_atan2.c, e_exp.c, s_expm1.c, e_sinh.c), checked statement by
// statement against the Java translation Java's StrictMath runs, so the results match Java's bits.
//
// fdlibm: Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
// Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this software is freely granted, provided that this notice is
// preserved.

//! Java's `StrictMath` functions, bit for bit.
//!
//! Java's `Math.hypot`, `Math.sinh`, `Math.atan` and `Math.atan2` reach fdlibm, whose results differ from the platform
//! libm's in the last bit for a few percent of inputs. A Planetiler profile that feeds such a result into
//! geometry, as the road smoothing does, then places a point one unit of least precision away. When Douglas-Peucker
//! later compares two near-equal distances, that difference can change which vertex it keeps.
//!
//! The functions follow the Java source statement for statement. Rust never contracts `a * b + c` into a fused
//! multiply-add, so each expression rounds as Java's does.

// The constants keep fdlibm's own decimal spellings, which round to the doubles fdlibm uses.
#![allow(clippy::excessive_precision, clippy::approx_constant)]

const HUGE: f64 = 1.0e300;
const EXP_BITS: i32 = 0x7ff0_0000;
const EXP_SIGNIF_BITS: i32 = 0x7fff_ffff;

fn hi(x: f64) -> i32 {
	(x.to_bits() >> 32) as i32
}

fn lo(x: f64) -> i32 {
	x.to_bits() as i32
}

fn with_hi(x: f64, high: i32) -> f64 {
	f64::from_bits((x.to_bits() & 0x0000_0000_ffff_ffff) | ((high as u32 as u64) << 32))
}

/// `StrictMath.hypot`.
pub fn hypot(x: f64, y: f64) -> f64 {
	let mut a = x.abs();
	let mut b = y.abs();
	if !a.is_finite() || !b.is_finite() {
		if a == f64::INFINITY || b == f64::INFINITY {
			return f64::INFINITY;
		}
		return a + b;
	}
	if b > a {
		std::mem::swap(&mut a, &mut b);
	}
	let mut ha = hi(a);
	let mut hb = hi(b);
	if ha.wrapping_sub(hb) > 0x3c0_0000 {
		return a + b;
	}
	let mut k: i32 = 0;
	if a > f64::from_bits(0x5f30_0000_ffff_ffff) {
		// a > ~2^500: scale a and b by 2^-600.
		ha -= 0x2580_0000;
		hb -= 0x2580_0000;
		a *= 2f64.powi(-600);
		b *= 2f64.powi(-600);
		k += 600;
	}
	if b < 2f64.powi(-500) {
		if b < f64::MIN_POSITIVE {
			if b == 0.0 {
				return a;
			}
			let t1 = 2f64.powi(1022);
			b *= t1;
			a *= t1;
			k -= 1022;
		} else {
			ha += 0x2580_0000;
			hb += 0x2580_0000;
			a *= 2f64.powi(600);
			b *= 2f64.powi(600);
			k -= 600;
		}
	}
	let mut w = a - b;
	if w > b {
		let t1 = with_hi(0.0, ha);
		let t2 = a - t1;
		w = (t1 * t1 - (b * (-b) - t2 * (a + t1))).sqrt();
	} else {
		a += a;
		let y1 = with_hi(0.0, hb);
		let y2 = b - y1;
		let t1 = with_hi(0.0, ha + 0x0010_0000);
		let t2 = a - t1;
		w = (t1 * y1 - (w * (-w) - (t1 * y2 + t2 * b))).sqrt();
	}
	if k != 0 {
		2f64.powi(k) * w
	} else {
		w
	}
}

const ATAN_HI: [f64; 4] = [
	4.636_476_090_008_060_935_15e-1,
	7.853_981_633_974_482_789_99e-1,
	9.827_937_232_473_290_540_82e-1,
	1.570_796_326_794_896_558_00e0,
];
const ATAN_LO: [f64; 4] = [
	2.269_877_745_296_168_709_24e-17,
	3.061_616_997_868_383_017_93e-17,
	1.390_331_103_123_099_845_16e-17,
	6.123_233_995_736_766_035_87e-17,
];
const AT: [f64; 11] = [
	3.333_333_333_333_293_180_27e-1,
	-1.999_999_999_987_648_324_76e-1,
	1.428_571_427_250_346_637_11e-1,
	-1.111_111_040_546_235_578_80e-1,
	9.090_887_133_436_506_561_96e-2,
	-7.691_876_205_044_829_994_95e-2,
	6.661_073_137_387_531_206_69e-2,
	-5.833_570_133_790_573_486_45e-2,
	4.976_877_994_615_932_360_17e-2,
	-3.653_157_274_421_691_552_70e-2,
	1.628_582_011_536_578_236_23e-2,
];

/// `StrictMath.atan`.
pub fn atan(x: f64) -> f64 {
	let mut x = x;
	let hx = hi(x);
	let ix = hx & EXP_SIGNIF_BITS;
	let id: i32;
	if ix >= 0x4410_0000 {
		if ix > EXP_BITS || (ix == EXP_BITS && lo(x) != 0) {
			return x + x;
		}
		return if hx > 0 {
			ATAN_HI[3] + ATAN_LO[3]
		} else {
			-ATAN_HI[3] - ATAN_LO[3]
		};
	}
	if ix < 0x3fdc_0000 {
		if ix < 0x3e20_0000 && HUGE + x > 1.0 {
			return x;
		}
		id = -1;
	} else {
		x = x.abs();
		if ix < 0x3ff3_0000 {
			if ix < 0x3fe6_0000 {
				id = 0;
				x = (2.0 * x - 1.0) / (2.0 + x);
			} else {
				id = 1;
				x = (x - 1.0) / (x + 1.0);
			}
		} else if ix < 0x4003_8000 {
			id = 2;
			x = (x - 1.5) / (1.0 + 1.5 * x);
		} else {
			id = 3;
			x = -1.0 / x;
		}
	}
	let z = x * x;
	let w = z * z;
	let s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
	let s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
	if id < 0 {
		return x - x * (s1 + s2);
	}
	let id = id as usize;
	let z = ATAN_HI[id] - ((x * (s1 + s2) - ATAN_LO[id]) - x);
	if hx < 0 {
		-z
	} else {
		z
	}
}

/// `StrictMath.atan2`.
pub fn atan2(y: f64, x: f64) -> f64 {
	use std::f64::consts::PI;
	const TINY: f64 = 1.0e-300;
	const PI_O_4: f64 = std::f64::consts::FRAC_PI_4;
	const PI_O_2: f64 = std::f64::consts::FRAC_PI_2;
	const PI_LO: f64 = 1.224_646_799_147_353_177_2e-16;
	let hx = hi(x);
	let ix = hx & EXP_SIGNIF_BITS;
	let lx = lo(x);
	let hy = hi(y);
	let abs_hy = hy & EXP_SIGNIF_BITS;
	let ly = lo(y);
	if x.is_nan() || y.is_nan() {
		return x + y;
	}
	if (hx.wrapping_sub(0x3ff0_0000) | lx) == 0 {
		return atan(y);
	}
	let m = ((hy >> 31) & 1) | ((hx >> 30) & 2);
	if (abs_hy | ly) == 0 {
		return match m {
			0 | 1 => y,
			2 => PI + TINY,
			_ => -PI - TINY,
		};
	}
	if (ix | lx) == 0 {
		return if hy < 0 { -PI_O_2 - TINY } else { PI_O_2 + TINY };
	}
	if ix == EXP_BITS {
		return if abs_hy == EXP_BITS {
			match m {
				0 => PI_O_4 + TINY,
				1 => -PI_O_4 - TINY,
				2 => 3.0 * PI_O_4 + TINY,
				_ => -3.0 * PI_O_4 - TINY,
			}
		} else {
			match m {
				0 => 0.0,
				1 => -0.0,
				2 => PI + TINY,
				_ => -PI - TINY,
			}
		};
	}
	if abs_hy == EXP_BITS {
		return if hy < 0 { -PI_O_2 - TINY } else { PI_O_2 + TINY };
	}
	let k = (abs_hy - ix) >> 20;
	let z = if k > 60 {
		PI_O_2 + 0.5 * PI_LO
	} else if hx < 0 && k < -60 {
		0.0
	} else {
		atan((y / x).abs())
	};
	match m {
		0 => z,
		1 => -z,
		2 => PI - (z - PI_LO),
		_ => (z - PI_LO) - PI,
	}
}

const LN2_HI: f64 = 6.931_471_803_691_238_164_90e-1;
const LN2_LO: f64 = 1.908_214_929_270_587_700_02e-10;
const INV_LN2: f64 = 1.442_695_040_888_963_387_00e0;
const O_THRESHOLD: f64 = 7.097_827_128_933_839_730_96e2;

/// `StrictMath.exp`.
pub fn exp(x: f64) -> f64 {
	const U_THRESHOLD: f64 = -7.451_332_191_019_411_084_20e2;
	const P: [f64; 5] = [
		1.666_666_666_666_660_190_37e-1,
		-2.777_777_777_701_559_338_42e-3,
		6.613_756_321_437_934_361_17e-5,
		-1.653_390_220_546_525_153_90e-6,
		4.138_136_797_057_238_460_39e-8,
	];
	let twom1000 = 2f64.powi(-1000);
	let mut x = x;
	let mut hx = hi(x);
	let xsb = ((hx >> 31) & 1) as usize;
	hx &= EXP_SIGNIF_BITS;
	if hx >= 0x4086_2e42 {
		if hx >= 0x7ff0_0000 {
			if ((hx & 0xf_ffff) | lo(x)) != 0 {
				return x + x;
			}
			return if xsb == 0 { x } else { 0.0 };
		}
		if x > O_THRESHOLD {
			return HUGE * HUGE;
		}
		if x < U_THRESHOLD {
			return twom1000 * twom1000;
		}
	}
	let mut hi_part = 0.0;
	let mut lo_part = 0.0;
	let mut k: i32 = 0;
	let ln2_hi = [LN2_HI, -LN2_HI];
	let ln2_lo = [LN2_LO, -LN2_LO];
	if hx > 0x3fd6_2e42 {
		if hx < 0x3ff0_a2b2 {
			hi_part = x - ln2_hi[xsb];
			lo_part = ln2_lo[xsb];
			k = 1 - xsb as i32 - xsb as i32;
		} else {
			k = (INV_LN2 * x + [0.5, -0.5][xsb]) as i32;
			let t = k as f64;
			hi_part = x - t * ln2_hi[0];
			lo_part = t * ln2_lo[0];
		}
		x = hi_part - lo_part;
	} else if hx < 0x3e30_0000 && HUGE + x > 1.0 {
		return 1.0 + x;
	}
	let t = x * x;
	let c = x - t * (P[0] + t * (P[1] + t * (P[2] + t * (P[3] + t * P[4]))));
	if k == 0 {
		return 1.0 - ((x * c) / (c - 2.0) - x);
	}
	let y = 1.0 - ((lo_part - (x * c) / (2.0 - c)) - hi_part);
	if k >= -1021 {
		with_hi(y, hi(y) + (k << 20))
	} else {
		with_hi(y, hi(y) + ((k + 1000) << 20)) * twom1000
	}
}

/// `StrictMath.expm1`.
pub fn expm1(x: f64) -> f64 {
	const TINY: f64 = 1.0e-300;
	const Q: [f64; 5] = [
		-3.333_333_333_333_313_164_28e-2,
		1.587_301_587_254_814_601_65e-3,
		-7.936_507_578_674_879_424_73e-5,
		4.008_217_827_329_362_395_52e-6,
		-2.010_992_181_836_243_713_26e-7,
	];
	let mut x = x;
	let mut hx = hi(x);
	let xsb = hx & i32::MIN;
	hx &= EXP_SIGNIF_BITS;
	if hx >= 0x4043_687a {
		if hx >= 0x4086_2e42 {
			if hx >= 0x7ff0_0000 {
				if ((hx & 0xf_ffff) | lo(x)) != 0 {
					return x + x;
				}
				return if xsb == 0 { x } else { -1.0 };
			}
			if x > O_THRESHOLD {
				return HUGE * HUGE;
			}
		}
		if xsb != 0 && x + TINY < 0.0 {
			return TINY - 1.0;
		}
	}
	let k: i32;
	let mut c = 0.0;
	if hx > 0x3fd6_2e42 {
		let (hi_part, lo_part);
		if hx < 0x3ff0_a2b2 {
			if xsb == 0 {
				hi_part = x - LN2_HI;
				lo_part = LN2_LO;
				k = 1;
			} else {
				hi_part = x + LN2_HI;
				lo_part = -LN2_LO;
				k = -1;
			}
		} else {
			k = (INV_LN2 * x + if xsb == 0 { 0.5 } else { -0.5 }) as i32;
			let t = k as f64;
			hi_part = x - t * LN2_HI;
			lo_part = t * LN2_LO;
		}
		x = hi_part - lo_part;
		c = (hi_part - x) - lo_part;
	} else if hx < 0x3c90_0000 {
		let t = HUGE + x;
		return x - (t - (HUGE + x));
	} else {
		k = 0;
	}
	let hfx = 0.5 * x;
	let hxs = x * hfx;
	let r1 = 1.0 + hxs * (Q[0] + hxs * (Q[1] + hxs * (Q[2] + hxs * (Q[3] + hxs * Q[4]))));
	let t = 3.0 - r1 * hfx;
	let mut e = hxs * ((r1 - t) / (6.0 - x * t));
	if k == 0 {
		return x - (x * e - hxs);
	}
	e = x * (e - c) - c;
	e -= hxs;
	if k == -1 {
		return 0.5 * (x - e) - 0.5;
	}
	if k == 1 {
		return if x < -0.25 {
			-2.0 * (e - (x + 0.5))
		} else {
			1.0 + 2.0 * (x - e)
		};
	}
	if k <= -2 || k > 56 {
		let y = 1.0 - (e - x);
		return with_hi(y, hi(y) + (k << 20)) - 1.0;
	}
	if k < 20 {
		let t = with_hi(1.0, 0x3ff0_0000 - (0x20_0000 >> k));
		let y = t - (e - x);
		with_hi(y, hi(y) + (k << 20))
	} else {
		let t = with_hi(1.0, (0x3ff - k) << 20);
		let y = x - (e + t) + 1.0;
		with_hi(y, hi(y) + (k << 20))
	}
}

/// `StrictMath.sinh`.
pub fn sinh(x: f64) -> f64 {
	const SHUGE: f64 = 1.0e307;
	let jx = hi(x);
	let ix = jx & EXP_SIGNIF_BITS;
	if ix >= EXP_BITS {
		return x + x;
	}
	let h = if jx < 0 { -0.5 } else { 0.5 };
	if ix < 0x4036_0000 {
		if ix < 0x3e30_0000 && SHUGE + x > 1.0 {
			return x;
		}
		let t = expm1(x.abs());
		if ix < 0x3ff0_0000 {
			return h * (2.0 * t - t * t / (t + 1.0));
		}
		return h * (t + t / (t + 1.0));
	}
	if ix < 0x4086_2e42 {
		return h * exp(x.abs());
	}
	let lx = lo(x) as u32;
	if ix < 0x4086_33ce || (ix == 0x4086_33ce && lx <= 0x8fb9_f87d) {
		let w = exp(0.5 * x.abs());
		let t = h * w;
		return t * w;
	}
	x * SHUGE
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn results_agree_with_the_platform_within_one_ulp() {
		let ulps = |a: f64, b: f64| (a.to_bits() as i64 - b.to_bits() as i64).abs();
		for i in 1..2000 {
			let x = i as f64 * 0.0137 - 13.0;
			assert!(ulps(sinh(x), x.sinh()) <= 1, "sinh {x}");
			assert!(ulps(atan(x), x.atan()) <= 1, "atan {x}");
			assert!(ulps(atan2(x, 0.7 - x), x.atan2(0.7 - x)) <= 1, "atan2 {x}");
			assert!(ulps(exp(x), x.exp()) <= 1, "exp {x}");
			assert!(ulps(expm1(x), x.exp_m1()) <= 1, "expm1 {x}");
			assert!(
				ulps(hypot(x, 0.3 * x + 1e-7), x.hypot(0.3 * x + 1e-7)) <= 1,
				"hypot {x}"
			);
		}
	}
}
