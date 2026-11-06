// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The RGY1 compiler.
//!
//! `compile` reads the two normalized collections and the source lock and returns every artifact of
//! the profile as bytes. The output depends only on the inputs: strings are pooled in first-use order
//! over records the normalizer already sorted, the header is canonical JSON with sorted keys, and no
//! clock or host path enters the bytes. `docs/rgy1.md` is the layout this writer follows.

use registry_core::artifact::align;
use registry_core::key;
use registry_core::sections;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

/// Why an input cannot be compiled.
#[derive(Debug)]
pub enum BuildError {
	Json(serde_json::Error),
	/// A code outside its namespace's grammar, which the key space cannot hold.
	Grammar(String),
	/// Two current records of one namespace hold one code.
	Duplicate(String),
	/// More rows than the id table's width can address.
	Overflow(String),
	/// A facility or status word the definitions do not list.
	Vocabulary(String),
}

impl From<serde_json::Error> for BuildError {
	fn from(error: serde_json::Error) -> Self {
		BuildError::Json(error)
	}
}

impl std::fmt::Display for BuildError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			BuildError::Json(error) => write!(f, "json: {error}"),
			BuildError::Grammar(what) => write!(f, "grammar: {what}"),
			BuildError::Duplicate(what) => write!(f, "duplicate: {what}"),
			BuildError::Overflow(what) => write!(f, "overflow: {what}"),
			BuildError::Vocabulary(what) => write!(f, "vocabulary: {what}"),
		}
	}
}

impl std::error::Error for BuildError {}

#[derive(Deserialize)]
pub struct CountryRecord {
	#[serde(rename = "entityID")]
	pub entity_id: String,
	pub alpha2: String,
	pub alpha3: String,
	pub numeric: String,
	pub name: String,
	pub status: String,
}

#[derive(Deserialize)]
pub struct Countries {
	pub profile: String,
	pub source: String,
	#[serde(rename = "normalizationVersion")]
	pub normalization_version: u32,
	pub records: Vec<CountryRecord>,
}

#[derive(Deserialize)]
pub struct AirportRecord {
	#[serde(rename = "entityID")]
	pub entity_id: String,
	pub iata: String,
	pub icao: Option<String>,
	pub name: String,
	pub facility: String,
	#[serde(rename = "scheduledService")]
	pub scheduled_service: bool,
	pub latitude: f64,
	pub longitude: f64,
	pub country: Option<String>,
	#[serde(rename = "countryStatus")]
	pub country_status: String,
	#[serde(rename = "isoRegion")]
	pub iso_region: Option<String>,
	pub municipality: Option<String>,
}

#[derive(Deserialize)]
pub struct Airports {
	pub profile: String,
	pub source: String,
	#[serde(rename = "normalizationVersion")]
	pub normalization_version: u32,
	pub records: Vec<AirportRecord>,
}

#[derive(Deserialize)]
pub struct LockEntry {
	pub url: String,
	pub sha256: String,
	pub bytes: u64,
	pub publication: String,
}

#[derive(Deserialize)]
pub struct SourceLock {
	pub profile: String,
	pub sources: BTreeMap<String, LockEntry>,
}

/// One compiled artifact.
pub struct Built {
	pub name: String,
	pub bytes: Vec<u8>,
}

/// The country statuses, in the order the status column encodes them.
pub const COUNTRY_STATUSES: [&str; 2] = ["officially-assigned", "formerly-used"];
/// The airport country statuses, in column order.
pub const AIRPORT_COUNTRY_STATUSES: [&str; 3] = ["iso3166-1", "source-extension", "unstated"];
/// The facility kinds OurAirports states, in column order.
pub const FACILITIES: [&str; 5] = [
	"large_airport",
	"medium_airport",
	"small_airport",
	"seaplane_base",
	"heliport",
];

/// The value a key column holds for an absent key.
pub const NO_KEY: u32 = 0xFFFF;

const GENERATOR: &str = concat!("registry-build ", env!("CARGO_PKG_VERSION"));

struct SectionSpec {
	kind: u16,
	width: u16,
	flags: u16,
	count: u32,
	aux: u32,
	payload: Vec<u8>,
}

/// Collects sections and a header, then lays the artifact out.
struct Writer {
	header: Map<String, Value>,
	sections: Vec<SectionSpec>,
}

impl Writer {
	fn new(name: &str, profile: &str, lock: &SourceLock, source_ids: &[&str], namespaces: &[&str]) -> Self {
		let mut header = Map::new();
		let sources: Vec<Value> = source_ids
			.iter()
			.filter_map(|id| lock.sources.get(*id).map(|entry| (id, entry)))
			.map(|(id, entry)| json!({ "id": id, "sha256": entry.sha256, "publication": entry.publication }))
			.collect();
		let mut encodings = Map::new();

		for kind in [
			sections::KIND_BITSET,
			sections::KIND_ID_TABLE,
			sections::KIND_STRING_OFFSETS,
			sections::KIND_UTF8,
			sections::KIND_COLUMN,
			sections::KIND_RELATION_OFFSETS,
			sections::KIND_RELATION_TARGETS,
		] {
			encodings.insert(sections::name_of(kind).to_string(), json!(sections::encoding_of(kind)));
		}

		header.insert("artifact".into(), json!(name));
		header.insert("profile".into(), json!(profile));
		header.insert("namespaces".into(), json!(namespaces));
		header.insert("sources".into(), Value::Array(sources));
		header.insert("schemaVersion".into(), json!(1));
		header.insert("normalizationVersion".into(), json!(1));
		header.insert("envelopeVersion".into(), json!(sections::VERSION));
		header.insert("encodings".into(), Value::Object(encodings));
		header.insert("generator".into(), json!(GENERATOR));

		Writer {
			header,
			sections: Vec::new(),
		}
	}

	fn set(&mut self, key: &str, value: Value) {
		self.header.insert(key.to_string(), value);
	}

	fn bitset(&mut self, arity: u32, keys: impl Iterator<Item = u32>) {
		let space = key::key_space(arity).expect("a declared arity");
		let mut payload = vec![0u8; (space as usize).div_ceil(8)];

		for key in keys {
			payload[(key >> 3) as usize] |= 1 << (key & 7);
		}

		self.sections.push(SectionSpec {
			kind: sections::KIND_BITSET,
			width: 0,
			flags: sections::FLAG_REQUIRED,
			count: space,
			aux: arity,
			payload,
		});
	}

	fn id_table(
		&mut self,
		arity: u32,
		width: u16,
		entries: impl Iterator<Item = (u32, u32)>,
	) -> Result<(), BuildError> {
		let space = key::key_space(arity).expect("a declared arity") as usize;
		let limit = match width {
			1 => 0xFEu32,
			2 => 0xFFFE,
			_ => 0xFFFF_FFFE,
		};
		let mut payload = vec![0u8; space * width as usize];

		for (key, row) in entries {
			if row > limit {
				return Err(BuildError::Overflow(format!(
					"row {row} exceeds a {width}-byte id table"
				)));
			}

			let value = row + 1;
			let at = key as usize * width as usize;

			match width {
				1 => payload[at] = value as u8,
				2 => payload[at..at + 2].copy_from_slice(&(value as u16).to_le_bytes()),
				_ => payload[at..at + 4].copy_from_slice(&value.to_le_bytes()),
			}
		}

		self.sections.push(SectionSpec {
			kind: sections::KIND_ID_TABLE,
			width,
			flags: sections::FLAG_REQUIRED,
			count: space as u32,
			aux: arity,
			payload,
		});

		Ok(())
	}

	fn column(&mut self, index: u32, width: u16, rows: usize, payload: Vec<u8>) {
		debug_assert_eq!(payload.len(), rows * width as usize);

		self.sections.push(SectionSpec {
			kind: sections::KIND_COLUMN,
			width,
			flags: sections::FLAG_REQUIRED,
			count: rows as u32,
			aux: index,
			payload,
		});
	}

	fn pool(&mut self, pool: &Pool) {
		let mut offsets = Vec::with_capacity((pool.offsets.len() + 1) * 4);

		for offset in &pool.offsets {
			offsets.extend_from_slice(&offset.to_le_bytes());
		}

		offsets.extend_from_slice(&(pool.bytes.len() as u32).to_le_bytes());

		self.sections.push(SectionSpec {
			kind: sections::KIND_STRING_OFFSETS,
			width: 4,
			flags: sections::FLAG_REQUIRED,
			count: pool.offsets.len() as u32 + 1,
			aux: 0,
			payload: offsets,
		});
		self.sections.push(SectionSpec {
			kind: sections::KIND_UTF8,
			width: 0,
			flags: sections::FLAG_REQUIRED,
			count: pool.bytes.len() as u32,
			aux: 0,
			payload: pool.bytes.clone(),
		});
	}

	fn relation(&mut self, index: u32, sources: usize, targets_by_source: &BTreeMap<u32, Vec<u32>>) {
		let mut offsets = Vec::with_capacity((sources + 1) * 4);
		let mut targets = Vec::new();
		let mut running = 0u32;

		for source in 0..sources as u32 {
			offsets.extend_from_slice(&running.to_le_bytes());

			if let Some(list) = targets_by_source.get(&source) {
				for target in list {
					targets.extend_from_slice(&target.to_le_bytes());
				}

				running += list.len() as u32;
			}
		}

		offsets.extend_from_slice(&running.to_le_bytes());

		self.sections.push(SectionSpec {
			kind: sections::KIND_RELATION_OFFSETS,
			width: 4,
			flags: sections::FLAG_REQUIRED,
			count: sources as u32 + 1,
			aux: index,
			payload: offsets,
		});
		self.sections.push(SectionSpec {
			kind: sections::KIND_RELATION_TARGETS,
			width: 4,
			flags: sections::FLAG_REQUIRED,
			count: running,
			aux: index,
			payload: targets,
		});
	}

	fn finish(self) -> Vec<u8> {
		// `serde_json::Map` is a `BTreeMap` without the `preserve_order` feature, so the keys sort.
		let header = serde_json::to_string(&Value::Object(self.header)).expect("a serializable header");
		let header_bytes = header.as_bytes();
		let directory_offset = align(sections::HEADER_OFFSET + header_bytes.len());
		let first_payload = align(directory_offset + self.sections.len() * sections::DIRECTORY_ENTRY_BYTES);

		let mut offsets = Vec::with_capacity(self.sections.len());
		let mut cursor = first_payload;

		for section in &self.sections {
			offsets.push(cursor);
			cursor = align(cursor + section.payload.len());
		}

		let total = cursor;
		let mut bytes = vec![0u8; total];

		bytes[0..4].copy_from_slice(sections::MAGIC);
		bytes[4..6].copy_from_slice(&sections::VERSION.to_le_bytes());
		bytes[6..8].copy_from_slice(&0u16.to_le_bytes());
		bytes[8..12].copy_from_slice(&(header_bytes.len() as u32).to_le_bytes());
		bytes[12..16].copy_from_slice(&(self.sections.len() as u32).to_le_bytes());
		bytes[16..20].copy_from_slice(&(directory_offset as u32).to_le_bytes());
		bytes[20..24].copy_from_slice(&(total as u32).to_le_bytes());
		bytes[24..28].copy_from_slice(&(first_payload as u32).to_le_bytes());
		bytes[sections::HEADER_OFFSET..sections::HEADER_OFFSET + header_bytes.len()].copy_from_slice(header_bytes);

		for (index, section) in self.sections.iter().enumerate() {
			let at = directory_offset + index * sections::DIRECTORY_ENTRY_BYTES;
			let entry = &mut bytes[at..at + sections::DIRECTORY_ENTRY_BYTES];

			entry[0..2].copy_from_slice(&section.kind.to_le_bytes());
			entry[2..4].copy_from_slice(&sections::encoding_of(section.kind).expect("a known kind").to_le_bytes());
			entry[4..6].copy_from_slice(&section.width.to_le_bytes());
			entry[6..8].copy_from_slice(&section.flags.to_le_bytes());
			entry[8..12].copy_from_slice(&(offsets[index] as u32).to_le_bytes());
			entry[12..16].copy_from_slice(&(section.payload.len() as u32).to_le_bytes());
			entry[16..20].copy_from_slice(&section.count.to_le_bytes());
			entry[20..24].copy_from_slice(&section.aux.to_le_bytes());

			bytes[offsets[index]..offsets[index] + section.payload.len()].copy_from_slice(&section.payload);
		}

		bytes
	}
}

/// A deduplicating string pool. Index 0 is the empty string, so a missing value reads as `""`.
#[derive(Default)]
struct Pool {
	offsets: Vec<u32>,
	bytes: Vec<u8>,
	index: BTreeMap<String, u32>,
}

impl Pool {
	fn new() -> Self {
		let mut pool = Pool::default();
		pool.intern("");
		pool
	}

	fn intern(&mut self, text: &str) -> u32 {
		if let Some(index) = self.index.get(text) {
			return *index;
		}

		let index = self.offsets.len() as u32;
		self.offsets.push(self.bytes.len() as u32);
		self.bytes.extend_from_slice(text.as_bytes());
		self.index.insert(text.to_string(), index);

		index
	}
}

fn encode_or_err(arity: u32, code: &str, what: &str) -> Result<u32, BuildError> {
	key::encode(arity, code.as_bytes()).ok_or_else(|| BuildError::Grammar(format!("{what}: {code:?}")))
}

fn vocabulary(list: &[&str], word: &str, what: &str) -> Result<u8, BuildError> {
	list.iter()
		.position(|candidate| *candidate == word)
		.map(|position| position as u8)
		.ok_or_else(|| BuildError::Vocabulary(format!("{what}: {word:?}")))
}

fn u16_column(values: &[u32]) -> Vec<u8> {
	values.iter().flat_map(|value| (*value as u16).to_le_bytes()).collect()
}

fn u32_column(values: &[u32]) -> Vec<u8> {
	values.iter().flat_map(|value| value.to_le_bytes()).collect()
}

fn f64_column(values: &[f64]) -> Vec<u8> {
	values.iter().flat_map(|value| value.to_le_bytes()).collect()
}

/// Compiles the profile's artifacts from the normalized collections and the lock.
pub fn compile(countries_json: &str, airports_json: &str, lock_json: &str) -> Result<Vec<Built>, BuildError> {
	let countries: Countries = serde_json::from_str(countries_json)?;
	let airports: Airports = serde_json::from_str(airports_json)?;
	let lock: SourceLock = serde_json::from_str(lock_json)?;
	let profile = countries.profile.as_str();

	// Country keys, with each record's status.
	let mut alpha2_keys = Vec::with_capacity(countries.records.len());
	let mut alpha3_keys = Vec::with_capacity(countries.records.len());
	let mut numeric_keys = Vec::with_capacity(countries.records.len());
	let mut statuses = Vec::with_capacity(countries.records.len());

	for record in &countries.records {
		alpha2_keys.push(encode_or_err(2, &record.alpha2, &record.entity_id)?);
		alpha3_keys.push(encode_or_err(3, &record.alpha3, &record.entity_id)?);
		numeric_keys.push(encode_or_err(key::ARITY_NUMERIC, &record.numeric, &record.entity_id)?);
		statuses.push(vocabulary(&COUNTRY_STATUSES, &record.status, &record.entity_id)?);
	}

	let current = |row: usize| statuses[row] == 0;

	// A current record owns its keys; a former record takes a key only when no current record holds it.
	let table_entries = |keys: &[u32], what: &str| -> Result<Vec<(u32, u32)>, BuildError> {
		let mut owners: BTreeMap<u32, u32> = BTreeMap::new();

		for (row, key) in keys.iter().enumerate() {
			if current(row) {
				if let Some(other) = owners.insert(*key, row as u32) {
					if current(other as usize) {
						return Err(BuildError::Duplicate(format!(
							"{what} {} held by {} and {}",
							countries.records[row].alpha2,
							countries.records[other as usize].entity_id,
							countries.records[row].entity_id
						)));
					}
				}
			} else {
				owners.entry(*key).or_insert(row as u32);
			}
		}

		Ok(owners.into_iter().collect())
	};

	let current_alpha2: Vec<u32> = alpha2_keys
		.iter()
		.enumerate()
		.filter(|(row, _)| current(*row))
		.map(|(_, key)| *key)
		.collect();
	let current_alpha3: Vec<u32> = alpha3_keys
		.iter()
		.enumerate()
		.filter(|(row, _)| current(*row))
		.map(|(_, key)| *key)
		.collect();
	let current_count = current_alpha2.len();

	let country_sources = [countries.source.as_str()];
	let mut built = Vec::new();

	// iso3166-1-alpha2-membership
	{
		let mut writer = Writer::new(
			"iso3166-1-alpha2-membership",
			profile,
			&lock,
			&country_sources,
			&["iso3166-1-alpha2"],
		);
		writer.set("status", json!("officially-assigned"));
		writer.set("coverage", json!({ "iso3166-1-alpha2": current_count }));
		writer.bitset(2, current_alpha2.iter().copied());
		built.push(Built {
			name: "iso3166-1-alpha2-membership".into(),
			bytes: writer.finish(),
		});
	}

	// iso3166-1-alpha3-membership
	{
		let mut writer = Writer::new(
			"iso3166-1-alpha3-membership",
			profile,
			&lock,
			&country_sources,
			&["iso3166-1-alpha3"],
		);
		writer.set("status", json!("officially-assigned"));
		writer.set("coverage", json!({ "iso3166-1-alpha3": current_count }));
		writer.bitset(3, current_alpha3.iter().copied());
		built.push(Built {
			name: "iso3166-1-alpha3-membership".into(),
			bytes: writer.finish(),
		});
	}

	// iso3166-1-records
	{
		let mut writer = Writer::new(
			"iso3166-1-records",
			profile,
			&lock,
			&country_sources,
			&["iso3166-1-alpha2", "iso3166-1-alpha3", "iso3166-1-numeric"],
		);
		let mut pool = Pool::new();
		let rows = countries.records.len();
		let names: Vec<u32> = countries
			.records
			.iter()
			.map(|record| pool.intern(&record.name))
			.collect();
		let entities: Vec<u32> = countries
			.records
			.iter()
			.map(|record| pool.intern(&record.entity_id))
			.collect();

		writer.set(
			"columns",
			json!([
				{ "name": "alpha2Key", "type": "key2", "width": 2 },
				{ "name": "alpha3Key", "type": "key3", "width": 2 },
				{ "name": "numeric", "type": "numeric", "width": 2 },
				{ "name": "status", "type": "u8", "width": 1, "values": COUNTRY_STATUSES },
				{ "name": "name", "type": "string", "width": 4 },
				{ "name": "entityID", "type": "string", "width": 4 },
			]),
		);
		writer.set("rows", json!(rows));
		writer.set(
			"coverage",
			json!({ "officially-assigned": current_count, "formerly-used": rows - current_count }),
		);
		writer.id_table(2, 2, table_entries(&alpha2_keys, "alpha2")?.into_iter())?;
		writer.id_table(3, 2, table_entries(&alpha3_keys, "alpha3")?.into_iter())?;
		writer.id_table(
			key::ARITY_NUMERIC,
			2,
			table_entries(&numeric_keys, "numeric")?.into_iter(),
		)?;
		writer.column(0, 2, rows, u16_column(&alpha2_keys));
		writer.column(1, 2, rows, u16_column(&alpha3_keys));
		writer.column(2, 2, rows, u16_column(&numeric_keys));
		writer.column(3, 1, rows, statuses.clone());
		writer.column(4, 4, rows, u32_column(&names));
		writer.column(5, 4, rows, u32_column(&entities));
		writer.pool(&pool);
		built.push(Built {
			name: "iso3166-1-records".into(),
			bytes: writer.finish(),
		});
	}

	// Airports.
	let mut iata_keys = Vec::with_capacity(airports.records.len());
	let mut held: BTreeMap<u32, &str> = BTreeMap::new();

	for record in &airports.records {
		let key = encode_or_err(3, &record.iata, &record.entity_id)?;

		if let Some(other) = held.insert(key, &record.entity_id) {
			return Err(BuildError::Duplicate(format!(
				"iata {} held by {other} and {}",
				record.iata, record.entity_id
			)));
		}

		iata_keys.push(key);
	}

	let current_alpha2_set: std::collections::BTreeSet<u32> = current_alpha2.iter().copied().collect();
	let airport_sources = [airports.source.as_str()];

	// iata-airport-membership
	{
		let mut writer = Writer::new(
			"iata-airport-membership",
			profile,
			&lock,
			&airport_sources,
			&["iata-location"],
		);
		writer.set("kinds", json!(["airport"]));
		writer.set("coverage", json!({ "iata-location": iata_keys.len() }));
		writer.bitset(3, iata_keys.iter().copied());
		built.push(Built {
			name: "iata-airport-membership".into(),
			bytes: writer.finish(),
		});
	}

	// iata-airport-records
	{
		let mut writer = Writer::new(
			"iata-airport-records",
			profile,
			&lock,
			&airport_sources,
			&["iata-location", "icao-location", "iso3166-1-alpha2"],
		);
		let rows = airports.records.len();
		let mut pool = Pool::new();
		let mut country_keys = Vec::with_capacity(rows);
		let mut country_statuses = Vec::with_capacity(rows);
		let mut country_texts = Vec::with_capacity(rows);
		let mut facilities = Vec::with_capacity(rows);
		let mut scheduled = Vec::with_capacity(rows);
		let mut latitudes = Vec::with_capacity(rows);
		let mut longitudes = Vec::with_capacity(rows);
		let mut names = Vec::with_capacity(rows);
		let mut icaos = Vec::with_capacity(rows);
		let mut municipalities = Vec::with_capacity(rows);
		let mut regions = Vec::with_capacity(rows);
		let mut entities = Vec::with_capacity(rows);
		let mut located_in: BTreeMap<u32, Vec<u32>> = BTreeMap::new();

		for (row, record) in airports.records.iter().enumerate() {
			let status = vocabulary(&AIRPORT_COUNTRY_STATUSES, &record.country_status, &record.entity_id)?;
			let country_key = match (&record.country, status) {
				(Some(code), 0) => {
					let key = encode_or_err(2, code, &record.entity_id)?;

					if !current_alpha2_set.contains(&key) {
						return Err(BuildError::Vocabulary(format!(
							"{}: country {code} is labeled iso3166-1 but is not a current alpha-2 code",
							record.entity_id
						)));
					}

					located_in.entry(key).or_default().push(row as u32);
					key
				}
				_ => NO_KEY,
			};

			country_keys.push(country_key);
			country_statuses.push(status);
			country_texts.push(pool.intern(record.country.as_deref().unwrap_or("")));
			facilities.push(vocabulary(&FACILITIES, &record.facility, &record.entity_id)?);
			scheduled.push(record.scheduled_service as u8);
			latitudes.push(record.latitude);
			longitudes.push(record.longitude);
			names.push(pool.intern(&record.name));
			icaos.push(pool.intern(record.icao.as_deref().unwrap_or("")));
			municipalities.push(pool.intern(record.municipality.as_deref().unwrap_or("")));
			regions.push(pool.intern(record.iso_region.as_deref().unwrap_or("")));
			entities.push(pool.intern(&record.entity_id));
		}

		writer.set(
			"columns",
			json!([
				{ "name": "iataKey", "type": "key3", "width": 2 },
				{ "name": "countryAlpha2Key", "type": "key2", "width": 2, "absent": NO_KEY },
				{ "name": "countryStatus", "type": "u8", "width": 1, "values": AIRPORT_COUNTRY_STATUSES },
				{ "name": "countryText", "type": "string", "width": 4 },
				{ "name": "facility", "type": "u8", "width": 1, "values": FACILITIES },
				{ "name": "scheduledService", "type": "u8", "width": 1 },
				{ "name": "latitude", "type": "f64", "width": 8 },
				{ "name": "longitude", "type": "f64", "width": 8 },
				{ "name": "name", "type": "string", "width": 4 },
				{ "name": "icao", "type": "string", "width": 4 },
				{ "name": "municipality", "type": "string", "width": 4 },
				{ "name": "isoRegion", "type": "string", "width": 4 },
				{ "name": "entityID", "type": "string", "width": 4 },
			]),
		);
		writer.set(
			"relations",
			json!([{ "name": "airport-located-in-country", "source": "iso3166-1-alpha2 key", "targets": "airport rows" }]),
		);
		writer.set("rows", json!(rows));
		writer.set("kinds", json!(["airport"]));
		writer.set(
			"coverage",
			json!({ "iata-location": rows, "airport-located-in-country": located_in.values().map(Vec::len).sum::<usize>() }),
		);
		writer.id_table(
			3,
			2,
			iata_keys
				.iter()
				.copied()
				.enumerate()
				.map(|(row, key)| (key, row as u32)),
		)?;
		writer.column(0, 2, rows, u16_column(&iata_keys));
		writer.column(1, 2, rows, u16_column(&country_keys));
		writer.column(2, 1, rows, country_statuses);
		writer.column(3, 4, rows, u32_column(&country_texts));
		writer.column(4, 1, rows, facilities);
		writer.column(5, 1, rows, scheduled);
		writer.column(6, 8, rows, f64_column(&latitudes));
		writer.column(7, 8, rows, f64_column(&longitudes));
		writer.column(8, 4, rows, u32_column(&names));
		writer.column(9, 4, rows, u32_column(&icaos));
		writer.column(10, 4, rows, u32_column(&municipalities));
		writer.column(11, 4, rows, u32_column(&regions));
		writer.column(12, 4, rows, u32_column(&entities));
		writer.pool(&pool);
		writer.relation(0, key::KEY_SPACE_2 as usize, &located_in);
		built.push(Built {
			name: "iata-airport-records".into(),
			bytes: writer.finish(),
		});
	}

	// country-airport-collision
	{
		let airport_set: std::collections::BTreeSet<u32> = iata_keys.iter().copied().collect();
		let collisions: Vec<u32> = current_alpha3
			.iter()
			.copied()
			.filter(|key| airport_set.contains(key))
			.collect();
		let mut writer = Writer::new(
			"country-airport-collision",
			profile,
			&lock,
			&[countries.source.as_str(), airports.source.as_str()],
			&["iso3166-1-alpha3", "iata-location"],
		);
		writer.set(
			"meaning",
			json!("officially assigned iso3166-1-alpha3 codes that are also an iata-location airport code"),
		);
		writer.set(
			"coverage",
			json!({ "collisions": collisions.len(), "iso3166-1-alpha3": current_count, "iata-location": iata_keys.len() }),
		);
		writer.bitset(3, collisions.into_iter());
		built.push(Built {
			name: "country-airport-collision".into(),
			bytes: writer.finish(),
		});
	}

	let _ = (
		countries.normalization_version,
		airports.normalization_version,
		lock.profile,
	);

	Ok(built)
}
