// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The RCA1 artifact: one compiled grammar family.
//!
//! `recognizer-build` writes the file and [`parse`] reads it, and both follow the layout below. The layout follows the
//! registry's RGY1 container (`packages/registry/docs/rgy1.md`): a fixed envelope, a canonical JSON header, then
//! 8-byte-aligned payloads, so one reader validates the whole file before any payload is used.
//!
//! ```text
//! 0   4 bytes  ASCII `RCA1`
//! 4   u16      artifact schema version, 6
//! 6   u16      flags, 0
//! 8   u32      header byte length
//! 12  u32      directory entry count, twice the automaton count plus one
//! 16  u32      directory byte offset, align8(32 + header length)
//! 20  u32      total byte length
//! 24  u32      first payload offset, align8(directory offset + count * 16)
//! 28  u16      byte order, 1 for little-endian
//! 30  u16      reserved, 0
//! 32  header   canonical JSON, keys in byte order, no whitespace
//! ... directory: count entries of { u16 role, u16 kind, u32 offset, u32 length, u32 reserved }
//! ... payloads: each at a multiple of 8, zero fill between
//! ```
//!
//! Every integer is little-endian. Each automaton has two payloads, in this order: a `regex-automata` DFA serialization
//! with its leading alignment padding removed, then its viability table ([`crate::viability`]). Role is 1 for the
//! whole-input automaton, 2 for the embedded-span automaton and 3 for a partition automaton, of which a family holds
//! one for each partition it declares, each named in the header. Kind is 1 for a dense DFA, 2 for a sparse DFA and 3 for
//! a viability table. The last entry belongs to the family and not to an automaton: role 0, kind 4, the capture
//! program ([`crate::captures`]) as canonical JSON. The program holds the grammar of every shape, its validator and its
//! declaration site, and where each term is declared, because the diagnostic replay of a trace reads it.
//!
//! Version 1 had no viability table. Version 2 had no capture program and a placeholder declarations hash. Version 3's
//! program held only the shapes that declare captures and no declaration site. Version 4 had no partition automaton.
//! Version 5 carried no shape role, hit order or boundary, so the known-formats pass read a PO box leader from the prefix
//! of the shape's ID and the order of hits from the order of the IDs. A reader refuses an earlier version with
//! [`ArtifactError::Version`].
//!
//! The header records the SHA-256 of each payload, of each table and of the capture program, and the parser refuses
//! one that differs. The hash of the whole file lives in the build manifest, as the registry's does. The header stores
//! no wall-clock time and no path. Its `declarationsHash` is the hash of the family's generated declarations
//! ([`crate::declarations`]). A caller that holds declarations passes the hash it expects to
//! [`crate::Engine::load_checked`], which refuses an artifact whose hash differs, and the engine refuses an artifact
//! whose hash differs from the declarations this crate was built with.
//!
//! A DFA serialization is not stable across `regex-automata` versions, and the crate validates its own label and
//! version on read. The header's `compilerVersion` must also equal [`COMPILER_VERSION`], so one build of the runtime
//! reads only the artifacts its own compiler wrote.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::ids::is_dotted_name;
use crate::ir::{sha256_hex, Boundary, Scope, ShapeRole};

/// The first four bytes of every artifact.
pub const MAGIC: &[u8; 4] = b"RCA1";

/// The `format` field of every header.
pub const ARTIFACT_FORMAT: &str = "mailwoman.recognizer.artifact";

/// The envelope version this crate writes and reads.
pub const ARTIFACT_SCHEMA_VERSION: u32 = 6;

/// The directory `kind` of a viability table. A DFA's kind is its backend's code.
const KIND_VIABILITY: u16 = 3;

/// The directory `kind` of the family's capture program.
const KIND_CAPTURES: u16 = 4;

/// The directory `role` of an entry that belongs to the family.
const ROLE_FAMILY: u16 = 0;

/// The compiler version an artifact must carry: the version of this crate, which `recognizer-build` shares through the
/// workspace.
pub const COMPILER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The byte length of the fixed envelope.
pub const ENVELOPE_BYTES: usize = 32;

/// The byte length of one directory entry.
pub const DIRECTORY_ENTRY_BYTES: usize = 16;

/// Payloads and the directory start at a multiple of this many bytes.
pub const ALIGNMENT: usize = 8;

const BYTE_ORDER_LITTLE: u16 = 1;

/// Which input an automaton reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
	/// Anchored at the start and at the end of the input: the shapes that match the whole input.
	Whole,
	/// Anchored at a start the search chooses: the shapes that match a span inside the input.
	Embedded,
	/// Anchored at each start of a left-to-right scan: the shapes of one partition, named in the header.
	Partition,
}

impl Role {
	fn code(self) -> u16 {
		match self {
			Role::Whole => 1,
			Role::Embedded => 2,
			Role::Partition => 3,
		}
	}

	/// The role as the manifest and diagnostics spell it.
	pub fn as_str(self) -> &'static str {
		match self {
			Role::Whole => "whole",
			Role::Embedded => "embedded",
			Role::Partition => "partition",
		}
	}
}

/// Which `regex-automata` automaton holds a payload.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Backend {
	/// A dense DFA: one table lookup per byte, the largest serialization.
	Dense,
	/// A sparse DFA: transitions as sorted ranges, a smaller serialization and a slower search.
	Sparse,
}

impl Backend {
	fn code(self) -> u16 {
		match self {
			Backend::Dense => 1,
			Backend::Sparse => 2,
		}
	}

	/// The backend as the manifest and diagnostics spell it.
	pub fn as_str(self) -> &'static str {
		match self {
			Backend::Dense => "dense",
			Backend::Sparse => "sparse",
		}
	}
}

/// One pattern of an automaton: the shape that owns pattern index `i` is `patterns[i]`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatternMeta {
	/// What may touch an embedded match of the shape.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub boundary: Option<Boundary>,
	/// The order the shape's hits come out in, when the family states one.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub order: Option<u32>,
	/// What the shape is for, when it is not a plain format.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub role: Option<ShapeRole>,
	pub scope: Scope,
	pub shape: String,
}

/// The header's description of one automaton, in directory order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomatonMeta {
	pub backend: Backend,
	/// The partition a `Partition` automaton scans, and absent from every other role.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub partition: Option<String>,
	pub patterns: Vec<PatternMeta>,
	pub role: Role,
	/// The SHA-256 of the payload bytes. The loader refuses a payload that differs, because a flipped byte inside a
	/// DFA table can still be a valid DFA that matches the wrong language.
	pub sha256: String,
	/// The states reachable from the start state, which includes the dead state when a path reaches it.
	pub states: u32,
	/// The SHA-256 of the viability table that follows the DFA.
	pub viability_sha256: String,
}

/// The canonical JSON header. Fields are declared in byte order of their serialized names, which is the order the
/// canonical text requires.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Header {
	pub automata: Vec<AutomatonMeta>,
	pub byte_order: String,
	/// The SHA-256 of the capture program that follows the automata.
	pub captures_sha256: String,
	pub compiler_version: String,
	pub declarations_hash: String,
	pub family: String,
	pub format: String,
	/// The longest input, in UTF-8 bytes, the family's compiler limits admit.
	pub input_limit_bytes: u32,
	pub ir_hash: String,
	pub schema_version: u32,
	pub unicode_version: String,
}

/// One automaton's bytes, as the writer receives them and the parser returns them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payload<'a> {
	pub role: Role,
	pub backend: Backend,
	pub bytes: &'a [u8],
	/// The automaton's viability table.
	pub viability: &'a [u8],
}

/// Why bytes are not an artifact this reader accepts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ArtifactError {
	/// Fewer bytes than the fixed envelope.
	Truncated,
	/// The first four bytes are not `RCA1`.
	Magic,
	/// An envelope version this reader does not implement.
	Version(u16),
	/// An envelope flag bit this reader does not know.
	Flags(u16),
	/// The envelope's byte-order field is not little-endian.
	ByteOrder(u16),
	/// This host is not little-endian, and a DFA serialization reads in native byte order only.
	HostByteOrder,
	/// A reserved field holds a value other than zero.
	Reserved,
	/// The stated total length differs from the byte count.
	Length { stated: u32, actual: usize },
	/// An offset, length or zero fill breaks the layout rule.
	Layout(&'static str),
	/// A payload lies outside the artifact, overlaps another, or starts off the alignment.
	SectionBounds(usize),
	/// The header is not strict UTF-8 JSON of the header's shape.
	HeaderJSON(String),
	/// The header parses and is not the canonical text of what it holds.
	HeaderNotCanonical,
	/// A header field holds a value outside what the field admits.
	Field { field: &'static str, message: String },
	/// The artifact was written by another compiler version.
	CompilerVersion { artifact: String, runtime: &'static str },
	/// The header and the directory disagree about an automaton.
	DirectoryMismatch(usize),
	/// A payload's SHA-256 differs from the one the header records.
	PayloadHash(usize),
	/// A viability table's SHA-256 differs from the one the header records.
	ViabilityHash(usize),
	/// A viability table is not a table of the shape the header describes.
	Viability(String),
	/// The capture program's SHA-256 differs from the one the header records.
	CapturesHash,
	/// The capture program is not a valid program.
	CaptureProgram(String),
	/// Two automata of one family have the same role.
	DuplicateRole(Role),
	/// An automaton's DFA bytes fail `regex-automata`'s checked deserialization.
	Automaton { role: Role, message: String },
	/// An automaton has a different number of patterns than the header declares.
	PatternCount {
		role: Role,
		header: usize,
		automaton: usize,
	},
	/// The artifact's IR hash is not the one the caller expects.
	IRHash { expected: String, found: String },
	/// The artifact's declarations hash is not the one the caller expects.
	DeclarationsHash { expected: String, found: String },
	/// An engine already holds a family with this ID.
	DuplicateFamily(String),
}

impl fmt::Display for ArtifactError {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			ArtifactError::Truncated => write!(formatter, "the artifact is shorter than its envelope"),
			ArtifactError::Magic => write!(formatter, "the artifact does not start with RCA1"),
			ArtifactError::Version(version) => write!(
				formatter,
				"artifact version {version}, this reader implements {ARTIFACT_SCHEMA_VERSION}"
			),
			ArtifactError::Flags(flags) => write!(formatter, "artifact flags {flags:#06x} are not zero"),
			ArtifactError::ByteOrder(order) => write!(formatter, "byte-order field {order} is not little-endian (1)"),
			ArtifactError::HostByteOrder => write!(formatter, "this host is not little-endian"),
			ArtifactError::Reserved => write!(formatter, "a reserved field is not zero"),
			ArtifactError::Length { stated, actual } => {
				write!(formatter, "the artifact states {stated} bytes and holds {actual}")
			}
			ArtifactError::Layout(message) => write!(formatter, "layout: {message}"),
			ArtifactError::SectionBounds(index) => write!(formatter, "payload {index} breaks the layout rule"),
			ArtifactError::HeaderJSON(message) => write!(formatter, "header: {message}"),
			ArtifactError::HeaderNotCanonical => write!(formatter, "the header is not in canonical form"),
			ArtifactError::Field { field, message } => write!(formatter, "header field `{field}`: {message}"),
			ArtifactError::CompilerVersion { artifact, runtime } => write!(
				formatter,
				"the artifact was compiled by version {artifact}, this runtime reads {runtime}"
			),
			ArtifactError::DirectoryMismatch(index) => {
				write!(
					formatter,
					"the header and the directory disagree about automaton {index}"
				)
			}
			ArtifactError::PayloadHash(index) => {
				write!(formatter, "payload {index} does not match its recorded SHA-256")
			}
			ArtifactError::ViabilityHash(index) => {
				write!(
					formatter,
					"the viability table of automaton {index} does not match its recorded SHA-256"
				)
			}
			ArtifactError::Viability(message) => write!(formatter, "viability table: {message}"),
			ArtifactError::CapturesHash => {
				write!(formatter, "the capture program does not match its recorded SHA-256")
			}
			ArtifactError::CaptureProgram(message) => write!(formatter, "capture program: {message}"),
			ArtifactError::DuplicateRole(role) => write!(formatter, "two automata have the role {}", role.as_str()),
			ArtifactError::Automaton { role, message } => {
				write!(
					formatter,
					"the {} automaton is not a valid DFA: {message}",
					role.as_str()
				)
			}
			ArtifactError::PatternCount {
				role,
				header,
				automaton,
			} => write!(
				formatter,
				"the {} automaton holds {automaton} patterns and the header declares {header}",
				role.as_str()
			),
			ArtifactError::IRHash { expected, found } => {
				write!(formatter, "IR hash {found} differs from the expected {expected}")
			}
			ArtifactError::DeclarationsHash { expected, found } => {
				write!(
					formatter,
					"declarations hash {found} differs from the expected {expected}"
				)
			}
			ArtifactError::DuplicateFamily(family) => write!(formatter, "family `{family}` is already loaded"),
		}
	}
}

impl std::error::Error for ArtifactError {}

fn align(value: usize) -> usize {
	value.div_ceil(ALIGNMENT) * ALIGNMENT
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
	u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
	u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn is_sha256_hex(text: &str) -> bool {
	text.len() == 64 && text.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_version(text: &str) -> bool {
	let parts: Vec<&str> = text.split('.').collect();

	parts.len() == 3
		&& parts
			.iter()
			.all(|part| !part.is_empty() && part.len() <= 6 && part.bytes().all(|byte| byte.is_ascii_digit()))
}

/// The canonical header text: compact JSON, keys in byte order.
pub fn header_text(header: &Header) -> String {
	serde_json::to_string(header).expect("a header always serializes")
}

/// Lays out an artifact. The result is deterministic: the same header and payloads give the same bytes.
///
/// The header's automata and the payloads correspond by position. `captures` is the family's capture program. The
/// writer refuses a header that [`parse`] would refuse, so a file it returns always loads.
pub fn assemble(header: &Header, payloads: &[Payload<'_>], captures: &[u8]) -> Result<Vec<u8>, ArtifactError> {
	if header.automata.len() != payloads.len() {
		return Err(ArtifactError::Layout("the header and the payloads differ in count"));
	}

	if header.captures_sha256 != sha256_hex(captures) {
		return Err(ArtifactError::CapturesHash);
	}

	for (index, (meta, payload)) in header.automata.iter().zip(payloads).enumerate() {
		if meta.role != payload.role || meta.backend != payload.backend {
			return Err(ArtifactError::DirectoryMismatch(index));
		}

		if meta.sha256 != sha256_hex(payload.bytes) {
			return Err(ArtifactError::PayloadHash(index));
		}

		if meta.viability_sha256 != sha256_hex(payload.viability) {
			return Err(ArtifactError::ViabilityHash(index));
		}
	}

	check_header(header)?;

	// Each automaton contributes its DFA and then its table. The capture program closes the list.
	let mut sections: Vec<(u16, u16, &[u8])> = payloads
		.iter()
		.flat_map(|payload| {
			[
				(payload.role.code(), payload.backend.code(), payload.bytes),
				(payload.role.code(), KIND_VIABILITY, payload.viability),
			]
		})
		.collect();

	sections.push((ROLE_FAMILY, KIND_CAPTURES, captures));
	let text = header_text(header);
	let directory_offset = align(ENVELOPE_BYTES + text.len());
	let first_payload = align(directory_offset + sections.len() * DIRECTORY_ENTRY_BYTES);
	let mut cursor = first_payload;
	let mut offsets = Vec::with_capacity(sections.len());

	for (_, _, bytes) in &sections {
		offsets.push(cursor);
		cursor = align(cursor + bytes.len());
	}

	let too_long = || ArtifactError::Layout("the artifact is larger than a u32 can address");
	let mut out = Vec::with_capacity(cursor);

	out.extend_from_slice(MAGIC);
	out.extend_from_slice(&(ARTIFACT_SCHEMA_VERSION as u16).to_le_bytes());
	out.extend_from_slice(&0u16.to_le_bytes());
	out.extend_from_slice(&u32::try_from(text.len()).map_err(|_| too_long())?.to_le_bytes());
	out.extend_from_slice(&u32::try_from(sections.len()).map_err(|_| too_long())?.to_le_bytes());
	out.extend_from_slice(&u32::try_from(directory_offset).map_err(|_| too_long())?.to_le_bytes());
	out.extend_from_slice(&u32::try_from(cursor).map_err(|_| too_long())?.to_le_bytes());
	out.extend_from_slice(&u32::try_from(first_payload).map_err(|_| too_long())?.to_le_bytes());
	out.extend_from_slice(&BYTE_ORDER_LITTLE.to_le_bytes());
	out.extend_from_slice(&0u16.to_le_bytes());
	out.extend_from_slice(text.as_bytes());
	out.resize(directory_offset, 0);

	for ((role, kind, bytes), offset) in sections.iter().zip(&offsets) {
		out.extend_from_slice(&role.to_le_bytes());
		out.extend_from_slice(&kind.to_le_bytes());
		out.extend_from_slice(&u32::try_from(*offset).map_err(|_| too_long())?.to_le_bytes());
		out.extend_from_slice(&u32::try_from(bytes.len()).map_err(|_| too_long())?.to_le_bytes());
		out.extend_from_slice(&0u32.to_le_bytes());
	}

	out.resize(first_payload, 0);

	for ((_, _, bytes), offset) in sections.iter().zip(&offsets) {
		out.resize(*offset, 0);
		out.extend_from_slice(bytes);
	}

	out.resize(cursor, 0);

	Ok(out)
}

fn field(name: &'static str, message: impl Into<String>) -> ArtifactError {
	ArtifactError::Field {
		field: name,
		message: message.into(),
	}
}

/// Checks every header field against what the field admits.
fn check_header(header: &Header) -> Result<(), ArtifactError> {
	if header.format != ARTIFACT_FORMAT {
		return Err(field(
			"format",
			format!("`{}`, expected `{ARTIFACT_FORMAT}`", header.format),
		));
	}

	if header.schema_version != ARTIFACT_SCHEMA_VERSION {
		return Err(ArtifactError::Version(header.schema_version.min(u16::MAX as u32) as u16));
	}

	if header.byte_order != "little" {
		return Err(field(
			"byteOrder",
			format!("`{}`, expected `little`", header.byte_order),
		));
	}

	if header.compiler_version != COMPILER_VERSION {
		return Err(ArtifactError::CompilerVersion {
			artifact: header.compiler_version.clone(),
			runtime: COMPILER_VERSION,
		});
	}

	if !is_version(&header.unicode_version) {
		return Err(field(
			"unicodeVersion",
			format!("`{}` is not a version", header.unicode_version),
		));
	}

	if !is_dotted_name(&header.family) {
		return Err(field(
			"family",
			format!("`{}` is not a dotted lowercase name", header.family),
		));
	}

	if !is_sha256_hex(&header.ir_hash) {
		return Err(field("irHash", "not 64 lowercase hexadecimal digits"));
	}

	if !is_sha256_hex(&header.declarations_hash) {
		return Err(field("declarationsHash", "not 64 lowercase hexadecimal digits"));
	}

	if !is_sha256_hex(&header.captures_sha256) {
		return Err(field("capturesSha256", "not 64 lowercase hexadecimal digits"));
	}

	if header.input_limit_bytes == 0 {
		return Err(field("inputLimitBytes", "zero"));
	}

	let mut roles: Vec<(Role, Option<&str>)> = Vec::new();

	for meta in &header.automata {
		let key = (meta.role, meta.partition.as_deref());

		if roles.contains(&key) {
			return Err(ArtifactError::DuplicateRole(meta.role));
		}

		roles.push(key);

		if (meta.role == Role::Partition) != meta.partition.is_some() {
			return Err(field(
				"automata",
				format!(
					"the {} automaton {} a partition name",
					meta.role.as_str(),
					if meta.role == Role::Partition { "has no" } else { "has" }
				),
			));
		}

		if meta.partition.as_deref().is_some_and(|name| !is_dotted_name(name)) {
			return Err(field("automata", "a partition name is not a dotted lowercase name"));
		}

		if meta.patterns.is_empty() {
			return Err(field(
				"automata",
				format!("the {} automaton has no patterns", meta.role.as_str()),
			));
		}

		if !is_sha256_hex(&meta.sha256) || !is_sha256_hex(&meta.viability_sha256) {
			return Err(field(
				"automata",
				"a payload hash is not 64 lowercase hexadecimal digits",
			));
		}

		if meta.states == 0 {
			return Err(field(
				"automata",
				format!("the {} automaton has no states", meta.role.as_str()),
			));
		}

		let mut seen: Vec<&str> = Vec::new();

		for pattern in &meta.patterns {
			let admitted = match meta.role {
				Role::Whole => matches!(pattern.scope, Scope::Whole | Scope::WholeOrEmbedded),
				Role::Embedded => matches!(pattern.scope, Scope::Embedded | Scope::WholeOrEmbedded),
				Role::Partition => pattern.scope == Scope::Partition,
			};

			if !admitted {
				return Err(field(
					"automata",
					format!(
						"shape `{}` is in the {} automaton and its scope does not admit it",
						pattern.shape,
						meta.role.as_str()
					),
				));
			}

			if !is_dotted_name(&pattern.shape) || seen.contains(&pattern.shape.as_str()) {
				return Err(field(
					"automata",
					format!("shape `{}` is malformed or repeated", pattern.shape),
				));
			}

			seen.push(&pattern.shape);
		}
	}

	Ok(())
}

/// A validated artifact borrowing the caller's bytes.
#[derive(Clone, Debug)]
pub struct Artifact<'a> {
	pub header: Header,
	pub payloads: Vec<Payload<'a>>,
	/// The family's capture program, as canonical JSON.
	pub captures: &'a [u8],
}

/// Parses and validates the envelope, the header, the directory and each payload's framing. It does not read a DFA:
/// [`crate::Engine::load`] does that, through `regex-automata`'s checked deserialization.
pub fn parse(bytes: &[u8]) -> Result<Artifact<'_>, ArtifactError> {
	if bytes.len() < ENVELOPE_BYTES {
		return Err(ArtifactError::Truncated);
	}

	if &bytes[0..4] != MAGIC {
		return Err(ArtifactError::Magic);
	}

	let version = u16_at(bytes, 4);

	if u32::from(version) != ARTIFACT_SCHEMA_VERSION {
		return Err(ArtifactError::Version(version));
	}

	let flags = u16_at(bytes, 6);

	if flags != 0 {
		return Err(ArtifactError::Flags(flags));
	}

	let byte_order = u16_at(bytes, 28);

	if byte_order != BYTE_ORDER_LITTLE {
		return Err(ArtifactError::ByteOrder(byte_order));
	}

	if u16_at(bytes, 30) != 0 {
		return Err(ArtifactError::Reserved);
	}

	if cfg!(target_endian = "big") {
		return Err(ArtifactError::HostByteOrder);
	}

	let header_length = u32_at(bytes, 8) as usize;
	let count = u32_at(bytes, 12) as usize;
	let directory_offset = u32_at(bytes, 16) as usize;
	let stated = u32_at(bytes, 20);
	let first_payload = u32_at(bytes, 24) as usize;

	if stated as usize != bytes.len() {
		return Err(ArtifactError::Length {
			stated,
			actual: bytes.len(),
		});
	}

	let header_end = ENVELOPE_BYTES
		.checked_add(header_length)
		.filter(|end| *end <= bytes.len())
		.ok_or(ArtifactError::Layout("the header runs past the artifact"))?;

	if directory_offset != align(header_end) {
		return Err(ArtifactError::Layout(
			"the directory is not at align8(32 + header length)",
		));
	}

	let directory_end = count
		.checked_mul(DIRECTORY_ENTRY_BYTES)
		.and_then(|length| directory_offset.checked_add(length))
		.filter(|end| *end <= bytes.len())
		.ok_or(ArtifactError::Layout("the directory runs past the artifact"))?;

	if first_payload != align(directory_end) || first_payload > bytes.len() {
		return Err(ArtifactError::Layout(
			"the first payload is not at align8(directory end)",
		));
	}

	if bytes[header_end..directory_offset].iter().any(|byte| *byte != 0)
		|| bytes[directory_end..first_payload].iter().any(|byte| *byte != 0)
	{
		return Err(ArtifactError::Layout(
			"a gap before the directory or the payloads is not zero",
		));
	}

	let text = std::str::from_utf8(&bytes[ENVELOPE_BYTES..header_end])
		.map_err(|error| ArtifactError::HeaderJSON(error.to_string()))?;
	// Read as bytes like the capture program, so the module holds one JSON reader and not two.
	let header: Header =
		serde_json::from_slice(text.as_bytes()).map_err(|error| ArtifactError::HeaderJSON(error.to_string()))?;

	if header_text(&header) != text {
		return Err(ArtifactError::HeaderNotCanonical);
	}

	check_header(&header)?;

	if header.automata.len() * 2 + 1 != count {
		return Err(ArtifactError::Layout(
			"the directory does not hold a DFA and a table for each automaton and the capture program",
		));
	}

	let mut payloads = Vec::with_capacity(header.automata.len());
	let mut cursor = first_payload;

	for (index, meta) in header.automata.iter().enumerate() {
		let mut sections: [&[u8]; 2] = [&[], &[]];

		for (which, section) in sections.iter_mut().enumerate() {
			let entry_index = index * 2 + which;
			let entry = &bytes[directory_offset + entry_index * DIRECTORY_ENTRY_BYTES..][..DIRECTORY_ENTRY_BYTES];

			if u32_at(entry, 12) != 0 {
				return Err(ArtifactError::Reserved);
			}

			let kind = if which == 0 {
				meta.backend.code()
			} else {
				KIND_VIABILITY
			};

			if u16_at(entry, 0) != meta.role.code() || u16_at(entry, 2) != kind {
				return Err(ArtifactError::DirectoryMismatch(index));
			}

			let offset = u32_at(entry, 4) as usize;
			let length = u32_at(entry, 8) as usize;
			let end = offset
				.checked_add(length)
				.filter(|end| *end <= bytes.len())
				.ok_or(ArtifactError::SectionBounds(entry_index))?;

			if offset != cursor || length == 0 {
				return Err(ArtifactError::SectionBounds(entry_index));
			}

			cursor = align(end);

			if bytes[end..cursor.min(bytes.len())].iter().any(|byte| *byte != 0) {
				return Err(ArtifactError::SectionBounds(entry_index));
			}

			*section = &bytes[offset..end];
		}

		if sha256_hex(sections[0]) != meta.sha256 {
			return Err(ArtifactError::PayloadHash(index));
		}

		if sha256_hex(sections[1]) != meta.viability_sha256 {
			return Err(ArtifactError::ViabilityHash(index));
		}

		payloads.push(Payload {
			role: meta.role,
			backend: meta.backend,
			bytes: sections[0],
			viability: sections[1],
		});
	}

	let entry = &bytes[directory_offset + header.automata.len() * 2 * DIRECTORY_ENTRY_BYTES..][..DIRECTORY_ENTRY_BYTES];
	let entry_index = header.automata.len() * 2;

	if u32_at(entry, 12) != 0 {
		return Err(ArtifactError::Reserved);
	}

	if u16_at(entry, 0) != ROLE_FAMILY || u16_at(entry, 2) != KIND_CAPTURES {
		return Err(ArtifactError::DirectoryMismatch(header.automata.len()));
	}

	let offset = u32_at(entry, 4) as usize;
	let end = offset
		.checked_add(u32_at(entry, 8) as usize)
		.filter(|end| *end <= bytes.len())
		.ok_or(ArtifactError::SectionBounds(entry_index))?;

	if offset != cursor || end == offset {
		return Err(ArtifactError::SectionBounds(entry_index));
	}

	cursor = align(end);

	if bytes[end..cursor.min(bytes.len())].iter().any(|byte| *byte != 0) {
		return Err(ArtifactError::SectionBounds(entry_index));
	}

	let captures = &bytes[offset..end];

	if sha256_hex(captures) != header.captures_sha256 {
		return Err(ArtifactError::CapturesHash);
	}

	if cursor != bytes.len() {
		return Err(ArtifactError::Layout("the artifact has bytes after its last payload"));
	}

	Ok(Artifact {
		header,
		payloads,
		captures,
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	/// A stand-in viability table: the envelope checks bytes and hashes, and the engine checks the table's content.
	const VIABILITY: [u8; 6] = [9; 6];

	/// A stand-in capture program: the envelope checks its bytes and hash, and the engine checks its content.
	const CAPTURES: &[u8] = br#"{"shapes":{},"terms":{}}"#;

	fn header(roles: &[Role]) -> Header {
		Header {
			automata: roles
				.iter()
				.enumerate()
				.map(|(index, role)| AutomatonMeta {
					backend: Backend::Dense,
					partition: None,
					patterns: vec![PatternMeta {
						boundary: None,
						order: None,
						role: None,
						scope: Scope::WholeOrEmbedded,
						shape: "word.ascii".to_string(),
					}],
					role: *role,
					// The sample payloads are 13 bytes of 7 and then 5 bytes of 7.
					sha256: sha256_hex(&[7u8; 13][..if index == 0 { 13 } else { 5 }]),
					states: 3,
					viability_sha256: sha256_hex(&VIABILITY),
				})
				.collect(),
			byte_order: "little".to_string(),
			captures_sha256: sha256_hex(CAPTURES),
			compiler_version: COMPILER_VERSION.to_string(),
			declarations_hash: "cd".repeat(32),
			family: "sample".to_string(),
			format: ARTIFACT_FORMAT.to_string(),
			input_limit_bytes: 4096,
			ir_hash: "ab".repeat(32),
			schema_version: ARTIFACT_SCHEMA_VERSION,
			unicode_version: "16.0.0".to_string(),
		}
	}

	fn sample() -> Vec<u8> {
		let payload = [7u8; 13];
		let payloads = [
			Payload {
				role: Role::Whole,
				backend: Backend::Dense,
				bytes: &payload,
				viability: &VIABILITY,
			},
			Payload {
				role: Role::Embedded,
				backend: Backend::Dense,
				bytes: &payload[..5],
				viability: &VIABILITY,
			},
		];

		assemble(&header(&[Role::Whole, Role::Embedded]), &payloads, CAPTURES).unwrap()
	}

	#[test]
	fn an_assembled_artifact_parses_and_is_aligned() {
		let bytes = sample();
		let parsed = parse(&bytes).unwrap();

		assert_eq!(bytes.len() % ALIGNMENT, 0);
		assert_eq!(parsed.payloads.len(), 2);
		assert_eq!(parsed.payloads[0].bytes, &[7u8; 13]);
		assert_eq!(parsed.payloads[1].bytes, &[7u8; 5]);
		assert_eq!(parsed.payloads[0].viability, &VIABILITY);
		assert_eq!(parsed.captures, CAPTURES);
		assert_eq!(parsed.header, header(&[Role::Whole, Role::Embedded]));
	}

	#[test]
	fn assembling_twice_gives_the_same_bytes() {
		assert_eq!(sample(), sample());
	}

	#[test]
	fn every_truncation_is_refused() {
		let bytes = sample();

		for length in 0..bytes.len() {
			assert!(parse(&bytes[..length]).is_err(), "a {length}-byte prefix parsed");
		}
	}

	#[test]
	fn the_envelope_fields_are_checked() {
		let good = sample();
		let mut bad = good.clone();

		bad[0] = b'X';
		assert_eq!(parse(&bad).unwrap_err(), ArtifactError::Magic);

		let mut bad = good.clone();

		// The previous schema version is refused with its own number, so a stale committed file names itself.
		bad[4] = 5;
		assert_eq!(parse(&bad).unwrap_err(), ArtifactError::Version(5));

		let mut bad = good.clone();

		bad[4] = 7;
		assert_eq!(parse(&bad).unwrap_err(), ArtifactError::Version(7));

		let mut bad = good.clone();

		bad[6] = 1;
		assert_eq!(parse(&bad).unwrap_err(), ArtifactError::Flags(1));

		let mut bad = good.clone();

		bad[28] = 2;
		assert_eq!(parse(&bad).unwrap_err(), ArtifactError::ByteOrder(2));

		let mut bad = good.clone();

		bad[30] = 1;
		assert_eq!(parse(&bad).unwrap_err(), ArtifactError::Reserved);

		let mut bad = good.clone();

		bad.push(0);
		assert!(matches!(parse(&bad).unwrap_err(), ArtifactError::Length { .. }));
	}

	#[test]
	fn a_header_field_outside_its_domain_is_refused() {
		let mut wrong_compiler = header(&[Role::Whole]);

		wrong_compiler.compiler_version = "0.0.0-other".to_string();

		let payload = [7u8; 13];
		let payloads = [Payload {
			role: Role::Whole,
			backend: Backend::Dense,
			bytes: &payload,
			viability: &VIABILITY,
		}];

		assert!(matches!(
			assemble(&wrong_compiler, &payloads, CAPTURES).unwrap_err(),
			ArtifactError::CompilerVersion { .. }
		));

		let mut bad_hash = header(&[Role::Whole]);

		bad_hash.ir_hash = "XYZ".to_string();
		assert!(matches!(
			assemble(&bad_hash, &payloads, CAPTURES).unwrap_err(),
			ArtifactError::Field { field: "irHash", .. }
		));

		assert_eq!(
			assemble(&header(&[Role::Whole]), &payloads, b"{}").unwrap_err(),
			ArtifactError::CapturesHash
		);
	}

	#[test]
	fn a_capture_program_whose_bytes_changed_is_refused() {
		let mut bytes = sample();
		let parsed = parse(&bytes).unwrap();
		let at = parsed.captures.as_ptr() as usize - bytes.as_ptr() as usize + 2;

		bytes[at] = b'X';
		assert_eq!(parse(&bytes).unwrap_err(), ArtifactError::CapturesHash);
	}

	#[test]
	fn a_payload_whose_bytes_changed_in_the_fill_is_refused() {
		let mut bytes = sample();
		let parsed = parse(&bytes).unwrap();
		let first_end = parsed.payloads[0].bytes.as_ptr() as usize - bytes.as_ptr() as usize + 13;

		bytes[first_end] = 9;
		assert!(matches!(parse(&bytes).unwrap_err(), ArtifactError::SectionBounds(0)));
	}
}
