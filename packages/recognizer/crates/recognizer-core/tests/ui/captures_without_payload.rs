// A shape that declares captures and no validator has no payload variant, so the build fails.

mod family {
	recognizer_core::declare_family! {
		family: "unpaid",
		declarations_hash: "0000000000000000000000000000000000000000000000000000000000000000",
		shapes: {
			Thing = "unpaid.thing" => {
				captures: [value: Decimal],
			},
		}
	}
}

fn main() {}
