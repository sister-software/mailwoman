// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Conformance of the reader against the fixture profile and against a set oracle built from the
//! normalized JSON, plus the refusals the layout requires.

use registry_core::key;
use registry_core::lookup::{classify_many, mask, Bitset, Column, IdTable, Relation, StringPool};
use registry_core::{Artifact, Error};
use std::collections::BTreeSet;

const COUNTRIES: &str = include_str!("../../../test/fixtures/normalized/iso3166-1.json");
const AIRPORTS: &str = include_str!("../../../test/fixtures/normalized/iata-airports.json");
const LOCK: &str = include_str!("../../../test/fixtures/normalized/sources.lock.json");

fn built() -> Vec<registry_build::Built> {
	registry_build::compile(COUNTRIES, AIRPORTS, LOCK).expect("the fixture compiles")
}

fn artifact<'a>(built: &'a [registry_build::Built], name: &str) -> &'a [u8] {
	&built
		.iter()
		.find(|item| item.name == name)
		.expect("a named artifact")
		.bytes
}

/// The committed fixture artifacts equal a fresh compile byte for byte.
#[test]
fn committed_fixture_artifacts_are_reproducible() {
	for item in built() {
		let path = format!(
			"{}/../../test/fixtures/artifacts/{}.rgy1",
			env!("CARGO_MANIFEST_DIR"),
			item.name
		);
		let committed = std::fs::read(&path).expect("a committed fixture artifact");

		assert_eq!(
			committed, item.bytes,
			"{} differs from the committed fixture",
			item.name
		);
	}
}

/// Every bit of the collision bitset equals the intersection of the two membership oracles.
#[test]
fn collision_bitset_matches_set_oracle_over_every_key() {
	let built = built();
	let countries: serde_json::Value = serde_json::from_str(COUNTRIES).unwrap();
	let airports: serde_json::Value = serde_json::from_str(AIRPORTS).unwrap();

	let current: BTreeSet<u32> = countries["records"]
		.as_array()
		.unwrap()
		.iter()
		.filter(|record| record["status"] == "officially-assigned")
		.map(|record| key::encode3(record["alpha3"].as_str().unwrap().as_bytes()).unwrap())
		.collect();
	let codes: BTreeSet<u32> = airports["records"]
		.as_array()
		.unwrap()
		.iter()
		.map(|record| key::encode3(record["iata"].as_str().unwrap().as_bytes()).unwrap())
		.collect();

	let collision = Artifact::parse(artifact(&built, "country-airport-collision")).unwrap();
	let alpha3 = Artifact::parse(artifact(&built, "iso3166-1-alpha3-membership")).unwrap();
	let airport = Artifact::parse(artifact(&built, "iata-airport-membership")).unwrap();
	let collision = Bitset::from_artifact(&collision).unwrap();
	let alpha3 = Bitset::from_artifact(&alpha3).unwrap();
	let airport = Bitset::from_artifact(&airport).unwrap();

	for k in 0..key::KEY_SPACE_3 {
		assert_eq!(alpha3.test(k), current.contains(&k), "alpha3 bit {k}");
		assert_eq!(airport.test(k), codes.contains(&k), "airport bit {k}");
		assert_eq!(
			collision.test(k),
			current.contains(&k) && codes.contains(&k),
			"collision bit {k}"
		);
	}

	assert_eq!(
		collision.len(),
		2,
		"AUS and FRA collide in the fixture; DDR is former and does not"
	);
	assert_eq!(collision.bits_len(), 2197);
}

trait BitsLen {
	fn bits_len(&self) -> usize;
}

impl BitsLen for Bitset<'_> {
	fn bits_len(&self) -> usize {
		(key::KEY_SPACE_3 as usize).div_ceil(8)
	}
}

/// The batch classifier agrees with the scalar bitsets and marks malformed codes.
#[test]
fn classify_many_matches_scalar_lookups() {
	let built = built();
	let country = Artifact::parse(artifact(&built, "iso3166-1-alpha3-membership")).unwrap();
	let airport = Artifact::parse(artifact(&built, "iata-airport-membership")).unwrap();
	let collision = Artifact::parse(artifact(&built, "country-airport-collision")).unwrap();
	let country = Bitset::from_artifact(&country).unwrap();
	let airport = Bitset::from_artifact(&airport).unwrap();
	let collision = Bitset::from_artifact(&collision).unwrap();

	let packed = b"AUSFRAGBRLHRDDRaus1ZZZZZ";
	let mut out = [0xAAu8; 8];
	let written = classify_many(&country, &airport, &collision, packed, 8, &mut out).unwrap();

	assert_eq!(written, 8);
	assert_eq!(out[0], mask::COUNTRY | mask::AIRPORT | mask::COLLISION, "AUS");
	assert_eq!(out[1], mask::COUNTRY | mask::AIRPORT | mask::COLLISION, "FRA");
	assert_eq!(out[2], mask::COUNTRY, "GBR");
	assert_eq!(out[3], mask::AIRPORT, "LHR");
	assert_eq!(out[4], 0, "DDR is a former code and no airport");
	assert_eq!(out[5], mask::INVALID, "aus");
	assert_eq!(out[6], mask::INVALID, "1ZZ");
	assert_eq!(out[7], mask::AIRPORT, "ZZZ");

	let mut small = [0u8; 2];
	assert_eq!(
		classify_many(&country, &airport, &collision, packed, 8, &mut small),
		Err(Error::Capacity)
	);
	assert_eq!(
		classify_many(&country, &airport, &collision, &packed[..5], 8, &mut out),
		Err(Error::Capacity)
	);
}

/// Records, strings and relations read back what the fixture states.
#[test]
fn records_and_relations_read_back() {
	let built = built();
	let countries = Artifact::parse(artifact(&built, "iso3166-1-records")).unwrap();
	let alpha3 = IdTable::from_artifact(&countries, 3).unwrap();
	let names = Column::from_artifact(&countries, 4).unwrap();
	let status = Column::from_artifact(&countries, 3).unwrap();
	let pool = StringPool::from_artifact(&countries).unwrap();

	let row = alpha3.lookup(b"AUS").unwrap() as usize;
	assert_eq!(pool.get(names.integer(row).unwrap() as usize), Some("Australia"));
	assert_eq!(status.integer(row), Some(0));

	let former = alpha3.lookup(b"DDR").unwrap() as usize;
	assert_eq!(
		status.integer(former),
		Some(1),
		"a former code is readable, with its status"
	);
	assert_eq!(alpha3.lookup(b"XXX"), None);
	assert_eq!(alpha3.lookup(b"aus"), None);

	let airports = Artifact::parse(artifact(&built, "iata-airport-records")).unwrap();
	let iata = IdTable::from_artifact(&airports, 3).unwrap();
	let country_key = Column::from_artifact(&airports, 1).unwrap();
	let latitude = Column::from_artifact(&airports, 6).unwrap();
	let located = Relation::from_artifact(&airports, 0).unwrap();

	let aus = iata.lookup(b"AUS").unwrap() as usize;
	assert_eq!(country_key.integer(aus), key::encode2(b"US"));
	assert!((latitude.double(aus).unwrap() - 30.1945).abs() < 1e-9);

	let us: Vec<u32> = located.targets(key::encode2(b"US").unwrap()).collect();
	assert_eq!(us, vec![iata.lookup(b"AUS").unwrap(), iata.lookup(b"SFO").unwrap()]);
	assert_eq!(
		located.targets(key::encode2(b"FR").unwrap()).count(),
		0,
		"FRA's country is a source extension"
	);

	let prx = iata.lookup(b"PRX").unwrap() as usize;
	assert_eq!(
		country_key.integer(prx),
		Some(registry_build::NO_KEY),
		"an extension country has no key"
	);
}

/// The envelope refusals the layout requires.
#[test]
fn refuses_corrupt_envelopes() {
	let built = built();
	let good = artifact(&built, "country-airport-collision").to_vec();

	assert!(Artifact::parse(&good).is_ok());
	assert_eq!(Artifact::parse(&good[..16]).err(), Some(Error::Truncated));

	let mut magic = good.clone();
	magic[0] = b'P';
	assert_eq!(Artifact::parse(&magic).err(), Some(Error::Magic));

	let mut version = good.clone();
	version[4] = 2;
	assert_eq!(Artifact::parse(&version).err(), Some(Error::Version(2)));

	let mut flags = good.clone();
	flags[6] = 1;
	assert_eq!(Artifact::parse(&flags).err(), Some(Error::Flags(1)));

	let mut reserved = good.clone();
	reserved[28] = 1;
	assert_eq!(Artifact::parse(&reserved).err(), Some(Error::Reserved));

	let mut truncated = good.clone();
	truncated.pop();
	assert_eq!(Artifact::parse(&truncated).err(), Some(Error::Length));

	let mut header = good.clone();
	header[32] = 0xFF;
	assert_eq!(Artifact::parse(&header).err(), Some(Error::HeaderUTF8));

	let mut directory = good.clone();
	let dir = u32::from_le_bytes([good[16], good[17], good[18], good[19]]) as usize;
	directory[dir] = 99;
	assert_eq!(Artifact::parse(&directory).err(), Some(Error::UnknownRequiredKind(99)));

	let mut encoding = good.clone();
	encoding[dir + 2] = 7;
	assert_eq!(Artifact::parse(&encoding).err(), Some(Error::Encoding(1, 7)));

	let mut count = good.clone();
	count[dir + 16] = 0;
	assert_eq!(Artifact::parse(&count).err(), Some(Error::Count(1)));

	let mut misaligned = good.clone();
	misaligned[dir + 8] += 1;
	assert_eq!(Artifact::parse(&misaligned).err(), Some(Error::SectionBounds(0)));

	// The same bytes behind a prefix behave as the standalone bytes do.
	let mut shifted = vec![0u8; 3];
	shifted.extend_from_slice(&good);
	assert!(Artifact::parse(&shifted[3..]).is_ok());
}

/// Two compiles of the same input are byte-identical.
#[test]
fn compile_is_deterministic() {
	let first = built();
	let second = built();

	for (a, b) in first.iter().zip(second.iter()) {
		assert_eq!(a.name, b.name);
		assert_eq!(a.bytes, b.bytes);
	}
}
