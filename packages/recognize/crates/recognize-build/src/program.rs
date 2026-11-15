// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The program of a family: the grammar of each shape, ready for the runtime's walk. Capture extraction reads the shapes
//! that declare captures, and the diagnostic replay of a trace reads all of them.
//!
//! A grammar written as AST nodes passes through unchanged. A regular-expression string is parsed here, at build time,
//! and its HIR becomes AST nodes, so the runtime crate carries no regex parser. A named group `(?P<name>…)` becomes a
//! capture called `name`, and an unnamed group is plain grouping. A regular expression cannot spell a dotted capture
//! path, so a pattern's captures are single-segment names. The same rules as for AST captures hold: each capture is
//! declared in the shape's schema, a declared capture is made, and none sits under a repeat that can match more than
//! once.

use std::collections::{BTreeMap, BTreeSet};

use recognize_core::captures::{CaptureProgram, ProgramShape};
use recognize_core::ids::is_dotted_name;
use recognize_core::{Diagnostic, DiagnosticKind, IrDocument, Node, Shape};
use regex_syntax::hir::{Class, ClassUnicodeRange, Hir, HirKind};

/// Builds the program of a family, or reports each shape whose captures it cannot express.
pub fn build(document: &IrDocument) -> Result<CaptureProgram, Vec<Diagnostic>> {
	let mut diagnostics = Vec::new();
	let mut program = CaptureProgram::default();
	let mut reached: BTreeSet<String> = BTreeSet::new();
	let by_id: BTreeMap<&str, &Node> = document
		.terms
		.iter()
		.map(|term| (term.id.as_str(), &term.grammar))
		.collect();

	for shape in &document.shapes {
		match shape_node(shape, &mut diagnostics) {
			Some(node) => {
				collect_terms(&node, &by_id, &mut reached, &mut program, &mut diagnostics, shape);
				program.shapes.insert(
					shape.id.clone(),
					ProgramShape {
						captures: {
							let mut captures = shape.captures.clone();

							captures.sort_by(|a, b| a.path.cmp(&b.path));
							captures
						},
						node,
						validator: shape.validator.as_ref().map(|validator| validator.as_str().to_string()),
						source: shape.source.clone(),
					},
				);
			}
			None => continue,
		}
	}

	for id in program.terms.keys().cloned().collect::<Vec<_>>() {
		if let Some(term) = document.terms.iter().find(|term| term.id == id) {
			program.term_sources.insert(id, term.source.clone());
		}
	}

	if diagnostics.is_empty() {
		Ok(program)
	} else {
		Err(diagnostics)
	}
}

/// Adds every term the node reaches, lowering the patterns inside them.
fn collect_terms(
	node: &Node,
	by_id: &BTreeMap<&str, &Node>,
	reached: &mut BTreeSet<String>,
	program: &mut CaptureProgram,
	diagnostics: &mut Vec<Diagnostic>,
	shape: &Shape,
) {
	let mut ids = Vec::new();

	node.visit(&mut |visited| {
		if let Node::Reference { id } = visited {
			ids.push(id.clone());
		}
	});

	for id in ids {
		if !reached.insert(id.clone()) {
			continue;
		}

		let Some(grammar) = by_id.get(id.as_str()) else {
			continue;
		};
		let mut context = Context {
			shape,
			captures: Vec::new(),
			diagnostics,
		};
		let lowered = lower(grammar, false, &mut context);

		if let Some(path) = context.captures.first().cloned() {
			context.refuse(
				DiagnosticKind::CaptureSchemaMismatch,
				format!("term `{id}` makes the capture `{path}`; captures belong to a shape's own grammar"),
			);
		}

		collect_terms(&lowered, by_id, reached, program, diagnostics, shape);
		program.terms.insert(id, lowered);
	}
}

struct Context<'a> {
	shape: &'a Shape,
	captures: Vec<String>,
	diagnostics: &'a mut Vec<Diagnostic>,
}

impl Context<'_> {
	fn refuse(&mut self, kind: DiagnosticKind, message: String) {
		self.diagnostics
			.push(Diagnostic::new(kind, &self.shape.source, message));
	}
}

/// The shape's grammar with every pattern lowered, checked against its capture schema.
fn shape_node(shape: &Shape, diagnostics: &mut Vec<Diagnostic>) -> Option<Node> {
	let mut context = Context {
		shape,
		captures: Vec::new(),
		diagnostics,
	};
	let node = lower(&shape.grammar, false, &mut context);
	let made = context.captures;
	let before = diagnostics.len();

	let mut has_pattern = false;

	shape.grammar.visit(&mut |visited| {
		if matches!(visited, Node::Pattern { .. }) {
			has_pattern = true;
		}
	});

	// Validation checked an AST grammar's captures against the schema. A pattern hides its groups from it, so the
	// schema is checked here for every capture the lowered grammar makes.
	if has_pattern {
		let declared: BTreeSet<&str> = shape.captures.iter().map(|spec| spec.path.as_str()).collect();
		let mut seen = BTreeSet::new();

		for path in &made {
			if !declared.contains(path.as_str()) {
				diagnostics.push(Diagnostic::new(
					DiagnosticKind::CaptureSchemaMismatch,
					&shape.source,
					format!("capture `{path}` is in the grammar and not in the capture schema"),
				));
			}

			if !seen.insert(path.as_str()) {
				diagnostics.push(Diagnostic::new(
					DiagnosticKind::CaptureSchemaMismatch,
					&shape.source,
					format!("capture `{path}` is made twice in one grammar"),
				));
			}
		}

		for path in declared.difference(&made.iter().map(String::as_str).collect()) {
			diagnostics.push(Diagnostic::new(
				DiagnosticKind::CaptureSchemaMismatch,
				&shape.source,
				format!("capture `{path}` is declared and the grammar never makes it"),
			));
		}
	}

	(diagnostics.len() == before).then_some(node)
}

/// Rebuilds a node with each pattern replaced by its lowered nodes. `many` is whether a repeat that can match more than
/// once encloses the node.
fn lower(node: &Node, many: bool, context: &mut Context<'_>) -> Node {
	match node {
		Node::Literal { .. } | Node::Class { .. } | Node::Reference { .. } => node.clone(),
		Node::Sequence { items } => Node::Sequence {
			items: items.iter().map(|item| lower(item, many, context)).collect(),
		},
		Node::Choice { alternatives } => Node::Choice {
			alternatives: alternatives.iter().map(|item| lower(item, many, context)).collect(),
		},
		Node::Optional { node } => Node::Optional {
			node: Box::new(lower(node, many, context)),
		},
		Node::Repeat { node, min, max } => Node::Repeat {
			node: Box::new(lower(node, many || max.is_none_or(|max| max > 1), context)),
			min: *min,
			max: *max,
		},
		Node::Capture { path, node } => {
			context.captures.push(path.clone());

			Node::Capture {
				path: path.clone(),
				node: Box::new(lower(node, many, context)),
			}
		}
		Node::Pattern { regex } => match regex_syntax::ParserBuilder::new().utf8(true).build().parse(regex) {
			Ok(hir) => from_hir(&hir, many, context),
			Err(error) => {
				context.refuse(
					DiagnosticKind::UnsupportedOperator,
					format!("regular expression `{regex}` is not supported: {error}"),
				);

				Node::Sequence { items: Vec::new() }
			}
		},
	}
}

fn from_hir(hir: &Hir, many: bool, context: &mut Context<'_>) -> Node {
	match hir.kind() {
		HirKind::Empty => Node::Sequence { items: Vec::new() },
		HirKind::Literal(literal) => Node::Literal {
			value: String::from_utf8_lossy(&literal.0).into_owned(),
		},
		HirKind::Class(Class::Unicode(class)) => Node::Class {
			ranges: class
				.ranges()
				.iter()
				.map(|range: &ClassUnicodeRange| recognize_core::ClassRange(range.start(), range.end()))
				.collect(),
			negated: false,
		},
		HirKind::Class(Class::Bytes(class)) => {
			if class.ranges().iter().all(|range| range.end().is_ascii()) {
				Node::Class {
					ranges: class
						.ranges()
						.iter()
						.map(|range| recognize_core::ClassRange(range.start() as char, range.end() as char))
						.collect(),
					negated: false,
				}
			} else {
				context.refuse(
					DiagnosticKind::UnsupportedOperator,
					"a byte class outside ASCII has no capture program".to_string(),
				);

				Node::Sequence { items: Vec::new() }
			}
		}
		HirKind::Look(_) => {
			context.refuse(
				DiagnosticKind::UnsupportedOperator,
				"an assertion has no capture program".to_string(),
			);

			Node::Sequence { items: Vec::new() }
		}
		HirKind::Repetition(repetition) => Node::Repeat {
			node: Box::new(from_hir(
				&repetition.sub,
				many || repetition.max.is_none_or(|max| max > 1),
				context,
			)),
			min: repetition.min,
			max: repetition.max,
		},
		HirKind::Capture(group) => {
			let inner = from_hir(&group.sub, many, context);

			match &group.name {
				None => inner,
				Some(name) => {
					if !is_dotted_name(name) || name.contains('.') {
						context.refuse(
							DiagnosticKind::MalformedCapturePath,
							format!("capture group `{name}` is not a lowercase name without dots"),
						);
					}

					if many {
						context.refuse(
							DiagnosticKind::CaptureSchemaMismatch,
							format!("capture `{name}` sits under a repeat that can match more than once"),
						);
					}

					context.captures.push(name.to_string());

					Node::Capture {
						path: name.to_string(),
						node: Box::new(inner),
					}
				}
			}
		}
		HirKind::Concat(items) => Node::Sequence {
			items: items.iter().map(|item| from_hir(item, many, context)).collect(),
		},
		HirKind::Alternation(alternatives) => Node::Choice {
			alternatives: alternatives.iter().map(|item| from_hir(item, many, context)).collect(),
		},
	}
}
