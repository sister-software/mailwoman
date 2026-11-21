// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! `declare_family!`: the declarations of one family, expanded into a closed kind enum, a typed payload enum and the
//! dispatch from a kind to its validator.
//!
//! `recognizer-build` writes one invocation per family into `src/declared/<family>.rs` from the family's IR, and that
//! file is the family's module. The macro holds the rules that make a missing binding a build failure:
//!
//! * A shape that declares a validator names a type `validators::<ID>` that implements
//!   [`Validator`](crate::validators::Validator). With no such type, the expansion does not compile.
//! * The type's `ID` constant must equal the ID the shape declares, or constant evaluation fails.
//! * A shape that declares captures needs a validator, because the validator's output is the payload variant. A shape
//!   with captures and no validator is a `compile_error!`.
//!
//! The compile-fail tests in `tests/ui` hold each of these.
//!
//! ```text
//! declare_family! {
//!     family: "coordinates",
//!     declarations_hash: "…",
//!     shapes: {
//!         CoordinateDecimalPair = "coordinate.decimal_pair" => {
//!             captures: [latitude: Decimal, longitude: Decimal],
//!             validator: FiniteDecimalPair,
//!         },
//!         WordAscii = "word.ascii" => none,
//!     }
//! }
//! ```

#[macro_export]
macro_rules! declare_family {
	(
		family: $family:literal,
		declarations_hash: $hash:literal,
		shapes: { $( $kind:ident = $shape:literal => $spec:tt ),+ $(,)? }
	) => {
		use $crate::captures::Captures;
		use $crate::recognition::Rejection;

		/// The family's ID.
		pub const FAMILY: &str = $family;

		/// The hash of the family's generated declarations, which its artifact embeds.
		pub const DECLARATIONS_HASH: &str = $hash;

		/// One variant per shape the family declares.
		#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
		pub enum RecognitionKind {
			$( $kind ),+
		}

		impl RecognitionKind {
			/// Every kind, in declaration order.
			pub const ALL: &'static [RecognitionKind] = &[ $( RecognitionKind::$kind ),+ ];

			/// The shape ID the kind stands for.
			pub const fn shape(self) -> &'static str {
				match self {
					$( RecognitionKind::$kind => $shape ),+
				}
			}

			/// The kind of a shape ID, or `None` when the family declares no such shape.
			pub fn from_shape(shape: &str) -> Option<RecognitionKind> {
				match shape {
					$( $shape => Some(RecognitionKind::$kind), )+
					_ => None,
				}
			}

			/// The declared captures as `(path, type)` pairs.
			pub const fn captures(self) -> &'static [(&'static str, &'static str)] {
				match self {
					$( RecognitionKind::$kind => $crate::__declared_captures!($spec) ),+
				}
			}

			/// Whether the shape declares a validator, so its recognitions carry a payload or a rejection.
			pub const fn validated(self) -> bool {
				match self {
					$( RecognitionKind::$kind => $crate::__declared_validated!($spec) ),+
				}
			}
		}

		$crate::__declared_payload! { serializer ; [] [] ; $( $kind => $spec, )+ }

		/// Runs the kind's validator over the captures. `None` means the shape declares no validator.
		#[allow(unused_variables)]
		pub fn bind(kind: RecognitionKind, captures: &Captures<'_>) -> Option<Result<Payload, Rejection>> {
			match kind {
				$( RecognitionKind::$kind => $crate::__declared_bind!($kind, $spec, captures) ),+
			}
		}
	};
}

#[doc(hidden)]
#[macro_export]
macro_rules! __declared_captures {
	(none) => { &[] };
	({ validator: $validator:ident $(,)? }) => { &[] };
	({ captures: [ $( $path:ident : $kind:ident ),* $(,)? ] $(, validator: $validator:ident)? $(,)? }) => {
		&[ $( (stringify!($path), stringify!($kind)) ),* ]
	};
}

#[doc(hidden)]
#[macro_export]
macro_rules! __declared_validated {
	(none) => {
		false
	};
	({ captures: [ $($captures:tt)* ] $(,)? }) => {
		false
	};
	({ $( captures: [ $($captures:tt)* ], )? validator: $validator:ident $(,)? }) => {
		true
	};
}

#[doc(hidden)]
#[macro_export]
macro_rules! __declared_bind {
	($kind:ident, none, $captures:ident) => {
		None
	};
	($kind:ident, { captures: [ $($declared:tt)* ] $(,)? }, $captures:ident) => {
		None
	};
	($kind:ident, { $( captures: [ $($declared:tt)* ], )? validator: $validator:ident $(,)? }, $captures:ident) => {
		Some(<$crate::validators::$validator as $crate::validators::Validator>::validate($captures).map(Payload::$kind))
	};
}

/// Accumulates the payload enum's variants and its serialization arms, one shape at a time.
#[doc(hidden)]
#[macro_export]
macro_rules! __declared_payload {
	( $serializer:ident ; [ $($variants:tt)* ] [ $($arms:tt)* ] ; ) => {
		/// One variant per validated shape, holding the validator's typed output.
		#[derive(Clone, Debug, PartialEq)]
		pub enum Payload {
			$($variants)*
		}

		impl $crate::__serde::Serialize for Payload {
			#[allow(unused_variables)]
			fn serialize<S: $crate::__serde::Serializer>(&self, $serializer: S) -> Result<S::Ok, S::Error> {
				match self {
					$($arms)*
					#[allow(unreachable_patterns)]
					_ => unreachable!(),
				}
			}
		}
	};
	( $serializer:ident ; [ $($variants:tt)* ] [ $($arms:tt)* ] ; $kind:ident => none, $($rest:tt)* ) => {
		$crate::__declared_payload! { $serializer ; [ $($variants)* ] [ $($arms)* ] ; $($rest)* }
	};
	( $serializer:ident ; [ $($variants:tt)* ] [ $($arms:tt)* ] ; $kind:ident => { captures: [ $($declared:tt)* ] $(,)? }, $($rest:tt)* ) => {
		compile_error!(concat!(
			"shape `", stringify!($kind), "` declares captures and no validator, so it has no payload variant"
		));

		$crate::__declared_payload! { $serializer ; [ $($variants)* ] [ $($arms)* ] ; $($rest)* }
	};
	( $serializer:ident ; [ $($variants:tt)* ] [ $($arms:tt)* ] ; $kind:ident => { $( captures: [ $($declared:tt)* ], )? validator: $validator:ident $(,)? }, $($rest:tt)* ) => {
		const _: () = $crate::validators::assert_binding(
			<$crate::validators::$validator as $crate::validators::Validator>::ID,
			stringify!($validator),
		);

		$crate::__declared_payload! {
			$serializer ;
			[
				$($variants)*
				$kind(<$crate::validators::$validator as $crate::validators::Validator>::Output),
			]
			[
				$($arms)*
				Payload::$kind(value) => $crate::__serde::Serialize::serialize(value, $serializer),
			]
			; $($rest)*
		}
	};
}
