// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! `recognize-build <out-dir>`
//!
//! Validates every family this repository owns and writes one `<family>.json` IR file per family into `out-dir`,
//! printing a JSON array of `{family, hash}` objects. A grammar that fails validation prints its diagnostics, each with
//! the grammar's source file and line, and exits 1.

use std::path::PathBuf;

fn main() {
	let args: Vec<String> = std::env::args().skip(1).collect();

	if args.len() != 1 {
		eprintln!("usage: recognize-build <out-dir>");
		std::process::exit(2);
	}

	let out = PathBuf::from(&args[0]);

	let emitted = recognize_build::emit_repository_families().unwrap_or_else(|diagnostics| {
		eprint!("{}", recognize_build::render_diagnostics(&diagnostics));
		std::process::exit(1);
	});

	std::fs::create_dir_all(&out).unwrap_or_else(|error| {
		eprintln!("{}: {error}", out.display());
		std::process::exit(1);
	});

	let mut written = Vec::new();

	for ir in emitted {
		let path = out.join(ir.file_name());

		std::fs::write(&path, &ir.json).unwrap_or_else(|error| {
			eprintln!("{}: {error}", path.display());
			std::process::exit(1);
		});

		// A family ID is a dotted lowercase name and a hash is hexadecimal, so neither needs escaping.
		written.push(format!(r#"{{"family":"{}","hash":"{}"}}"#, ir.family, ir.hash));
	}

	println!("[{}]", written.join(","));
}
