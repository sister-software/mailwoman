// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! `registry-build <countries.json> <airports.json> <sources.lock.json> <out-dir>`
//!
//! Writes one `<name>.rgy1` per artifact into `out-dir` and prints each name with its byte count.
//! The caller computes digests and writes the manifest, so the artifact bytes never contain their own
//! hash.

use std::path::PathBuf;

fn main() {
	let args: Vec<String> = std::env::args().skip(1).collect();

	if args.len() != 4 {
		eprintln!("usage: registry-build <countries.json> <airports.json> <sources.lock.json> <out-dir>");
		std::process::exit(2);
	}

	let read = |path: &str| {
		std::fs::read_to_string(path).unwrap_or_else(|error| {
			eprintln!("{path}: {error}");
			std::process::exit(1);
		})
	};

	let countries = read(&args[0]);
	let airports = read(&args[1]);
	let lock = read(&args[2]);
	let out = PathBuf::from(&args[3]);

	std::fs::create_dir_all(&out).unwrap_or_else(|error| {
		eprintln!("{}: {error}", out.display());
		std::process::exit(1);
	});

	let built = registry_build::compile(&countries, &airports, &lock).unwrap_or_else(|error| {
		eprintln!("{error}");
		std::process::exit(1);
	});

	for artifact in built {
		let path = out.join(format!("{}.rgy1", artifact.name));

		std::fs::write(&path, &artifact.bytes).unwrap_or_else(|error| {
			eprintln!("{}: {error}", path.display());
			std::process::exit(1);
		});

		println!("{}\t{}", artifact.name, artifact.bytes.len());
	}
}
