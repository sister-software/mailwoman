//! Generates the ONNX message types from `proto/onnx.proto` with prost.

fn main() -> Result<(), Box<dyn std::error::Error>> {
	println!("cargo:rerun-if-changed=proto/onnx.proto");
	let descriptors = protox::compile(["proto/onnx.proto"], ["proto"])?;
	prost_build::Config::new().compile_fds(descriptors)?;
	Ok(())
}
