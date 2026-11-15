// A shape that declares a validator ID with no binding in `recognize_core::validators` fails the build.

mod family {
	recognize_core::declare_family! {
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
