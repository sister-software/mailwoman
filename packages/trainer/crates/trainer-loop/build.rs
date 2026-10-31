//! Gives the crate's tests an rpath to libtorch's shared libraries, so they load with no `LD_LIBRARY_PATH`.
//!
//! `LIBTORCH` is the root the root `.cargo/config.toml` sets, or the one the environment sets in its place.

fn main() {
	println!("cargo:rerun-if-env-changed=LIBTORCH");
	if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
		return;
	}
	if let Some(root) = std::env::var_os("LIBTORCH") {
		let lib = std::path::PathBuf::from(root).join("lib");
		println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib.display());
	}
}
