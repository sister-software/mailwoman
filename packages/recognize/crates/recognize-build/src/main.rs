// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! `recognize-build [--max-states N] [--build-bytes N] [--dense-bytes N] [--sparse-bytes N] [--max-product-states N] [--definition <file> [--list-overlaps]] <out-dir>`
//!
//! With `--definition`, the tool compiles the one family that JSON file defines, as `recognize_build::definition`
//! documents, and writes its IR, artifact, TypeScript modules, manifest, compiler report and `overlap-witnesses.json`
//! into `out-dir`. The repository's own families are not built, and they are the context of the overlap analysis: an
//! undeclared overlap between the definition's shapes, or with one of theirs, is a build error. A definition that
//! declares a capture, a validator or a handler is refused. With `--list-overlaps` the tool writes nothing and prints
//! every overlapping pair as JSON.
//!
//! Validates, compiles and analyzes every family this repository owns and writes these files into `out-dir`: one
//! `<family>.json` IR file and one `<family>.rca1` artifact per family, the generated declarations (`rust/declared.rs`,
//! `rust/declared/<family>.rs`, `ts/<family>.generated.ts` and `ts/artifacts/<family>.generated.ts`), `artifacts.json`, the build manifest,
//! `compiler-report.json`, the overlap and reachability report, and `overlap-witnesses.json`, the witness for each
//! declared overlapping pair. It prints a JSON array of `{family, hash, sha256}` objects, where `hash` is the IR hash and `sha256` is the artifact's.
//! The flags lower a compiler limit from its default. A grammar that fails validation or exceeds a limit prints its
//! diagnostics, each with the grammar's source file and line, and exits 1.

use std::path::PathBuf;

use recognize_build::Limits;

fn usage() -> ! {
	eprintln!(
		"usage: recognize-build [--max-states N] [--build-bytes N] [--dense-bytes N] [--sparse-bytes N] [--max-product-states N] [--definition <file> [--list-overlaps]] <out-dir>"
	);
	std::process::exit(2);
}

/// Compiles one family defined as data and writes its files into `out`: `<family>.json`, `<family>.rca1`,
/// `ts/<family>.generated.ts`, `ts/artifacts/<family>.generated.ts`, `artifacts.json` and `compiler-report.json`.
/// It prints the same JSON array of `{family, hash, sha256}` objects as a build of the repository's families.
///
/// The repository's own families are the context of the analysis: the definition's shapes may not recognize a string
/// one of theirs recognizes unless the definition declares it, naming the shape by ID. A family with a `fields` reader
/// reports no recognitions and takes no part in that check.
///
/// With `list_overlaps` the tool writes nothing and prints every overlapping pair of the analysis as a JSON array of
/// `{a, b, witness, declared, equivalent}`, which a generator reads to declare the pairs and to group equal languages.
fn build_definition(path: &std::path::Path, out: &std::path::Path, limits: &Limits, list_overlaps: bool) {
	let fail = |message: String| -> ! {
		eprintln!("{message}");
		std::process::exit(1);
	};
	let text = std::fs::read_to_string(path).unwrap_or_else(|error| fail(format!("{}: {error}", path.display())));
	// The IR records the definition's file name as the source of each shape, so a build in any directory writes one text.
	let name = path.file_name().map_or_else(
		|| "definition.json".to_string(),
		|name| name.to_string_lossy().into_owned(),
	);
	let definition = recognize_build::definition::read(&name, &text)
		.unwrap_or_else(|diagnostics| fail(recognize_build::render_diagnostics(&diagnostics)));
	let context: Vec<recognize_core::IrDocument> = recognize_core::grammars::families()
		.into_iter()
		.map(|family| {
			family
				.build()
				.unwrap_or_else(|diagnostics| fail(recognize_build::render_diagnostics(&diagnostics)))
		})
		.collect();
	let silent: std::collections::BTreeSet<String> = definition
		.fields
		.iter()
		.map(|_| definition.document.family.clone())
		.collect();
	let build = recognize_build::build_documents_with(
		vec![definition.document.clone()],
		&context,
		&silent,
		limits,
		!list_overlaps,
	)
	.unwrap_or_else(|diagnostics| fail(recognize_build::render_diagnostics(&diagnostics)));

	if list_overlaps {
		let key = |key: &recognize_build::ShapeKey| serde_json::json!({ "family": key.family, "shape": key.shape });
		let pairs: Vec<serde_json::Value> = build
			.analysis
			.overlaps
			.iter()
			.map(|overlap| {
				serde_json::json!({
					"a": key(&overlap.a),
					"b": key(&overlap.b),
					"witness": overlap.witness,
					"declared": overlap.declared,
					"equivalent": overlap.equivalent,
				})
			})
			.collect();

		println!("{}", serde_json::to_string(&pairs).expect("overlaps serialize"));

		return;
	}

	let family = &build.families[0];
	let declarations = recognize_core::Declarations::from_ir(&definition.document);
	let write = |name: String, bytes: &[u8]| {
		let target = out.join(name);

		if let Some(parent) = target.parent() {
			std::fs::create_dir_all(parent).unwrap_or_else(|error| fail(format!("{}: {error}", parent.display())));
		}

		std::fs::write(&target, bytes).unwrap_or_else(|error| fail(format!("{}: {error}", target.display())));
	};

	write(family.ir.file_name(), family.ir.json.as_bytes());
	write(family.compiled.file_name(), &family.compiled.artifact);
	write(
		format!("ts/{}.generated.ts", family.ir.family),
		recognize_build::codegen::typescript_external_family(&declarations, &definition).as_bytes(),
	);
	write(
		format!("ts/artifacts/{}.generated.ts", family.ir.family),
		recognize_build::codegen::typescript_external_artifact(
			&family.ir.family,
			&family.compiled.artifact,
			&family.compiled.sha256,
			&definition.generator,
		)
		.as_bytes(),
	);
	write(
		"artifacts.json".to_string(),
		recognize_build::manifest_json(&build.families, limits).as_bytes(),
	);
	write("compiler-report.json".to_string(), build.report_json().as_bytes());
	write(
		"overlap-witnesses.json".to_string(),
		recognize_build::report::witnesses_json_of(&build.analysis, Some(&family.ir.family)).as_bytes(),
	);

	println!(
		r#"[{{"family":"{}","hash":"{}","sha256":"{}"}}]"#,
		family.ir.family, family.ir.hash, family.compiled.sha256
	);
}

fn main() {
	let mut limits = Limits::default();
	let mut out = None;
	let mut definition = None;
	let mut list_overlaps = false;
	let mut args = std::env::args().skip(1);

	while let Some(arg) = args.next() {
		if arg == "--list-overlaps" {
			list_overlaps = true;

			continue;
		}

		if arg == "--definition" {
			definition = Some(PathBuf::from(args.next().unwrap_or_else(|| {
				eprintln!("--definition takes the path of a family definition");
				usage()
			})));

			continue;
		}

		let mut number = |name: &str| -> usize {
			args.next().and_then(|value| value.parse().ok()).unwrap_or_else(|| {
				eprintln!("{name} takes a whole number");
				usage()
			})
		};

		match arg.as_str() {
			"--max-states" => limits.max_states = number("--max-states"),
			"--build-bytes" => limits.build_bytes = number("--build-bytes"),
			"--dense-bytes" => limits.dense_bytes = number("--dense-bytes"),
			"--sparse-bytes" => limits.sparse_bytes = number("--sparse-bytes"),
			"--max-product-states" => limits.max_product_states = number("--max-product-states"),
			flag if flag.starts_with("--") => usage(),
			path if out.is_none() => out = Some(PathBuf::from(path)),
			_ => usage(),
		}
	}

	let Some(out) = out else { usage() };

	if let Some(definition) = definition {
		build_definition(&definition, &out, &limits, list_overlaps);

		return;
	}

	let build = recognize_build::build_repository_families(&limits).unwrap_or_else(|diagnostics| {
		eprint!("{}", recognize_build::render_diagnostics(&diagnostics));
		std::process::exit(1);
	});
	let built = &build.families;

	std::fs::create_dir_all(&out).unwrap_or_else(|error| {
		eprintln!("{}: {error}", out.display());
		std::process::exit(1);
	});

	let write = |name: String, bytes: &[u8]| {
		let path = out.join(name);

		if let Some(parent) = path.parent() {
			std::fs::create_dir_all(parent).unwrap_or_else(|error| {
				eprintln!("{}: {error}", parent.display());
				std::process::exit(1);
			});
		}

		std::fs::write(&path, bytes).unwrap_or_else(|error| {
			eprintln!("{}: {error}", path.display());
			std::process::exit(1);
		});
	};
	let mut written = Vec::new();

	for family in built {
		write(family.ir.file_name(), family.ir.json.as_bytes());
		write(family.compiled.file_name(), &family.compiled.artifact);

		// A family ID is a dotted lowercase name and a hash is hexadecimal, so neither needs escaping.
		written.push(format!(
			r#"{{"family":"{}","hash":"{}","sha256":"{}"}}"#,
			family.ir.family, family.ir.hash, family.compiled.sha256
		));
	}

	// Generated declarations: the Rust modules recognize-core compiles and the TypeScript the package ships.
	let declarations: Vec<recognize_core::Declarations> = build
		.documents
		.iter()
		.map(recognize_core::Declarations::from_ir)
		.collect();

	for family in &declarations {
		let artifact = built
			.iter()
			.find(|candidate| candidate.ir.family == family.family)
			.expect("every family was built");
		let generated = recognize_build::codegen::rust_family(family)
			.and_then(|rust| recognize_build::codegen::typescript_family(family).map(|typescript| (rust, typescript)))
			.unwrap_or_else(|message| {
				eprintln!("{}: {message}", family.family);
				std::process::exit(1);
			});

		write(
			format!(
				"rust/declared/{}.rs",
				recognize_build::codegen::module_name(&family.family)
			),
			generated.0.as_bytes(),
		);
		write(format!("ts/{}.generated.ts", family.family), generated.1.as_bytes());
		// The declarations as data: the shapes' kinds, captures, payload fields and rejection codes, which the generated
		// reference documentation reads.
		write(
			format!("declarations/{}.json", family.family),
			format!(
				"{}\n",
				serde_json::to_string_pretty(family).expect("declarations always serialize")
			)
			.as_bytes(),
		);
		write(
			format!("ts/artifacts/{}.generated.ts", family.family),
			recognize_build::codegen::typescript_artifact(
				&family.family,
				&artifact.compiled.artifact,
				&artifact.compiled.sha256,
			)
			.as_bytes(),
		);
	}

	write(
		"rust/declared.rs".to_string(),
		recognize_build::codegen::rust_declared(&declarations).as_bytes(),
	);

	write(
		"artifacts.json".to_string(),
		recognize_build::manifest_json(built, &limits).as_bytes(),
	);
	write("compiler-report.json".to_string(), build.report_json().as_bytes());
	write("overlap-witnesses.json".to_string(), build.witnesses_json().as_bytes());

	println!("[{}]", written.join(","));
}
