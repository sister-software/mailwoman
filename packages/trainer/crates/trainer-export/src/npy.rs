// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! NumPy `.npy` arrays: little-endian, C order, format versions 1 to 3.
//!
//! The split reads a piece-count vector from one, and the trainer reads and writes the Fisher diagonal's arrays inside
//! an `.npz` archive.

use crate::{fail, Result};

/// A parsed header and the array bytes after it.
struct Array<'a> {
	descr: &'a str,
	shape: Vec<i64>,
	body: &'a [u8],
}

fn parse(bytes: &[u8]) -> Result<Array<'_>> {
	if bytes.len() < 10 || &bytes[..6] != b"\x93NUMPY" {
		return Err(fail!("not an .npy array"));
	}
	let (len, start) = match bytes[6] {
		1 => (u16::from_le_bytes([bytes[8], bytes[9]]) as usize, 10),
		2 | 3 if bytes.len() >= 12 => (
			u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize,
			12,
		),
		v => return Err(fail!(".npy version {v} is not read")),
	};
	let header = bytes
		.get(start..start + len)
		.and_then(|h| std::str::from_utf8(h).ok())
		.ok_or_else(|| fail!(".npy header is unreadable"))?;
	if header.contains("'fortran_order': True") {
		return Err(fail!(".npy array is Fortran-ordered"));
	}
	let descr = header
		.split("'descr': '")
		.nth(1)
		.and_then(|s| s.split('\'').next())
		.ok_or_else(|| fail!(".npy header has no descr: {header}"))?;
	let shape_text = header
		.split("'shape': (")
		.nth(1)
		.and_then(|s| s.split(')').next())
		.ok_or_else(|| fail!(".npy header has no shape: {header}"))?;
	let shape = shape_text
		.split(',')
		.map(str::trim)
		.filter(|s| !s.is_empty())
		.map(|s| s.parse().map_err(|_| fail!(".npy shape ({shape_text})")))
		.collect::<Result<_>>()?;
	Ok(Array {
		descr,
		shape,
		body: &bytes[start + len..],
	})
}

/// A float32 array and its shape.
pub fn read_f32(bytes: &[u8]) -> Result<(Vec<i64>, Vec<f32>)> {
	let array = parse(bytes)?;
	if array.descr != "<f4" {
		return Err(fail!(".npy dtype {} is not little-endian float32", array.descr));
	}
	let data = array
		.body
		.as_chunks::<4>()
		.0
		.iter()
		.map(|c| f32::from_le_bytes(*c))
		.collect();
	Ok((array.shape, data))
}

/// A one-dimensional integer vector (`<i8`, `<u8`, `<i4` or `<u4`), widened to i64.
pub fn read_integer_vector(bytes: &[u8]) -> Result<Vec<i64>> {
	let array = parse(bytes)?;
	let body = array.body;
	let values: Vec<i64> = match array.descr {
		"<i8" => body.as_chunks::<8>().0.iter().map(|b| i64::from_le_bytes(*b)).collect(),
		"<u8" => body
			.as_chunks::<8>()
			.0
			.iter()
			.map(|b| i64::try_from(u64::from_le_bytes(*b)).map_err(|_| fail!("a u64 count exceeds i64")))
			.collect::<Result<_>>()?,
		"<i4" => body
			.as_chunks::<4>()
			.0
			.iter()
			.map(|b| i32::from_le_bytes(*b) as i64)
			.collect(),
		"<u4" => body
			.as_chunks::<4>()
			.0
			.iter()
			.map(|b| u32::from_le_bytes(*b) as i64)
			.collect(),
		other => return Err(fail!(".npy dtype {other} is not an integer count type")),
	};
	if array.shape.len() != 1 || usize::try_from(array.shape[0]).ok() != Some(values.len()) {
		return Err(fail!(
			".npy shape {:?} is not a vector of {} counts",
			array.shape,
			values.len()
		));
	}
	Ok(values)
}

/// One float32 array as an `.npy` v1.0 file, its header padded to a 64-byte boundary as NumPy writes it.
pub fn f32_bytes(shape: &[i64], data: &[f32]) -> Vec<u8> {
	let dims = match shape.len() {
		0 => "()".to_owned(),
		1 => format!("({},)", shape[0]),
		_ => format!("({})", shape.iter().map(i64::to_string).collect::<Vec<_>>().join(", ")),
	};
	let mut header = format!("{{'descr': '<f4', 'fortran_order': False, 'shape': {dims}, }}");
	let total = 10 + header.len() + 1;
	header.push_str(&" ".repeat((64 - total % 64) % 64));
	header.push('\n');
	let mut out = Vec::with_capacity(10 + header.len() + data.len() * 4);
	out.extend_from_slice(b"\x93NUMPY\x01\x00");
	out.extend_from_slice(&(header.len() as u16).to_le_bytes());
	out.extend_from_slice(header.as_bytes());
	for v in data {
		out.extend_from_slice(&v.to_le_bytes());
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn float_arrays_round_trip() {
		let bytes = f32_bytes(&[2, 3], &[1.0, 2.0, 3.0, 4.0, 5.0, 6.5]);
		let header = "{'descr': '<f4', 'fortran_order': False, 'shape': (2, 3), }";
		assert_eq!(std::str::from_utf8(&bytes[10..10 + header.len()]).unwrap(), header);
		assert_eq!(bytes.len(), 128 + 6 * 4, "the header pads to a multiple of 64 bytes");
		assert_eq!(bytes[127], b'\n', "the header ends in a newline");
		assert_eq!(
			read_f32(&bytes).unwrap(),
			(vec![2, 3], vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.5])
		);
		assert_eq!(read_f32(&f32_bytes(&[4], &[0.0; 4])).unwrap().0, [4]);
	}

	#[test]
	fn reads_an_integer_vector_and_refuses_a_float_one() {
		let header = "{'descr': '<i8', 'fortran_order': False, 'shape': (3,), }";
		let mut bytes = b"\x93NUMPY\x01\x00".to_vec();
		let padded = format!("{header}{}\n", " ".repeat((64 - (10 + header.len() + 1) % 64) % 64));
		bytes.extend_from_slice(&(padded.len() as u16).to_le_bytes());
		bytes.extend_from_slice(padded.as_bytes());
		for v in [7i64, 0, 2] {
			bytes.extend_from_slice(&v.to_le_bytes());
		}
		assert_eq!(read_integer_vector(&bytes).unwrap(), [7, 0, 2]);
		assert!(read_integer_vector(&f32_bytes(&[2], &[1.0, 2.0])).is_err());
		assert!(read_f32(&bytes).is_err());
	}
}
