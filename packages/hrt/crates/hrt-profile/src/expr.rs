// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from the basemaps fork's Matcher (BSD-3-Clause, Protomaps) and Planetiler 0.10.2's Expression and
// MultiExpression (Apache-2.0, Copyright Michael Barry).

//! The rule tables layers match source features against.
//!
//! A rule is a set of conditions joined by AND and a set of values. An index evaluates every rule against a feature
//! and returns the values of the rules that matched, in rule order. A getter then reads a key from the last matching
//! rule that sets it, so later rules override earlier ones.

use crate::input::Input;
use crate::parse;

/// A condition on a feature's tags or geometry type.
#[derive(Clone, Debug)]
pub enum Expr {
	True,
	/// The tag is present with a non-empty value.
	Field(String),
	/// The tag's value is one of `exact`, or matches one of `patterns`, where `%` stands for any run of characters. With
	/// `when_missing`, an absent or empty value also matches.
	Any {
		field: String,
		exact: Vec<String>,
		patterns: Vec<String>,
		when_missing: bool,
	},
	Not(Box<Expr>),
	And(Vec<Expr>),
	Or(Vec<Expr>),
	/// The fork's `WithinRangeExpression`: the tag parses as a long of at least `lower` and, when given, under `upper`. A
	/// value that parses as 0 counts only when it is the text `0`, because `getLong` also returns 0 for text that is no
	/// number.
	WithinRange {
		field: String,
		lower: i64,
		upper: Option<i64>,
	},
	Point,
	Line,
	Polygon,
}

fn wildcard_matches(pattern: &str, text: &str) -> bool {
	let parts: Vec<&str> = pattern.split('%').collect();
	if parts.len() == 1 {
		return pattern == text;
	}
	let mut rest = text;
	let first = parts[0];
	if !rest.starts_with(first) {
		return false;
	}
	rest = &rest[first.len()..];
	let last = parts[parts.len() - 1];
	for middle in &parts[1..parts.len() - 1] {
		match rest.find(middle) {
			Some(at) => rest = &rest[at + middle.len()..],
			None => return false,
		}
	}
	rest.len() >= last.len() && rest.ends_with(last)
}

impl Expr {
	pub fn evaluate(&self, input: &Input<'_>) -> bool {
		match self {
			Expr::True => true,
			Expr::Field(field) => input.tag(field).is_some_and(|value| !value.is_empty()),
			Expr::Any {
				field,
				exact,
				patterns,
				when_missing,
			} => match input.tag(field) {
				None | Some("") => *when_missing,
				Some(value) => {
					exact.iter().any(|candidate| candidate == value)
						|| patterns.iter().any(|pattern| wildcard_matches(pattern, value))
				}
			},
			Expr::Not(inner) => !inner.evaluate(input),
			Expr::And(conditions) => conditions.iter().all(|condition| condition.evaluate(input)),
			Expr::Or(conditions) => conditions.iter().any(|condition| condition.evaluate(input)),
			Expr::WithinRange { field, lower, upper } => match input.tag(field) {
				None => false,
				Some(text) => {
					let value = crate::parse::parse_long(Some(text));
					!(value == 0 && text != "0") && value >= *lower && upper.is_none_or(|upper| value < upper)
				}
			},
			Expr::Point => input.is_point(),
			Expr::Line => input.can_be_line(),
			Expr::Polygon => input.can_be_polygon(),
		}
	}
}

/// The fork's `with`: no arguments match everything, one is a tag that must be present, and more are a tag and the
/// values it may take. Every argument is split into lines, trimmed, and blank lines dropped.
pub fn with(arguments: &[&str]) -> Expr {
	let lines: Vec<String> = arguments
		.iter()
		.flat_map(|argument| argument.lines())
		.map(str::trim)
		.filter(|line| !line.is_empty())
		.map(str::to_owned)
		.collect();
	match lines.len() {
		0 => Expr::True,
		1 => Expr::Field(lines[0].clone()),
		_ => {
			let mut exact = Vec::new();
			let mut patterns = Vec::new();
			for value in &lines[1..] {
				// A '%' not preceded by a backslash makes the value a pattern.
				let unescaped_percent = value
					.char_indices()
					.any(|(at, c)| c == '%' && (at == 0 || !value[..at].ends_with('\\')));
				if unescaped_percent {
					patterns.push(value.clone());
				} else {
					exact.push(value.replace("\\%", "%"));
				}
			}
			Expr::Any {
				field: lines[0].clone(),
				exact,
				patterns,
				when_missing: false,
			}
		}
	}
}

/// The fork's `without`: the negation of [`with`].
/// The fork's `atLeast(tag, bound)`; a double bound is truncated, as its `longValue()` is.
pub fn at_least(field: &str, bound: i64) -> Expr {
	Expr::WithinRange {
		field: field.to_owned(),
		lower: bound,
		upper: None,
	}
}

/// The fork's `withinRange(tag, lower, upper)`: at least `lower` and under `upper`.
pub fn within_range(field: &str, lower: i64, upper: i64) -> Expr {
	Expr::WithinRange {
		field: field.to_owned(),
		lower,
		upper: Some(upper),
	}
}

/// The text a computed `Double` tag needs so the range expressions treat it as Java does: Java reads the number's
/// `longValue()`, and a value that truncates to 0 matches nothing, its text being `0.0` rather than `0`.
pub fn computed_double_tag(value: f64) -> String {
	match value as i64 {
		0 => "0.0".to_owned(),
		truncated => truncated.to_string(),
	}
}

pub fn without(arguments: &[&str]) -> Expr {
	Expr::Not(Box::new(with(arguments)))
}

/// A rule's value for one key.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
	Null,
	Str(String),
	Int(i32),
	Double(f64),
	Bool(bool),
	/// The source feature's value for this tag.
	FromTag(String),
}

pub fn from_tag(key: &str) -> Value {
	Value::FromTag(key.to_owned())
}

impl From<&str> for Value {
	fn from(text: &str) -> Self {
		Value::Str(text.to_owned())
	}
}

impl From<i32> for Value {
	fn from(number: i32) -> Self {
		Value::Int(number)
	}
}

impl From<bool> for Value {
	fn from(flag: bool) -> Self {
		Value::Bool(flag)
	}
}

/// A rule: conditions joined by AND and the values it sets when they hold.
#[derive(Clone, Debug)]
pub struct Rule {
	pub condition: Expr,
	pub uses: Vec<(&'static str, Value)>,
}

/// Builds a rule from its conditions and its `(key, value)` uses.
pub fn rule(conditions: Vec<Expr>, uses: Vec<(&'static str, Value)>) -> Rule {
	Rule {
		condition: Expr::And(conditions),
		uses,
	}
}

/// An ordered rule table.
#[derive(Clone, Debug)]
pub struct Index {
	rules: Vec<Rule>,
}

/// The rules that matched a feature, in rule order.
pub type Matches<'a> = Vec<&'a [(&'static str, Value)]>;

fn same_uses(a: &[(&'static str, Value)], b: &[(&'static str, Value)]) -> bool {
	a.len() == b.len() && a.iter().all(|entry| b.contains(entry))
}

impl Index {
	/// Planetiler's `MultiExpression.ofOrdered`: every rule stays a separate entry in its position.
	pub fn new(rules: Vec<Rule>) -> Self {
		Index { rules }
	}

	/// Planetiler's `MultiExpression.of`: rules whose value maps are equal merge into one entry at the first one's
	/// position, matching when any of their conditions holds. This moves later rules earlier, which changes which match
	/// a getter reads last.
	pub fn of(rules: Vec<Rule>) -> Self {
		let mut merged: Vec<Rule> = Vec::with_capacity(rules.len());
		for rule in rules {
			match merged.iter_mut().find(|existing| same_uses(&existing.uses, &rule.uses)) {
				Some(existing) => {
					let previous = std::mem::replace(&mut existing.condition, Expr::True);
					existing.condition = match previous {
						Expr::Or(mut conditions) => {
							conditions.push(rule.condition);
							Expr::Or(conditions)
						}
						other => Expr::Or(vec![other, rule.condition]),
					};
				}
				None => merged.push(rule),
			}
		}
		Index { rules: merged }
	}

	pub fn matches(&self, input: &Input<'_>) -> Matches<'_> {
		self.rules
			.iter()
			.filter(|rule| rule.condition.evaluate(input))
			.map(|rule| rule.uses.as_slice())
			.collect()
	}
}

fn last<'a>(matches: &'a Matches<'_>, key: &str) -> Option<&'a Value> {
	matches
		.iter()
		.rev()
		.find_map(|uses| uses.iter().find(|(k, _)| *k == key).map(|(_, value)| value))
}

/// The fork's `getString`: the last matching rule's value for `key`, read from a tag when it names one; a value of
/// another type gives the default.
pub fn get_string(input: &Input<'_>, matches: &Matches<'_>, key: &str, default: Option<&str>) -> Option<String> {
	match last(matches, key) {
		None => default.map(str::to_owned),
		Some(Value::Str(text)) => Some(text.clone()),
		Some(Value::FromTag(tag)) => input.tag(tag).map(str::to_owned).or_else(|| default.map(str::to_owned)),
		Some(_) => default.map(str::to_owned),
	}
}

/// The fork's `getInteger`: an integer value, or a tag's digits with every other character removed.
pub fn get_integer(input: &Input<'_>, matches: &Matches<'_>, key: &str, default: Option<i32>) -> Option<i32> {
	match last(matches, key) {
		None => default,
		Some(Value::Int(number)) => Some(*number),
		Some(Value::FromTag(tag)) => {
			let Some(text) = input.tag(tag) else {
				return default;
			};
			let digits: String = text.chars().filter(char::is_ascii_digit).collect();
			if digits.is_empty() {
				default
			} else {
				digits.parse().ok().or(default)
			}
		}
		Some(_) => default,
	}
}

/// The fork's `getDouble`.
pub fn get_double(input: &Input<'_>, matches: &Matches<'_>, key: &str, default: Option<f64>) -> Option<f64> {
	match last(matches, key) {
		None => default,
		Some(Value::Double(number)) => Some(*number),
		Some(Value::FromTag(tag)) => match input.tag(tag) {
			Some(text) => text.trim().parse().ok().or(default),
			None => default,
		},
		Some(_) => default,
	}
}

/// The fork's `getBoolean`, with a tag read through Planetiler's boolean parsing.
pub fn get_boolean(input: &Input<'_>, matches: &Matches<'_>, key: &str, default: Option<bool>) -> Option<bool> {
	match last(matches, key) {
		None => default,
		Some(Value::Bool(flag)) => Some(*flag),
		Some(Value::FromTag(tag)) => {
			if input.has_tag(tag) {
				Some(parse::bool(input.tag(tag)))
			} else {
				default
			}
		}
		Some(_) => default,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn wildcards_match_runs_of_characters() {
		assert!(wildcard_matches("%link", "motorway_link"));
		assert!(wildcard_matches("a%c", "abbbc"));
		assert!(!wildcard_matches("a%c", "abbb"));
		assert!(wildcard_matches("%", "anything"));
	}

	#[test]
	fn multiline_arguments_become_a_tag_and_its_values() {
		let Expr::Any { field, exact, .. } = with(&["\n  natural\n  fjord\n  strait\n"]) else {
			panic!("expected a value match");
		};
		assert_eq!(field, "natural");
		assert_eq!(exact, vec!["fjord", "strait"]);
	}
}
