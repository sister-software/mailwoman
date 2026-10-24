// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Prints the median model load time over repeated loads of the model at the path in argv[1].

fn main() {
	let path = std::env::args().nth(1).expect("usage: load_profile <tokenizer.model>");
	let bytes = std::fs::read(&path).expect("model is readable");
	let mut times = Vec::new();
	for _ in 0..15 {
		let start = std::time::Instant::now();
		let processor = mtf_core::Processor::from_model_proto(&bytes).expect("model loads");
		times.push(start.elapsed().as_secs_f64() * 1000.0);
		std::hint::black_box(processor);
	}
	times.sort_by(|a, b| a.partial_cmp(b).unwrap());
	println!(
		"load median {:.2} ms (min {:.2}, max {:.2})",
		times[7], times[0], times[14]
	);
}
