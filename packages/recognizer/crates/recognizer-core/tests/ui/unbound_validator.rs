// A shape that declares a validator ID with no binding in `recognizer_core::validators` fails the build.

mod family {
	recognizer_core::declare_family! {
		family: "unbound",
		declarations_hash: "0000000000000000000000000000000000000000000000000000000000000000",
		shapes: {
			Thing = "unbound.thing" => {
				captures: [value: Decimal],
				validator: NoSuchValidator,
			},
		}
	}
}

fn main() {}
