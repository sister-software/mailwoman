// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Artifacts: determinism, completeness, the loader's refusals, loading several families into one engine, and the
//! committed artifacts and manifest.

mod support;

use std::path::PathBuf;

use recognize_build::{compile_repository_families, manifest_json, Limits};
use recognize_core::artifact::{assemble, parse, ArtifactError, PatternMeta, Payload};
use recognize_core::grammars::{coordinates, primitives};
use recognize_core::{Engine, Expected, Scope};
use serde_json::Value;

use support::{documents, engine_for};

fn package_path(segments: &[&str]) -> PathBuf {
	let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");

	path.extend(segments);

	path
}

fn built() -> Vec<recognize_build::BuiltFamily> {
	compile_repository_families(&Limits::default()).expect("the repository families compile")
}

fn artifact_of(family: &str) -> Vec<u8> {
	built()
		.into_iter()
		.find(|built| built.ir.family == family)
		.expect("the family exists")
		.compiled
		.artifact
}

#[test]
fn two_builds_are_byte_identical() {
	let first = built();
	let second = built();

	assert_eq!(first, second);
	assert_eq!(
		manifest_json(&first, &Limits::default()),
		manifest_json(&second, &Limits::default())
	);
	assert!(!first.is_empty());
}

#[test]
fn every_declared_shape_is_present_in_the_automata_its_scope_needs() {
	let built = built();

	for document in documents(recognize_core::grammars::families()) {
		let built = built.iter().find(|built| built.ir.family == document.family).unwrap();
		let artifact = parse(&built.compiled.artifact).unwrap();
		let shapes_of = |role| -> Vec<(String, Scope)> {
			artifact
				.header
				.automata
				.iter()
				.filter(|meta| meta.role == role)
				.flat_map(|meta| {
					meta.patterns
						.iter()
						.map(|pattern| (pattern.shape.clone(), pattern.scope))
				})
				.collect()
		};
		let whole = shapes_of(recognize_core::Role::Whole);
		let embedded = shapes_of(recognize_core::Role::Embedded);

		for shape in &document.shapes {
			let entry = (shape.id.clone(), shape.scope);

			assert_eq!(
				whole.contains(&entry),
				matches!(shape.scope, Scope::Whole | Scope::WholeOrEmbedded),
				"{}",
				shape.id
			);
			assert_eq!(
				embedded.contains(&entry),
				matches!(shape.scope, Scope::Embedded | Scope::WholeOrEmbedded),
				"{}",
				shape.id
			);
		}

		assert_eq!(artifact.header.ir_hash, document.hash);
	}
}

#[test]
fn two_families_load_into_one_engine_and_both_report() {
	let engine = engine_for(vec![primitives::family(), coordinates::family()]);

	assert_eq!(engine.family_ids(), vec!["coordinates", "primitives"]);

	let text = "at 40.7128, -74.0060 now";
	let found: Vec<(usize, usize, &str, &str)> = engine
		.search(text)
		.unwrap()
		.into_iter()
		.filter(|candidate| candidate.shape == "coordinate.decimal_pair" || candidate.shape == "word.ascii")
		.map(|candidate| (candidate.start, candidate.end, candidate.family, candidate.shape))
		.collect();

	assert!(
		found.contains(&(3, 20, "coordinates", "coordinate.decimal_pair")),
		"{found:?}"
	);
	assert!(found.contains(&(0, 2, "primitives", "word.ascii")), "{found:?}");
	assert!(found.contains(&(21, 24, "primitives", "word.ascii")), "{found:?}");
}

#[test]
fn a_family_loaded_twice_is_refused() {
	let bytes = artifact_of("primitives");
	let mut engine = Engine::new();

	engine.load(&bytes).unwrap();
	assert_eq!(
		engine.load(&bytes).unwrap_err(),
		ArtifactError::DuplicateFamily("primitives".to_string())
	);
}

#[test]
fn the_loader_does_not_depend_on_where_the_buffer_starts() {
	let bytes = artifact_of("primitives");

	for offset in 0..8 {
		let mut padded = vec![0u8; offset];

		padded.extend_from_slice(&bytes);

		let mut engine = Engine::new();

		engine
			.load(&padded[offset..])
			.unwrap_or_else(|error| panic!("offset {offset}: {error}"));
		assert!(!engine.search("12 ab").unwrap().is_empty());
	}
}

#[test]
fn every_truncation_is_refused() {
	let bytes = artifact_of("coordinates");

	for length in 0..bytes.len() {
		assert!(
			Engine::new().load(&bytes[..length]).is_err(),
			"a {length}-byte prefix loaded"
		);
	}
}

#[test]
fn a_changed_byte_in_a_payload_is_refused_and_a_changed_byte_anywhere_never_panics() {
	let bytes = artifact_of("coordinates");
	let artifact = parse(&bytes).unwrap();
	let start = artifact.payloads[0].bytes.as_ptr() as usize - bytes.as_ptr() as usize;
	let end = {
		let last = artifact.payloads.last().unwrap();

		last.bytes.as_ptr() as usize - bytes.as_ptr() as usize + last.bytes.len()
	};

	for index in 0..bytes.len() {
		let mut changed = bytes.clone();

		changed[index] ^= 0x01;

		let loaded = Engine::new().load(&changed);

		if (start..end).contains(&index) {
			assert!(loaded.is_err(), "a change at payload byte {index} loaded");
		}
	}
}

#[test]
fn a_file_from_another_compiler_or_another_declarations_hash_is_refused() {
	let bytes = artifact_of("primitives");
	let artifact = parse(&bytes).unwrap();
	let mut other_compiler = artifact.header.clone();

	other_compiler.compiler_version = "0.0.0-other".to_string();

	let payloads: Vec<Payload<'_>> = artifact.payloads.clone();

	// The writer refuses a header the reader would refuse, so build the bytes by editing the committed text.
	assert!(assemble(&other_compiler, &payloads).is_err());

	let mut edited = bytes.clone();
	let version = recognize_core::artifact::COMPILER_VERSION.as_bytes();
	let at = bytes
		.windows(version.len())
		.position(|window| window == version)
		.unwrap();

	// The same length keeps the header canonical, so the version check is what refuses it.
	edited[at + version.len() - 1] ^= 0x01;

	assert!(matches!(
		Engine::new().load(&edited).unwrap_err(),
		ArtifactError::CompilerVersion { .. }
	));

	let mut engine = Engine::new();

	assert!(matches!(
		engine
			.load_checked(
				&bytes,
				&Expected {
					ir_hash: Some(&"0".repeat(64)),
					declarations_hash: None,
				}
			)
			.unwrap_err(),
		ArtifactError::IRHash { .. }
	));
	assert!(matches!(
		engine
			.load_checked(
				&bytes,
				&Expected {
					ir_hash: None,
					declarations_hash: Some(&"1".repeat(64)),
				}
			)
			.unwrap_err(),
		ArtifactError::DeclarationsHash { .. }
	));
	assert!(engine
		.load_checked(
			&bytes,
			&Expected {
				ir_hash: Some(&artifact.header.ir_hash),
				declarations_hash: Some(recognize_core::artifact::DECLARATIONS_HASH_UNSET),
			}
		)
		.is_ok());
}

#[test]
fn an_artifact_of_the_previous_schema_version_is_refused_with_its_version() {
	let mut bytes = artifact_of("primitives");

	bytes[4] = 1;

	assert_eq!(Engine::new().load(&bytes).unwrap_err(), ArtifactError::Version(1));
}

#[test]
fn a_viability_table_with_the_wrong_rows_is_refused_even_when_its_hash_is_updated() {
	let bytes = artifact_of("primitives");
	let artifact = parse(&bytes).unwrap();
	let mut header = artifact.header.clone();
	let mut table = artifact.payloads[0].viability.to_vec();
	let last = table.len() - 1;

	// A change the hash covers is refused by the hash. Recomputing the hash gets past it, and the table's own checks
	// refuse what does not fit the automaton: here, a row count that disagrees with the header.
	table[0] ^= 0x01;
	header.automata[0].viability_sha256 = recognize_core::ir::sha256_hex(&table);

	let mut payloads = artifact.payloads.clone();

	payloads[0].viability = &table;

	let rebuilt = assemble(&header, &payloads).expect("the layout is valid");

	assert!(matches!(
		Engine::new().load(&rebuilt).unwrap_err(),
		ArtifactError::Viability(_)
	));

	// A padding bit set in the last row is refused too.
	let mut padded = artifact.payloads[0].viability.to_vec();

	padded[last] |= 0x80;
	header.automata[0].viability_sha256 = recognize_core::ir::sha256_hex(&padded);
	payloads[0].viability = &padded;

	assert!(matches!(
		Engine::new()
			.load(&assemble(&header, &payloads).expect("the layout is valid"))
			.unwrap_err(),
		ArtifactError::Viability(_)
	));
}

#[test]
fn a_header_that_declares_more_patterns_than_the_dfa_holds_is_refused() {
	let bytes = artifact_of("primitives");
	let artifact = parse(&bytes).unwrap();
	let mut header = artifact.header.clone();

	header.automata[0].patterns.push(PatternMeta {
		scope: Scope::WholeOrEmbedded,
		shape: "extra.shape".to_string(),
	});

	let rebuilt = assemble(&header, &artifact.payloads).expect("the layout is valid");

	assert!(matches!(
		Engine::new().load(&rebuilt).unwrap_err(),
		ArtifactError::PatternCount { .. }
	));
}

#[test]
fn the_committed_artifacts_and_manifest_match_the_compiler() {
	let limits = Limits::default();
	let built = built();

	for family in &built {
		let committed = std::fs::read(package_path(&["data", "artifacts", &family.compiled.file_name()]))
			.unwrap_or_else(|error| {
				panic!(
					"data/artifacts/{} is not committed: {error}",
					family.compiled.file_name()
				)
			});

		assert_eq!(
			committed,
			family.compiled.artifact,
			"run tools/generate.run.ts to regenerate data/artifacts/{}",
			family.compiled.file_name()
		);
	}

	let committed = std::fs::read_to_string(package_path(&["data", "manifests", "artifacts.json"]))
		.expect("data/manifests/artifacts.json is committed");

	// The committed text passed through the repository formatter, so compare what it means.
	assert_eq!(
		serde_json::from_str::<Value>(&committed).unwrap(),
		serde_json::from_str::<Value>(&manifest_json(&built, &limits)).unwrap(),
		"run tools/generate.run.ts to regenerate data/manifests/artifacts.json"
	);
}
