// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! UTC calendar arithmetic for expiry dates and record timestamps, with no time-zone database.
//!
//! An expiry date is inclusive: a credential that expires on `2026-11-30` is valid through
//! `2026-11-30T23:59:59.999Z`, the instant `licenseExpiryInstant` in `@mailwoman/license/product/token` returns.

use std::time::{SystemTime, UNIX_EPOCH};

const MS_PER_DAY: i64 = 86_400_000;

fn is_leap(year: i64) -> bool {
	(year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: u32) -> u32 {
	match month {
		1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
		4 | 6 | 9 | 11 => 30,
		_ if is_leap(year) => 29,
		_ => 28,
	}
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
	let y = if month <= 2 { year - 1 } else { year };
	let era = (if y >= 0 { y } else { y - 399 }) / 400;
	let yoe = y - era * 400;
	let m = i64::from(month);
	let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(day) - 1;
	let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
	era * 146_097 + doe - 719_468
}

/// The civil date of a day count since 1970-01-01.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
	let z = days + 719_468;
	let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
	let doe = z - era * 146_097;
	let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
	let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
	(yoe + era * 400 + i64::from(month <= 2), month, day)
}

fn digits(text: &str) -> Option<u32> {
	if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
		return None;
	}
	text.parse().ok()
}

/// The day count of a `YYYY-MM-DD` date that names a real day, or `None`.
pub fn parse_calendar_date(text: &str) -> Option<i64> {
	let bytes = text.as_bytes();
	if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
		return None;
	}
	let year = i64::from(digits(&text[0..4])?);
	let month = digits(&text[5..7])?;
	let day = digits(&text[8..10])?;
	if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
		return None;
	}
	Some(days_from_civil(year, month, day))
}

/// The last UTC millisecond of an inclusive expiry date, in milliseconds since the epoch.
pub fn expiry_instant_ms(date: &str) -> Option<i64> {
	Some(parse_calendar_date(date)? * MS_PER_DAY + MS_PER_DAY - 1)
}

/// Whether `text` is an RFC 3339 UTC instant in the form `z.iso.datetime({ offset: false })` admits:
/// `YYYY-MM-DDTHH:MM:SS`, optional fractional seconds, and `Z`.
pub fn is_utc_instant(text: &str) -> bool {
	parse_utc_instant_ms(text).is_some()
}

/// Milliseconds since the epoch of an RFC 3339 UTC instant, truncating fractional digits past the millisecond.
pub fn parse_utc_instant_ms(text: &str) -> Option<i64> {
	let body = text.strip_suffix('Z')?;
	let (date, clock) = body.split_once('T')?;
	let days = parse_calendar_date(date)?;
	let (whole, fraction) = match clock.split_once('.') {
		Some((whole, fraction)) => (whole, Some(fraction)),
		None => (clock, None),
	};
	let parts: Vec<&str> = whole.split(':').collect();
	if parts.len() != 3 || parts.iter().any(|p| p.len() != 2) {
		return None;
	}
	let (h, m, s) = (digits(parts[0])?, digits(parts[1])?, digits(parts[2])?);
	if h > 23 || m > 59 || s > 59 {
		return None;
	}
	let millis = match fraction {
		None => 0,
		Some(f) => {
			digits(f)?;
			let padded = format!("{f:0<3}");
			i64::from(digits(&padded[..3])?)
		}
	};
	Some(days * MS_PER_DAY + i64::from(h * 3_600_000 + m * 60_000 + s * 1000) + millis)
}

/// The current time in milliseconds since the epoch.
pub fn now_ms() -> i64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// `YYYY-MM-DDTHH:MM:SSZ` for an instant, to the second.
pub fn format_utc_instant(ms: i64) -> String {
	let days = ms.div_euclid(MS_PER_DAY);
	let rest = ms.rem_euclid(MS_PER_DAY) / 1000;
	let (year, month, day) = civil_from_days(days);
	format!(
		"{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
		rest / 3600,
		rest / 60 % 60,
		rest % 60
	)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn an_expiry_date_ends_at_its_last_utc_millisecond() {
		let end = expiry_instant_ms("2027-01-31").unwrap();
		assert_eq!(Some(end), parse_utc_instant_ms("2027-01-31T23:59:59.999Z"));
		assert_eq!(Some(end + 1), parse_utc_instant_ms("2027-02-01T00:00:00.000Z"));
	}

	#[test]
	fn a_date_that_names_no_real_day_is_refused() {
		for date in [
			"2027-02-29",
			"2027-02-30",
			"2027-13-01",
			"2027-00-10",
			"2027-1-01",
			"２０２７-01-01",
		] {
			assert_eq!(parse_calendar_date(date), None, "{date}");
		}
		assert!(parse_calendar_date("2028-02-29").is_some());
	}

	#[test]
	fn formatting_round_trips_through_parsing() {
		for text in ["1970-01-01T00:00:00Z", "2026-11-23T04:05:06Z", "2400-02-29T23:59:59Z"] {
			assert_eq!(format_utc_instant(parse_utc_instant_ms(text).unwrap()), text);
		}
	}
}
