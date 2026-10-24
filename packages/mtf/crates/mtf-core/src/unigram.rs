// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Derived from Google SentencePiece v0.2.2 `src/unigram_model.cc` (`Model::EncodeOptimized`).
// Copyright 2016 Google Inc. Licensed under the Apache License, Version 2.0
// (`third-party/sentencepiece/LICENSE` in this workspace). Modified: ported from C++ to Rust, with
// a byte trie in place of the darts-clone piece index.

//! The unigram model's piece index and optimized Viterbi search.

use crate::utf8;

const NO_VALUE: i32 = -1;

#[derive(Clone, Copy)]
struct Node {
	/// The first of this node's edges in `ByteTrie::edges`, which are sorted by byte.
	edge_start: u32,
	edge_count: u32,
	value: i32,
}

/// A byte trie mapping piece strings to vocabulary IDs.
///
/// It answers the same prefix queries as upstream's darts-clone index over the same keys, so the
/// search visits candidate pieces in the same order. Nodes and edges live in two flat arrays, and
/// each node's edges are contiguous.
pub struct ByteTrie {
	nodes: Vec<Node>,
	/// `(byte, child node)` pairs.
	edges: Vec<(u8, u32)>,
}

impl ByteTrie {
	/// Builds the trie, or returns the first key that occurs twice.
	///
	/// The keys are sorted once, and each node's subtree is then a contiguous run of them, so the
	/// build visits every key byte once and allocates only the two arrays.
	pub fn build(mut keys: Vec<(&[u8], i32)>) -> Result<Self, &[u8]> {
		keys.sort_unstable_by(|a, b| a.0.cmp(b.0));
		if let Some(pair) = keys.windows(2).find(|pair| pair[0].0 == pair[1].0) {
			return Err(pair[0].0);
		}
		let mut nodes = vec![Node {
			edge_start: 0,
			edge_count: 0,
			value: NO_VALUE,
		}];
		let mut edges = Vec::new();
		// Each pending entry is (node index, key range, depth) for a node whose edges are unwritten.
		let mut pending = std::collections::VecDeque::from([(0usize, 0usize, keys.len(), 0usize)]);
		while let Some((node, mut lo, hi, depth)) = pending.pop_front() {
			// In sorted order the key that ends at this node precedes every key that extends it.
			if lo < hi && keys[lo].0.len() == depth {
				nodes[node].value = keys[lo].1;
				lo += 1;
			}
			nodes[node].edge_start = edges.len() as u32;
			while lo < hi {
				let byte = keys[lo].0[depth];
				let mut end = lo + 1;
				while end < hi && keys[end].0[depth] == byte {
					end += 1;
				}
				let child = nodes.len();
				nodes.push(Node {
					edge_start: 0,
					edge_count: 0,
					value: NO_VALUE,
				});
				edges.push((byte, child as u32));
				pending.push_back((child, lo, end, depth + 1));
				lo = end;
			}
			nodes[node].edge_count = edges.len() as u32 - nodes[node].edge_start;
		}
		Ok(Self { nodes, edges })
	}

	/// The value stored for exactly `key`.
	pub fn get(&self, key: &[u8]) -> Option<i32> {
		let mut node = 0usize;
		for &b in key {
			node = self.child(node, b)?;
		}
		Some(self.nodes[node].value).filter(|&v| v != NO_VALUE)
	}

	fn child(&self, node: usize, b: u8) -> Option<usize> {
		let n = self.nodes[node];
		let edges = &self.edges[n.edge_start as usize..(n.edge_start + n.edge_count) as usize];
		edges
			.binary_search_by_key(&b, |&(c, _)| c)
			.ok()
			.map(|i| edges[i].1 as usize)
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
