// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// A shape whose validator is bound and a shape with no captures compile, and the payload is the validator's output.

mod family {
	recognizer_core::declare_family! {
		family: "bound",
		declarations_hash: "0000000000000000000000000000000000000000000000000000000000000000",
		shapes: {
			Pair = "bound.pair" => {
				captures: [first: Decimal, second: Decimal],
				validator: WGS84Pair,
			},
			Word = "bound.word" => none,
		}
	}
}

fn main() {
	assert_eq!(family::RecognitionKind::ALL.len(), 2);
	assert!(family::RecognitionKind::Pair.validated());
	assert!(!family::RecognitionKind::Word.validated());
	assert_eq!(family::RecognitionKind::Pair.captures(), &[("first", "Decimal"), ("second", "Decimal")]);
}
