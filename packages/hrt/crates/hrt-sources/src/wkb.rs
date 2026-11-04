// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Well-known binary geometry and the GeoPackage binary header that wraps it.

use geo_types::{
	Coord, Geometry, GeometryCollection, LineString, MultiLineString, MultiPoint, MultiPolygon, Point, Polygon,
};

/// Bytes that are not a geometry this reader understands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WkbError(pub &'static str);

struct Reader<'a> {
	bytes: &'a [u8],
	at: usize,
	little: bool,
}

impl Reader<'_> {
	fn take<const N: usize>(&mut self) -> Result<[u8; N], WkbError> {
		let slice = self
			.bytes
			.get(self.at..self.at + N)
			.ok_or(WkbError("truncated geometry"))?;
		self.at += N;
		Ok(slice.try_into().unwrap())
	}

	fn u32(&mut self) -> Result<u32, WkbError> {
		let bytes = self.take::<4>()?;
		Ok(if self.little {
			u32::from_le_bytes(bytes)
		} else {
			u32::from_be_bytes(bytes)
		})
	}

	fn f64(&mut self) -> Result<f64, WkbError> {
		let bytes = self.take::<8>()?;
		Ok(if self.little {
			f64::from_le_bytes(bytes)
		} else {
			f64::from_be_bytes(bytes)
		})
	}
}

/// Splits a type code into its base type and its number of ordinates, from both ISO (1000s) and EWKB (high bits) forms.
fn split_type(code: u32) -> (u32, usize) {
	let has_z = code & 0x8000_0000 != 0;
	let has_m = code & 0x4000_0000 != 0;
	let code = code & 0x0FFF_FFFF;
	let (base, iso_dims) = (code % 1000, code / 1000);
	let mut dims = 2;
	match iso_dims {
		1 | 2 => dims += 1,
		3 => dims += 2,
		_ => {}
	}
	if has_z {
		dims += 1;
	}
	if has_m {
		dims += 1;
	}
	(base, dims)
}

fn coords(reader: &mut Reader<'_>, dims: usize) -> Result<Vec<Coord>, WkbError> {
	let count = reader.u32()? as usize;
	let mut out = Vec::with_capacity(count.min(1 << 20));
	for _ in 0..count {
		let x = reader.f64()?;
		let y = reader.f64()?;
		for _ in 2..dims {
			reader.f64()?;
		}
		out.push(Coord { x, y });
	}
	Ok(out)
}

fn polygon(reader: &mut Reader<'_>, dims: usize) -> Result<Polygon, WkbError> {
	let rings = reader.u32()? as usize;
	let mut lines = Vec::with_capacity(rings);
	for _ in 0..rings {
		lines.push(LineString(coords(reader, dims)?));
	}
	let mut lines = lines.into_iter();
	let exterior = lines.next().unwrap_or_else(|| LineString(Vec::new()));
	Ok(Polygon::new(exterior, lines.collect()))
}

fn geometry(reader: &mut Reader<'_>) -> Result<Geometry, WkbError> {
	reader.little = reader.take::<1>()?[0] == 1;
	let (base, dims) = split_type(reader.u32()?);
	Ok(match base {
		1 => {
			let x = reader.f64()?;
			let y = reader.f64()?;
			for _ in 2..dims {
				reader.f64()?;
			}
			Geometry::Point(Point::new(x, y))
		}
		2 => Geometry::LineString(LineString(coords(reader, dims)?)),
		3 => Geometry::Polygon(polygon(reader, dims)?),
		4..=7 => {
			let count = reader.u32()? as usize;
			let mut parts = Vec::with_capacity(count.min(1 << 16));
			for _ in 0..count {
				parts.push(geometry(reader)?);
			}
			let pick = |parts: Vec<Geometry>| -> Result<Geometry, WkbError> {
				Ok(match base {
					4 => Geometry::MultiPoint(MultiPoint(
						parts
							.into_iter()
							.map(|part| match part {
								Geometry::Point(point) => Ok(point),
								_ => Err(WkbError("multipoint member is not a point")),
							})
							.collect::<Result<_, _>>()?,
					)),
					5 => Geometry::MultiLineString(MultiLineString(
						parts
							.into_iter()
							.map(|part| match part {
								Geometry::LineString(line) => Ok(line),
								_ => Err(WkbError("multilinestring member is not a line")),
							})
							.collect::<Result<_, _>>()?,
					)),
					6 => Geometry::MultiPolygon(MultiPolygon(
						parts
							.into_iter()
							.map(|part| match part {
								Geometry::Polygon(polygon) => Ok(polygon),
								_ => Err(WkbError("multipolygon member is not a polygon")),
							})
							.collect::<Result<_, _>>()?,
					)),
					_ => Geometry::GeometryCollection(GeometryCollection(parts)),
				})
			};
			pick(parts)?
		}
		_ => return Err(WkbError("unsupported geometry type")),
	})
}

/// Parses well-known binary.
pub fn parse_wkb(bytes: &[u8]) -> Result<Geometry, WkbError> {
	geometry(&mut Reader {
		bytes,
		at: 0,
		little: true,
	})
}

/// Returns the well-known binary inside a GeoPackage geometry blob, or `None` for an empty geometry.
pub fn geopackage_wkb(blob: &[u8]) -> Result<Option<&[u8]>, WkbError> {
	if blob.len() < 8 || &blob[0..2] != b"GP" {
		return Err(WkbError("not a GeoPackage geometry"));
	}
	let flags = blob[3];
	let envelope_bytes = match (flags >> 1) & 0b111 {
		0 => 0,
		1 => 32,
		2 | 3 => 48,
		4 => 64,
		_ => return Err(WkbError("bad envelope indicator")),
	};
	let empty = flags & 0b1_0000 != 0;
	let start = 8 + envelope_bytes;
	if empty || blob.len() <= start {
		return Ok(None);
	}
	Ok(Some(&blob[start..]))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_little_endian_polygon_parses() {
		let mut bytes = vec![1u8];
		bytes.extend_from_slice(&3u32.to_le_bytes());
		bytes.extend_from_slice(&1u32.to_le_bytes());
		bytes.extend_from_slice(&4u32.to_le_bytes());
		for (x, y) in [(0.0f64, 0.0f64), (1.0, 0.0), (1.0, 1.0), (0.0, 0.0)] {
			bytes.extend_from_slice(&x.to_le_bytes());
			bytes.extend_from_slice(&y.to_le_bytes());
		}
		let Geometry::Polygon(polygon) = parse_wkb(&bytes).unwrap() else {
			panic!("expected a polygon");
		};
		assert_eq!(polygon.exterior().0.len(), 4);
	}
}
