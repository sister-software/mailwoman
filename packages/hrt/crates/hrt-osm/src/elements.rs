// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Owned OpenStreetMap elements, copied out of a decoded PBF block.

use osmpbf::{RelMemberType, TagIter};

/// The type of an OpenStreetMap element.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ElementKind {
	Node,
	Way,
	Relation,
}

impl ElementKind {
	/// Returns the vector tile feature id Planetiler assigns: the element id times `multiplier`, plus 1 for a node, 2
	/// for a way and 3 for a relation.
	pub fn feature_id(self, id: i64, multiplier: i64) -> i64 {
		id * multiplier
			+ match self {
				ElementKind::Node => 1,
				ElementKind::Way => 2,
				ElementKind::Relation => 3,
			}
	}
}

/// An element's tags in file order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Tags(pub Vec<(String, String)>);

impl Tags {
	/// Copies the tags out of a PBF tag iterator.
	pub fn collect<'a>(tags: impl Iterator<Item = (&'a str, &'a str)>) -> Self {
		Tags(tags.map(|(key, value)| (key.to_owned(), value.to_owned())).collect())
	}

	/// Returns the value of `key`, or `None` when the element lacks it.
	pub fn get(&self, key: &str) -> Option<&str> {
		self.0.iter().find(|(k, _)| k == key).map(|(_, value)| value.as_str())
	}

	/// Returns true when `key` is present with one of `values`.
	pub fn has_any(&self, key: &str, values: &[&str]) -> bool {
		self.get(key).is_some_and(|value| values.contains(&value))
	}

	/// Returns true when the element has no tags.
	pub fn is_empty(&self) -> bool {
		self.0.is_empty()
	}
}

impl From<TagIter<'_>> for Tags {
	fn from(tags: TagIter<'_>) -> Self {
		Tags::collect(tags)
	}
}

/// A relation member: the member's type, its id, and its role string.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Member {
	pub kind: ElementKind,
	pub id: i64,
	pub role: String,
}

/// A relation copied out of a PBF block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Relation {
	pub id: i64,
	pub tags: Tags,
	pub members: Vec<Member>,
}

impl Relation {
	/// Copies a relation out of a decoded block. A role string the block cannot decode becomes an empty role.
	pub fn from_pbf(relation: &osmpbf::Relation<'_>) -> Self {
		Relation {
			id: relation.id(),
			tags: relation.tags().into(),
			members: relation
				.members()
				.map(|member| Member {
					kind: match member.member_type {
						RelMemberType::Node => ElementKind::Node,
						RelMemberType::Way => ElementKind::Way,
						RelMemberType::Relation => ElementKind::Relation,
					},
					id: member.member_id,
					role: member.role().unwrap_or_default().to_owned(),
				})
				.collect(),
		}
	}

	/// Returns true for the relations Planetiler assembles into polygons: `type` of `multipolygon`, `boundary` or
	/// `land_area`, with at least one way member.
	pub fn is_multipolygon(&self) -> bool {
		self.tags.has_any("type", &["multipolygon", "boundary", "land_area"])
			&& self.members.iter().any(|member| member.kind == ElementKind::Way)
	}
}
