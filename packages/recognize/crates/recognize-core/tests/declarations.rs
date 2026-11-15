// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The Rust build refuses a terminal that lacks its bindings: a validator ID with no bound type, and captures with no
//! payload variant. Each case is a program that must not compile, and the bound case must.

#[test]
fn a_terminal_without_its_bindings_fails_the_rust_build() {
	let cases = trybuild::TestCases::new();

	cases.pass("tests/ui/bound.rs");
	cases.compile_fail("tests/ui/unbound_validator.rs");
	cases.compile_fail("tests/ui/captures_without_payload.rs");
}
