// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from Planetiler 0.10.2's LoopLineMerger (Apache-2.0, Copyright Michael Barry and Oliver Wipfli).

//! Merging a tile's line pieces into longer lines, as Planetiler's `LoopLineMerger` does.
//!
//! Points are snapped to the 1/16-pixel grid and lines are split wherever they share an interior point, giving a graph
//! of nodes and edges. The graph is then reduced in fixed stages: edges meeting at a node of degree two are joined,
//! loops shorter than the loop minimum keep only their shortest path, short dangling stubs are removed, edges are
//! simplified between nodes, duplicate edges are dropped, the straightest pairs of edges at each junction are joined,
//! and edges shorter than the minimum are removed.
//!
//! Every edge is stored with its reverse, and node edge lists keep Java's insertion order, so each stage visits edges
//! in the order the Java code does.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};
use std::f64::consts::PI;

use hrt_render::geom::java_round;

type Xy = [f64; 2];

/// A binary heap that adds and removes exactly as `java.util.PriorityQueue` does, so equal elements leave in the
/// same order.
struct JavaQueue<T> {
	items: Vec<T>,
}

impl<T: Copy> JavaQueue<T> {
	fn new() -> Self {
		JavaQueue { items: Vec::new() }
	}

	fn offer(&mut self, item: T, compare: &impl Fn(&T, &T) -> Ordering) {
		let mut k = self.items.len();
		self.items.push(item);
		while k > 0 {
			let parent = (k - 1) >> 1;
			if compare(&item, &self.items[parent]) != Ordering::Less {
				break;
			}
			self.items[k] = self.items[parent];
			k = parent;
		}
		self.items[k] = item;
	}

	fn poll(&mut self, compare: &impl Fn(&T, &T) -> Ordering) -> Option<T> {
		if self.items.is_empty() {
			return None;
		}
		let result = self.items[0];
		let last = self.items.pop().unwrap();
		let n = self.items.len();
		if n > 0 {
			let mut k = 0;
			let half = n >> 1;
			while k < half {
				let mut child = 2 * k + 1;
				let right = child + 1;
				if right < n && compare(&self.items[child], &self.items[right]) == Ordering::Greater {
					child = right;
				}
				if compare(&last, &self.items[child]) != Ordering::Greater {
					break;
				}
				self.items[k] = self.items[child];
				k = child;
			}
			self.items[k] = last;
		}
		Some(result)
	}

	fn is_empty(&self) -> bool {
		self.items.is_empty()
	}
}

struct Node {
	coordinate: Xy,
	edges: Vec<usize>,
}

struct Edge {
	from: usize,
	to: usize,
	length: f64,
	main: bool,
	removed: bool,
	reversed: usize,
	coordinates: Vec<Xy>,
}

/// The merger's settings, named as Planetiler's setters name them.
#[derive(Clone, Copy, Debug)]
pub struct LineMergerSettings {
	pub min_length: f64,
	pub loop_min_length: f64,
	pub stub_min_length: f64,
	pub tolerance: f64,
	pub merge_strokes: bool,
}

fn distance(a: Xy, b: Xy) -> f64 {
	(a[0] - b[0]).hypot(a[1] - b[1])
}

fn snap(value: f64) -> f64 {
	java_round(value * 16.0) / 16.0
}

fn key(point: Xy) -> (u64, u64) {
	(point[0].to_bits(), point[1].to_bits())
}

fn normalize(mut angle: f64) -> f64 {
	while angle > PI {
		angle -= 2.0 * PI;
	}
	while angle <= -PI {
		angle += 2.0 * PI;
	}
	angle
}

struct Graph {
	nodes: Vec<Node>,
	edges: Vec<Edge>,
	/// The nodes in Java's `output` list order; a node with no edges is dropped from it after each degree-two pass.
	output: Vec<usize>,
	settings: LineMergerSettings,
}

impl Graph {
	fn add_edge_to_node(&mut self, node: usize, edge: usize) {
		let coordinates = &self.edges[edge].coordinates;
		if self.nodes[node]
			.edges
			.iter()
			.any(|&other| self.edges[other].coordinates == *coordinates)
		{
			return;
		}
		self.nodes[node].edges.push(edge);
	}

	fn remove_edge_from_node(&mut self, node: usize, edge: usize) {
		if let Some(position) = self.nodes[node].edges.iter().position(|&other| other == edge) {
			self.nodes[node].edges.remove(position);
		}
	}

	/// Creates an edge and its reverse, returning the forward edge.
	fn new_edge(&mut self, from: usize, to: usize, coordinates: Vec<Xy>, length: f64) -> usize {
		let forward = self.edges.len();
		let backward = forward + 1;
		let reversed: Vec<Xy> = coordinates.iter().rev().copied().collect();
		self.edges.push(Edge {
			from,
			to,
			length,
			main: true,
			removed: false,
			reversed: backward,
			coordinates,
		});
		self.edges.push(Edge {
			from: to,
			to: from,
			length,
			main: false,
			removed: false,
			reversed: forward,
			coordinates: reversed,
		});
		forward
	}

	fn remove(&mut self, edge: usize) {
		if !self.edges[edge].removed {
			let (from, to, reversed) = (self.edges[edge].from, self.edges[edge].to, self.edges[edge].reversed);
			self.remove_edge_from_node(from, edge);
			self.remove_edge_from_node(to, reversed);
			self.edges[edge].removed = true;
		}
	}

	fn is_loop(&self, edge: usize) -> bool {
		self.edges[edge].from == self.edges[edge].to
	}

	fn merge_two_edges(&mut self, node: usize, edge1: usize, edge2: usize) -> usize {
		// Keep the direction of the original line: the reverse edge goes first.
		let (a, b) = if self.edges[edge1].main {
			(edge2, edge1)
		} else {
			(edge1, edge2)
		};
		self.remove_edge_from_node(node, a);
		self.remove_edge_from_node(node, b);
		let mut coordinates: Vec<Xy> = self.edges[a].coordinates.iter().rev().copied().collect();
		coordinates.extend_from_slice(&self.edges[b].coordinates[1..]);
		let (a_to, b_to) = (self.edges[a].to, self.edges[b].to);
		let length = self.edges[a].length + self.edges[b].length;
		let merged = self.new_edge(a_to, b_to, coordinates, length);
		let a_reversed = self.edges[a].reversed;
		let b_reversed = self.edges[b].reversed;
		self.remove_edge_from_node(a_to, a_reversed);
		self.remove_edge_from_node(b_to, b_reversed);
		self.add_edge_to_node(a_to, merged);
		if a_to != b_to {
			let merged_reversed = self.edges[merged].reversed;
			self.add_edge_to_node(b_to, merged_reversed);
		}
		merged
	}

	fn degree_two_merge_node(&mut self, node: usize) -> Option<usize> {
		if self.nodes[node].edges.len() == 2 {
			let a = self.nodes[node].edges[0];
			let b = self.nodes[node].edges[1];
			if !self.is_loop(a) && !self.is_loop(b) {
				return Some(self.merge_two_edges(node, a, b));
			}
		}
		None
	}

	fn degree_two_merge(&mut self) {
		for index in 0..self.output.len() {
			let node = self.output[index];
			self.degree_two_merge_node(node);
		}
		let nodes = &self.nodes;
		self.output.retain(|&node| !nodes[node].edges.is_empty());
	}

	fn angle_to(&self, edge: usize, other: usize) -> f64 {
		let a = &self.edges[edge].coordinates;
		let b = &self.edges[other].coordinates;
		let angle = (a[1][1] - a[0][1]).atan2(a[1][0] - a[0][0]);
		let angle_other = (b[1][1] - b[0][1]).atan2(b[1][0] - b[0][0]);
		normalize(angle - angle_other).abs()
	}

	fn stroke_merge(&mut self) {
		for index in 0..self.output.len() {
			let node = self.output[index];
			let edges = self.nodes[node].edges.clone();
			if edges.len() < 2 {
				continue;
			}
			let mut pairs: Vec<(usize, usize, f64)> = Vec::new();
			for i in 0..edges.len() {
				for j in i + 1..edges.len() {
					if edges[i] != self.edges[edges[j]].reversed {
						pairs.push((edges[i], edges[j], self.angle_to(edges[i], edges[j])));
					}
				}
			}
			// Java sorts stably by angle and then walks the list from the end.
			pairs.sort_by(|a, b| a.2.total_cmp(&b.2));
			let mut merged: Vec<usize> = Vec::new();
			for &(a, b, _) in pairs.iter().rev() {
				if merged.contains(&a) || merged.contains(&b) {
					continue;
				}
				let from = self.edges[a].from;
				self.merge_two_edges(from, a, b);
				merged.push(a);
				merged.push(b);
			}
		}
	}

	fn shortest_distance(&self, start: usize, end: usize, exclude: usize, max_length: f64) -> f64 {
		// The heuristic is the straight-line distance, which never overestimates, so the first time the end node leaves
		// the queue its length is the shortest; tie order among queue entries cannot change the result.
		#[derive(PartialEq)]
		struct Candidate {
			node: usize,
			length: f64,
			min_total: f64,
		}
		impl Eq for Candidate {}
		impl Ord for Candidate {
			fn cmp(&self, other: &Self) -> Ordering {
				other.min_total.total_cmp(&self.min_total)
			}
		}
		impl PartialOrd for Candidate {
			fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
				Some(self.cmp(other))
			}
		}
		let mut best: HashMap<usize, f64> = HashMap::new();
		let mut frontier = BinaryHeap::new();
		if exclude != start {
			frontier.push(Candidate {
				node: start,
				length: 0.0,
				min_total: distance(self.nodes[start].coordinate, self.nodes[end].coordinate),
			});
		}
		while let Some(candidate) = frontier.pop() {
			if candidate.node == end {
				return candidate.length;
			}
			for &edge in &self.nodes[candidate.node].edges {
				let neighbor = self.edges[edge].to;
				if neighbor == exclude {
					continue;
				}
				let length = candidate.length + self.edges[edge].length;
				if length < best.get(&neighbor).copied().unwrap_or(f64::INFINITY) {
					best.insert(neighbor, length);
					let min_total = length + distance(self.nodes[neighbor].coordinate, self.nodes[end].coordinate);
					if min_total <= max_length {
						frontier.push(Candidate {
							node: neighbor,
							length,
							min_total,
						});
					}
				}
			}
		}
		f64::INFINITY
	}

	fn break_loops(&mut self) {
		let loop_min = self.settings.loop_min_length;
		for index in 0..self.output.len() {
			let node = self.output[index];
			if self.nodes[node].edges.len() <= 1 {
				continue;
			}
			for current in self.nodes[node].edges.clone() {
				if !self.nodes[node].edges.contains(&current) {
					continue;
				}
				let mut loops: Vec<(usize, f64)> = Vec::new();
				for &other in &self.nodes[node].edges {
					let to = self.edges[other].to;
					let distance = self.edges[other].length
						+ self.shortest_distance(
							to,
							self.edges[current].to,
							self.edges[current].from,
							loop_min - self.edges[other].length,
						);
					if distance <= loop_min {
						loops.push((other, distance));
					}
				}
				if loops.len() > 1 {
					// Stream.min keeps the first of equal elements.
					let mut min = 0;
					for (position, entry) in loops.iter().enumerate() {
						if entry.1 < loops[min].1 {
							min = position;
						}
					}
					for (position, &(edge, _)) in loops.iter().enumerate() {
						if position != min {
							self.remove(edge);
						}
					}
				}
			}
		}
	}

	fn is_short_stub(&self, edge: usize) -> bool {
		let e = &self.edges[edge];
		!e.removed
			&& e.length < self.settings.stub_min_length
			&& (self.nodes[e.from].edges.len() == 1 || self.nodes[e.to].edges.len() == 1 || e.from == e.to)
	}

	fn remove_short_stub_edges(&mut self) {
		let compare = |a: &(f64, usize), b: &(f64, usize)| a.0.total_cmp(&b.0);
		let mut queue: JavaQueue<(f64, usize)> = JavaQueue::new();
		for index in 0..self.output.len() {
			let node = self.output[index];
			for &edge in &self.nodes[node].edges {
				if self.is_short_stub(edge) {
					queue.offer((self.edges[edge].length, edge), &compare);
				}
			}
		}
		while !queue.is_empty() {
			let (_, edge) = queue.poll(&compare).unwrap();
			if self.edges[edge].removed {
				continue;
			}
			if self.is_short_stub(edge) {
				self.remove(edge);
			}
			let (from, to) = (self.edges[edge].from, self.edges[edge].to);
			if let Some(merged) = self.degree_two_merge_node(from) {
				queue.offer((self.edges[merged].length, merged), &compare);
			}
			if self.nodes[from].edges.len() == 1 {
				let other = self.nodes[from].edges[0];
				if self.is_short_stub(other) {
					queue.offer((self.edges[other].length, other), &compare);
				}
			}
			if from != to {
				if let Some(merged) = self.degree_two_merge_node(to) {
					queue.offer((self.edges[merged].length, merged), &compare);
				}
				if self.nodes[to].edges.len() == 1 {
					let other = self.nodes[to].edges[0];
					if self.is_short_stub(other) {
						queue.offer((self.edges[other].length, other), &compare);
					}
				}
			}
		}
	}

	fn remove_short_edges(&mut self) {
		for index in 0..self.output.len() {
			let node = self.output[index];
			for edge in self.nodes[node].edges.clone() {
				if self.edges[edge].length < self.settings.min_length {
					self.remove(edge);
				}
			}
		}
	}

	fn simplify(&mut self) {
		let mut to_remove = Vec::new();
		for index in 0..self.output.len() {
			let node = self.output[index];
			for position in 0..self.nodes[node].edges.len() {
				let edge = self.nodes[node].edges[position];
				if !self.edges[edge].main {
					continue;
				}
				let simplified = simplify_list(&self.edges[edge].coordinates, self.settings.tolerance);
				let reversed = self.edges[edge].reversed;
				self.edges[reversed].coordinates = simplified.iter().rev().copied().collect();
				self.edges[edge].coordinates = simplified;
				let coordinates = &self.edges[edge].coordinates;
				let collapsed = coordinates.len() < 2 || (coordinates.len() == 2 && coordinates[0] == coordinates[1]);
				if collapsed {
					to_remove.push(edge);
				}
			}
		}
		for edge in to_remove {
			self.remove(edge);
		}
	}

	fn remove_duplicated_edges(&mut self) {
		for index in 0..self.output.len() {
			let node = self.output[index];
			let edges = &self.nodes[node].edges;
			let mut to_remove = Vec::new();
			for i in 0..edges.len() {
				for j in i + 1..edges.len() {
					let (a, b) = (edges[i], edges[j]);
					if self.edges[b].to == self.edges[a].to && self.edges[a].coordinates == self.edges[b].coordinates {
						to_remove.push(b);
					}
				}
			}
			for edge in to_remove {
				self.remove(edge);
			}
		}
	}
}

/// Planetiler's Douglas-Peucker over a coordinate list, as a line: two points at least, the ends always kept.
fn simplify_list(coordinates: &[Xy], tolerance: f64) -> Vec<Xy> {
	if coordinates.len() <= 2 {
		return coordinates.to_vec();
	}
	let line = hrt_render::Geom::LineString(coordinates.to_vec());
	match hrt_render::simplify::douglas_peucker(&line, tolerance) {
		hrt_render::Geom::LineString(simplified) => simplified,
		_ => coordinates.to_vec(),
	}
}

/// Splits snapped lines at every interior point that more than one line passes through.
fn node_lines(input: &[Vec<Xy>]) -> Vec<Vec<Xy>> {
	let mut counts: HashMap<(u64, u64), usize> = HashMap::new();
	let mut lines = Vec::with_capacity(input.len());
	for line in input {
		let mut snapped: Vec<Xy> = Vec::with_capacity(line.len());
		let mut last: Option<Xy> = None;
		for &[x, y] in line {
			let current = [snap(x), snap(y)];
			if last != Some(current) {
				snapped.push(current);
				*counts.entry(key(current)).or_insert(0) += 1;
			}
			last = Some(current);
		}
		if snapped.len() >= 2 {
			lines.push(snapped);
		}
	}
	let mut out = Vec::with_capacity(lines.len());
	for line in lines {
		let mut start = 0;
		for i in 1..line.len().saturating_sub(1) {
			if counts[&key(line[i])] > 1 {
				out.push(line[start..=i].to_vec());
				start = i;
			}
		}
		out.push(line[start..].to_vec());
	}
	out
}

/// Merges `lines`, in tile pixels, and returns the merged lines in Planetiler's output order.
pub fn merge_lines(lines: &[Vec<Xy>], settings: LineMergerSettings) -> Vec<Vec<Xy>> {
	let mut graph = Graph {
		nodes: Vec::new(),
		edges: Vec::new(),
		output: Vec::new(),
		settings,
	};
	let mut by_point: HashMap<(u64, u64), usize> = HashMap::new();
	for line in node_lines(lines) {
		let mut node_for = |graph: &mut Graph, point: Xy| {
			*by_point.entry(key(point)).or_insert_with(|| {
				graph.nodes.push(Node {
					coordinate: point,
					edges: Vec::new(),
				});
				let node = graph.nodes.len() - 1;
				graph.output.push(node);
				node
			})
		};
		let first = node_for(&mut graph, line[0]);
		let last = node_for(&mut graph, line[line.len() - 1]);
		let length = line.windows(2).map(|pair| distance(pair[0], pair[1])).sum();
		let edge = graph.new_edge(first, last, line, length);
		graph.add_edge_to_node(first, edge);
		if first != last {
			let reversed = graph.edges[edge].reversed;
			graph.add_edge_to_node(last, reversed);
		}
	}

	graph.degree_two_merge();
	if settings.loop_min_length > 0.0 {
		graph.break_loops();
		graph.degree_two_merge();
	}
	if settings.stub_min_length > 0.0 {
		graph.remove_short_stub_edges();
	}
	if settings.tolerance >= 0.0 {
		graph.simplify();
		graph.remove_duplicated_edges();
		graph.degree_two_merge();
	}
	if settings.merge_strokes {
		graph.stroke_merge();
		graph.degree_two_merge();
	}
	if settings.min_length > 0.0 {
		graph.remove_short_edges();
	}

	let mut out = Vec::new();
	for &node in &graph.output {
		for &edge in &graph.nodes[node].edges {
			if graph.edges[edge].main {
				out.push(graph.edges[edge].coordinates.clone());
			}
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	fn settings() -> LineMergerSettings {
		LineMergerSettings {
			min_length: 0.5,
			loop_min_length: 0.5,
			stub_min_length: 0.5,
			tolerance: 0.2,
			merge_strokes: true,
		}
	}

	#[test]
	fn lines_meeting_end_to_end_merge_into_one() {
		let merged = merge_lines(
			&[vec![[0.0, 0.0], [10.0, 0.0]], vec![[10.0, 0.0], [20.0, 0.0]]],
			settings(),
		);
		assert_eq!(merged, vec![vec![[0.0, 0.0], [20.0, 0.0]]]);
	}

	#[test]
	fn the_straightest_pair_at_a_junction_continues_through_it() {
		// A straight east-west line crossed at its midpoint by a north-south stub of the same length.
		let merged = merge_lines(
			&[
				vec![[0.0, 10.0], [10.0, 10.0]],
				vec![[10.0, 10.0], [20.0, 10.0]],
				vec![[10.0, 10.0], [10.0, 0.0]],
			],
			settings(),
		);
		assert_eq!(merged.len(), 2);
		assert!(merged.iter().any(
			|line| line.first() == Some(&[0.0, 10.0]) && line.last() == Some(&[20.0, 10.0])
				|| line.first() == Some(&[20.0, 10.0]) && line.last() == Some(&[0.0, 10.0])
		));
	}

	#[test]
	fn short_stubs_are_removed() {
		let merged = merge_lines(
			&[
				vec![[0.0, 0.0], [10.0, 0.0], [20.0, 0.0]],
				vec![[10.0, 0.0], [10.0, 0.25]],
			],
			settings(),
		);
		assert_eq!(merged, vec![vec![[0.0, 0.0], [20.0, 0.0]]]);
	}

	#[test]
	fn the_java_queue_sifts_like_java() {
		let compare = |a: &u32, b: &u32| a.cmp(b);
		let mut queue = JavaQueue::new();
		for value in [5, 3, 8, 1, 9, 2] {
			queue.offer(value, &compare);
		}
		let mut out = Vec::new();
		while let Some(value) = queue.poll(&compare) {
			out.push(value);
		}
		assert_eq!(out, vec![1, 2, 3, 5, 8, 9]);
	}
}
