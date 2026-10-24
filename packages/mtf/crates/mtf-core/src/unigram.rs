//! The unigram model's piece index and optimized Viterbi search (upstream `src/unigram_model.cc`,
//! `Model::EncodeOptimized`).

use crate::utf8;

const NO_VALUE: i32 = -1;

struct Node {
	/// Child edges sorted by byte.
	children: Vec<(u8, u32)>,
	value: i32,
}

/// A byte trie mapping piece strings to vocabulary IDs.
///
/// It answers the same prefix queries as upstream's darts-clone index over the same keys, so the
/// search visits candidate pieces in the same order.
pub struct ByteTrie {
	nodes: Vec<Node>,
}

impl ByteTrie {
	pub fn new() -> Self {
		Self {
			nodes: vec![Node {
				children: Vec::new(),
				value: NO_VALUE,
			}],
		}
	}

	pub fn insert(&mut self, key: &[u8], value: i32) {
		let mut node = 0usize;
		for &b in key {
			node = match self.nodes[node].children.binary_search_by_key(&b, |&(c, _)| c) {
				Ok(i) => self.nodes[node].children[i].1 as usize,
				Err(i) => {
					let next = self.nodes.len() as u32;
					self.nodes.push(Node {
						children: Vec::new(),
						value: NO_VALUE,
					});
					self.nodes[node].children.insert(i, (b, next));
					next as usize
				}
			};
		}
		self.nodes[node].value = value;
	}

	fn child(&self, node: usize, b: u8) -> Option<usize> {
		let children = &self.nodes[node].children;
		children
			.binary_search_by_key(&b, |&(c, _)| c)
			.ok()
			.map(|i| children[i].1 as usize)
	}

	/// The length of the longest key that is a prefix of `input`.
	pub fn longest_prefix(&self, input: &[u8]) -> Option<usize> {
		let mut node = 0usize;
		let mut longest = None;
		for (i, &b) in input.iter().enumerate() {
			match self.child(node, b) {
				Some(next) => node = next,
				None => break,
			}
			if self.nodes[node].value != NO_VALUE {
				longest = Some(i + 1);
			}
		}
		longest
	}
}

/// How the search treats one vocabulary entry found in the piece index.
#[derive(Clone, Copy)]
pub enum Candidate {
	/// A normal piece with its log-probability score.
	Scored(f32),
	/// A user-defined symbol, which receives a length bonus so it is always selected.
	UserDefined,
	/// An unused piece, which the search skips.
	Unused,
}

#[derive(Clone, Copy)]
struct BestPathNode {
	id: i32,
	score: f32,
	starts_at: i64,
}

/// Returns the best segmentation of `normalized` as `(start, end, id)` byte ranges.
///
/// `unk_score` and every arithmetic step stay in `f32`, as upstream's do, so near-ties resolve
/// identically.
pub fn encode(
	normalized: &[u8],
	pieces: &ByteTrie,
	candidate: impl Fn(i32) -> Candidate,
	unk_id: i32,
	unk_score: f32,
) -> Vec<(usize, usize, i32)> {
	let size = normalized.len();
	if size == 0 {
		return Vec::new();
	}
	const SCORE_RESET_THRESHOLD: f32 = 100000.0;
	let mut best = vec![
		BestPathNode {
			id: -1,
			score: 0.0,
			starts_at: -1
		};
		size + 1
	];
	let mut starts_at = 0usize;
	let mut max_frontier = 0usize;
	while starts_at < size {
		let mut till_here = best[starts_at].score;
		if !(-SCORE_RESET_THRESHOLD..=SCORE_RESET_THRESHOLD).contains(&till_here) {
			let offset = till_here;
			// Rebase every reached path score at or after this position, which keeps comparisons in
			// f32's precise range on long inputs.
			for (i, node) in best.iter_mut().enumerate().take(max_frontier + 1).skip(starts_at) {
				if i == starts_at || node.starts_at != -1 {
					node.score -= offset;
				}
			}
			till_here = 0.0;
		}
		let mut has_single_node = false;
		let mblen = utf8::one_char_len(normalized[starts_at]).min(size - starts_at);
		let mut node = 0usize;
		let mut key_pos = starts_at;
		while key_pos < size {
			let Some(next) = pieces.child(node, normalized[key_pos]) else {
				break;
			};
			node = next;
			key_pos += 1;
			let id = pieces.nodes[node].value;
			if id == NO_VALUE {
				continue;
			}
			let length = key_pos - starts_at;
			let score = match candidate(id) {
				Candidate::Unused => continue,
				Candidate::Scored(s) => s,
				Candidate::UserDefined => (0.1 * (length as f64 - 1.0)) as f32,
			};
			max_frontier = max_frontier.max(key_pos);
			let total = score + till_here;
			let target = &mut best[key_pos];
			if target.starts_at == -1 || total > target.score {
				*target = BestPathNode {
					id,
					score: total,
					starts_at: starts_at as i64,
				};
			}
			if length == mblen {
				has_single_node = true;
			}
		}
		if !has_single_node {
			max_frontier = max_frontier.max(starts_at + mblen);
			let total = unk_score + till_here;
			let target = &mut best[starts_at + mblen];
			if target.starts_at == -1 || total > target.score {
				*target = BestPathNode {
					id: unk_id,
					score: total,
					starts_at: starts_at as i64,
				};
			}
		}
		starts_at += mblen;
	}

	let mut result = Vec::with_capacity(size / 4 + 1);
	let mut ends_at = size;
	while ends_at > 0 {
		let node = best[ends_at];
		let start = node.starts_at as usize;
		result.push((start, ends_at, node.id));
		ends_at = start;
	}
	result.reverse();
	result
}
