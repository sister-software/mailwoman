// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Planetiler's two reading passes over a PBF file.
//!
//! Pass 1 stores every node's packed location, records which ways belong to a multipolygon relation, and keeps the
//! relations the profile asks for, with the membership of each way and relation in them. Pass 2 turns tagged nodes and
//! every way into source features. It keeps the node lists of multipolygon member ways, then assembles the
//! multipolygon relations once every way has been read.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use geo::{Coord, Geometry, LineString, Point, Polygon};
use osmpbf::Element;
use rayon::prelude::*;

use crate::coords::{decode_world, encode_flat_location, nano_to_degrees};
use crate::elements::{ElementKind, Relation, Tags};
use crate::multipolygon::{self, MultipolygonError};
use crate::nodes::NodeStore;

/// The relation a feature belongs to, directly or through a chain of parent relations.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelationMember<'a> {
	/// The member's role in the relation nearest to it.
	pub role: &'a str,
	pub relation: &'a Relation,
	/// The ids of the relations walked through to reach `relation`, empty when the feature is a direct member.
	pub parent_path: Vec<i64>,
}

#[derive(Debug, Default)]
struct BlockSummary {
	nodes: Vec<(i64, u64)>,
	multipolygon_ways: Vec<i64>,
	relations: Vec<Relation>,
	max_way_id: i64,
	negative_id: Option<i64>,
}

/// The state pass 1 builds and pass 2 reads.
#[derive(Debug, Default)]
pub struct Pass1 {
	pub nodes: NodeStore,
	multipolygon_ways: HashSet<i64>,
	relations: HashMap<i64, Relation>,
	/// Way id to `(role, relation id)` for each kept relation that lists the way, in file order.
	way_to_relations: HashMap<i64, Vec<(String, i64)>>,
	/// Relation id to `(role, parent relation id)` for each kept relation that lists the relation.
	relation_to_parents: HashMap<i64, Vec<(String, i64)>>,
	pub max_way_id: i64,
}

/// Runs pass 1 over `path`, keeping the relations for which `keep_relation` returns true.
///
/// A negative element id fails the pass, as Planetiler refuses them.
pub fn pass1(path: &Path, keep_relation: impl Fn(&Relation) -> bool + Sync) -> io::Result<Pass1> {
	let mut chunks = Vec::new();
	let mut state = Pass1 {
		max_way_id: i64::MIN,
		..Pass1::default()
	};
	let mut negative = None;

	crate::pbf::for_each_block(
		path,
		|block| {
			let mut summary = BlockSummary {
				max_way_id: i64::MIN,
				..BlockSummary::default()
			};
			let mut check = |id: i64| {
				if id < 0 && summary.negative_id.is_none() {
					summary.negative_id = Some(id);
				}
			};
			for element in block.elements() {
				match element {
					Element::DenseNode(node) => {
						check(node.id());
						let location =
							encode_flat_location(nano_to_degrees(node.nano_lon()), nano_to_degrees(node.nano_lat()));
						summary.nodes.push((node.id(), location));
					}
					Element::Node(node) => {
						check(node.id());
						let location =
							encode_flat_location(nano_to_degrees(node.nano_lon()), nano_to_degrees(node.nano_lat()));
						summary.nodes.push((node.id(), location));
					}
					Element::Way(way) => {
						check(way.id());
						summary.max_way_id = summary.max_way_id.max(way.id());
					}
					Element::Relation(pbf_relation) => {
						check(pbf_relation.id());
						let relation = Relation::from_pbf(&pbf_relation);
						if relation.is_multipolygon() {
							summary.multipolygon_ways.extend(
								relation
									.members
									.iter()
									.filter(|member| member.kind == ElementKind::Way)
									.map(|member| member.id),
							);
						}
						if keep_relation(&relation) {
							summary.relations.push(relation);
						}
					}
				}
			}
			summary
		},
		|summary| {
			if negative.is_none() {
				negative = summary.negative_id;
			}
			chunks.push(summary.nodes);
			state.multipolygon_ways.extend(summary.multipolygon_ways);
			state.max_way_id = state.max_way_id.max(summary.max_way_id);
			for relation in summary.relations {
				for member in &relation.members {
					let entry = (member.role.clone(), relation.id);
					match member.kind {
						ElementKind::Way => state.way_to_relations.entry(member.id).or_default().push(entry),
						ElementKind::Relation => state.relation_to_parents.entry(member.id).or_default().push(entry),
						ElementKind::Node => {}
					}
				}
				state.relations.insert(relation.id, relation);
			}
		},
	)?;

	if let Some(id) = negative {
		return Err(io::Error::new(
			io::ErrorKind::InvalidData,
			format!("negative OSM element ids are not supported: {id}"),
		));
	}
	state.nodes = NodeStore::from_chunks(chunks);
	Ok(state)
}

impl Pass1 {
	/// Returns the kept relations that list `id` as a way member, followed by each one's kept parent relations, in the
	/// order Planetiler's `getRelationMembershipForWay` returns them.
	pub fn memberships(&self, id: i64) -> Vec<RelationMember<'_>> {
		let mut members = Vec::new();
		let Some(direct) = self.way_to_relations.get(&id) else {
			return members;
		};
		for (role, relation_id) in direct {
			if let Some(relation) = self.relations.get(relation_id) {
				members.push(RelationMember {
					role,
					relation,
					parent_path: Vec::new(),
				});
			}
			let Some(parents) = self.relation_to_parents.get(relation_id) else {
				continue;
			};
			let mut visited = HashSet::from([*relation_id]);
			for parent in parents {
				self.parent_memberships(parent, &mut visited, vec![*relation_id], &mut members);
			}
		}
		members
	}

	fn parent_memberships<'a>(
		&'a self,
		(role, relation_id): &'a (String, i64),
		visited: &mut HashSet<i64>,
		path: Vec<i64>,
		out: &mut Vec<RelationMember<'a>>,
	) {
		if !visited.insert(*relation_id) {
			return;
		}
		if let Some(relation) = self.relations.get(relation_id) {
			out.push(RelationMember {
				role,
				relation,
				parent_path: path.clone(),
			});
		}
		if let Some(parents) = self.relation_to_parents.get(relation_id) {
			let mut next_path = path;
			next_path.push(*relation_id);
			for parent in parents {
				self.parent_memberships(parent, visited, next_path.clone(), out);
			}
		}
	}
}

/// The geometry inputs of a source feature, resolved to coordinates only when the profile asks for them.
#[derive(Debug)]
enum Shape<'a> {
	Point(u64),
	Way(&'a [i64]),
	Multipolygon(Vec<&'a [i64]>),
}

/// A geometry that could not be built, with Planetiler's error-statistic name for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GeometryError {
	/// A way referred to a node absent from the file: `osm_invalid_line` or `osm_invalid_polygon`.
	MissingNode(i64),
	/// The geometry type the caller asked for does not apply to this feature.
	WrongType,
	Multipolygon(MultipolygonError),
}

/// An element offered to the profile, with the facts its rules test and lazy access to its geometry.
#[derive(Debug)]
pub struct SourceFeature<'a> {
	pub id: i64,
	pub kind: ElementKind,
	pub tags: &'a Tags,
	pub relations: Vec<RelationMember<'a>>,
	can_be_line: bool,
	can_be_polygon: bool,
	shape: Shape<'a>,
	nodes: &'a NodeStore,
}

/// Returns whether a way can be read as a line: an open way, or a closed way without `area=yes`, of at least two nodes.
pub fn can_be_line(closed: bool, area: Option<&str>, points: usize) -> bool {
	(!closed || area != Some("yes")) && points >= 2
}

/// Returns whether a way can be read as a polygon: a closed way without `area=no`, of at least four nodes.
pub fn can_be_polygon(closed: bool, area: Option<&str>, points: usize) -> bool {
	closed && area != Some("no") && points >= 4
}

impl SourceFeature<'_> {
	pub fn is_point(&self) -> bool {
		matches!(self.shape, Shape::Point(_))
	}

	pub fn can_be_line(&self) -> bool {
		self.can_be_line
	}

	pub fn can_be_polygon(&self) -> bool {
		self.can_be_polygon
	}

	fn way_coordinates(&self, ids: &[i64]) -> Result<Vec<Coord>, GeometryError> {
		ids.iter()
			.map(|&id| {
				let [x, y] = decode_world(self.nodes.get(id).ok_or(GeometryError::MissingNode(id))?);
				Ok(Coord { x, y })
			})
			.collect()
	}

	/// Returns the feature as a line in world coordinates.
	pub fn line(&self) -> Result<LineString, GeometryError> {
		match self.shape {
			Shape::Way(ids) if self.can_be_line => Ok(LineString::from(self.way_coordinates(ids)?)),
			_ => Err(GeometryError::WrongType),
		}
	}

	/// Returns the feature as a polygon or multipolygon in world coordinates.
	pub fn polygon(&self) -> Result<Geometry, GeometryError> {
		match &self.shape {
			Shape::Way(ids) if self.can_be_polygon => Ok(Geometry::Polygon(Polygon::new(
				LineString::from(self.way_coordinates(ids)?),
				vec![],
			))),
			Shape::Multipolygon(ways) => {
				let multipolygon = multipolygon::build(ways, self.nodes).map_err(GeometryError::Multipolygon)?;
				Ok(if multipolygon.0.len() == 1 {
					Geometry::Polygon(multipolygon.0.into_iter().next().unwrap())
				} else {
					Geometry::MultiPolygon(multipolygon)
				})
			}
			_ => Err(GeometryError::WrongType),
		}
	}

	/// Returns the feature's default geometry in world coordinates: the point, the polygon when the way can be one,
	/// else the line.
	pub fn world_geometry(&self) -> Result<Geometry, GeometryError> {
		match self.shape {
			Shape::Point(location) => {
				let [x, y] = decode_world(location);
				Ok(Geometry::Point(Point::new(x, y)))
			}
			Shape::Way(_) if self.can_be_polygon => self.polygon(),
			Shape::Way(_) => self.line().map(Geometry::LineString),
			Shape::Multipolygon(_) => self.polygon(),
		}
	}
}

/// Element counts from pass 2.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Pass2Counts {
	pub tagged_nodes: u64,
	pub ways: u64,
	pub multipolygons: u64,
}

#[derive(Default)]
struct Pass2Block {
	multipolygon_ways: Vec<(i64, Vec<i64>)>,
	multipolygons: Vec<Relation>,
}

/// Runs pass 2 over `path`, calling `emit` with each source feature from rayon's threads.
///
/// Untagged nodes are left out. Planetiler offers them to the profile, and no profile rule matches an element
/// without tags.
pub fn pass2(path: &Path, state: &Pass1, emit: impl Fn(&SourceFeature<'_>) + Sync) -> io::Result<Pass2Counts> {
	let tagged_nodes = AtomicU64::new(0);
	let ways = AtomicU64::new(0);
	let mut stored_ways: HashMap<i64, Vec<i64>> = HashMap::new();
	let mut multipolygons = Vec::new();

	crate::pbf::for_each_block(
		path,
		|block| {
			let mut out = Pass2Block::default();
			for element in block.elements() {
				match element {
					Element::DenseNode(node) => {
						let tags = Tags::collect(node.tags());
						if !tags.is_empty() {
							tagged_nodes.fetch_add(1, Ordering::Relaxed);
							let location = encode_flat_location(
								nano_to_degrees(node.nano_lon()),
								nano_to_degrees(node.nano_lat()),
							);
							emit(&point_feature(node.id(), &tags, location, &state.nodes));
						}
					}
					Element::Node(node) => {
						let tags = Tags::from(node.tags());
						if !tags.is_empty() {
							tagged_nodes.fetch_add(1, Ordering::Relaxed);
							let location = encode_flat_location(
								nano_to_degrees(node.nano_lon()),
								nano_to_degrees(node.nano_lat()),
							);
							emit(&point_feature(node.id(), &tags, location, &state.nodes));
						}
					}
					Element::Way(way) => {
						ways.fetch_add(1, Ordering::Relaxed);
						let refs: Vec<i64> = way.refs().collect();
						let tags = Tags::from(way.tags());
						let closed = refs.len() > 1 && refs[0] == refs[refs.len() - 1];
						let area = tags.get("area");
						let feature = SourceFeature {
							id: way.id(),
							kind: ElementKind::Way,
							tags: &tags,
							relations: state.memberships(way.id()),
							can_be_line: can_be_line(closed, area, refs.len()),
							can_be_polygon: can_be_polygon(closed, area, refs.len()),
							shape: Shape::Way(&refs),
							nodes: &state.nodes,
						};
						emit(&feature);
						if state.multipolygon_ways.contains(&way.id()) {
							out.multipolygon_ways.push((way.id(), refs));
						}
					}
					Element::Relation(pbf_relation) => {
						let relation = Relation::from_pbf(&pbf_relation);
						if relation.is_multipolygon() {
							out.multipolygons.push(relation);
						}
					}
				}
			}
			out
		},
		|block| {
			// A way listed twice in the file keeps its last node list, as Planetiler's replaceValues does.
			stored_ways.extend(block.multipolygon_ways);
			multipolygons.extend(block.multipolygons);
		},
	)?;

	multipolygons.par_iter().for_each(|relation| {
		let mut added = HashSet::new();
		let ways: Vec<&[i64]> = relation
			.members
			.iter()
			.filter(|member| member.kind == ElementKind::Way && added.insert(member.id))
			.filter_map(|member| stored_ways.get(&member.id).filter(|nodes| !nodes.is_empty()))
			.map(Vec::as_slice)
			.collect();
		let feature = SourceFeature {
			id: relation.id,
			kind: ElementKind::Relation,
			tags: &relation.tags,
			// Planetiler looks a multipolygon's parents up in its way-membership table by the relation's own id.
			relations: state.memberships(relation.id),
			can_be_line: false,
			can_be_polygon: true,
			shape: Shape::Multipolygon(ways),
			nodes: &state.nodes,
		};
		emit(&feature);
	});

	Ok(Pass2Counts {
		tagged_nodes: tagged_nodes.into_inner(),
		ways: ways.into_inner(),
		multipolygons: multipolygons.len() as u64,
	})
}

fn point_feature<'a>(id: i64, tags: &'a Tags, location: u64, nodes: &'a NodeStore) -> SourceFeature<'a> {
	SourceFeature {
		id,
		kind: ElementKind::Node,
		tags,
		relations: Vec::new(),
		can_be_line: false,
		can_be_polygon: false,
		shape: Shape::Point(location),
		nodes,
	}
}
