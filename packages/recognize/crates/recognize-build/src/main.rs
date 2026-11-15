// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! `recognize-build [--max-states N] [--build-bytes N] [--dense-bytes N] [--sparse-bytes N] [--max-product-states N] <out-dir>`
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
		"usage: recognize-build [--max-states N] [--build-bytes N] [--dense-bytes N] [--sparse-bytes N] [--max-product-states N] <out-dir>"
	);
	std::process::exit(2);
}

fn main() {
	let mut limits = Limits::default();
	let mut out = None;
	let mut args = std::env::args().skip(1);

	while let Some(arg) = args.next() {
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
