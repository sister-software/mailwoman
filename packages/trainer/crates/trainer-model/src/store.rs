//! The model's parameters and buffers by name, in the order `torch.nn.Module` reports them.
//!
//! `named_parameters()` walks the module tree: a module's own parameters in registration order, then each child
//! module in registration order. `state_dict()` walks the same tree and writes each module's parameters, then its
//! persistent buffers. Those orders decide what the Python `_init_weights` loop draws for each parameter, the order
//! the global gradient norm sums in, and the order a checkpoint lists its tensors, so the store keeps the tree. A
//! child module enters its parent's list when its first tensor is registered, which is its registration order
//! when tensors are registered as the Python constructors create them.

use crate::{fail, Result};
use tch::Tensor;

#[derive(Default)]
struct Node {
	params: Vec<(String, Tensor)>,
	buffers: Vec<(String, Tensor, bool)>,
	children: Vec<(String, Node)>,
}

impl Node {
	fn child(&mut self, path: &[&str]) -> &mut Node {
		let Some((first, rest)) = path.split_first() else {
			return self;
		};
		let index = match self.children.iter().position(|(name, _)| name == first) {
			Some(i) => i,
			None => {
				self.children.push(((*first).to_owned(), Node::default()));
				self.children.len() - 1
			}
		};
		self.children[index].1.child(rest)
	}

	fn walk<'a>(&'a self, prefix: &str, out: &mut Vec<Entry<'a>>) {
		for (name, tensor) in &self.params {
			out.push(Entry {
				name: join(prefix, name),
				tensor,
				kind: EntryKind::Parameter,
			});
		}
		for (name, tensor, persistent) in &self.buffers {
			out.push(Entry {
				name: join(prefix, name),
				tensor,
				kind: if *persistent {
					EntryKind::Buffer
				} else {
					EntryKind::TransientBuffer
				},
			});
		}
		for (name, child) in &self.children {
			child.walk(&join(prefix, name), out);
		}
	}
}

fn join(prefix: &str, name: &str) -> String {
	if prefix.is_empty() {
		name.to_owned()
	} else {
		format!("{prefix}.{name}")
	}
}

/// What a store entry is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
	Parameter,
	/// A buffer `state_dict()` writes.
	Buffer,
	/// A buffer registered with `persistent=False`, which a checkpoint does not hold.
	TransientBuffer,
}

/// One tensor of the store in tree order.
pub struct Entry<'a> {
	pub name: String,
	pub tensor: &'a Tensor,
	pub kind: EntryKind,
}

/// The module tree's tensors.
#[derive(Default)]
pub struct Store {
	root: Node,
}

fn split(name: &str) -> (Vec<&str>, &str) {
	let mut parts: Vec<&str> = name.split('.').collect();
	let leaf = parts.pop().expect("split yields at least one part");
	(parts, leaf)
}

impl Store {
	/// Registers a parameter under its dotted name and returns a handle sharing its storage. The tensor is made a
	/// leaf that requires a gradient, as `nn.Parameter` does.
	pub fn param(&mut self, name: &str, tensor: Tensor) -> Tensor {
		let (path, leaf) = split(name);
		let tensor = tensor.set_requires_grad(true);
		let handle = tensor.shallow_clone();
		self.root.child(&path).params.push((leaf.to_owned(), tensor));
		handle
	}

	/// Registers a buffer. A transient buffer (`persistent=False`) is left out of checkpoints.
	pub fn buffer(&mut self, name: &str, tensor: Tensor, persistent: bool) -> Tensor {
		let (path, leaf) = split(name);
		let handle = tensor.shallow_clone();
		self.root.child(&path).buffers.push((leaf.to_owned(), tensor, persistent));
		handle
	}

	/// Every entry in tree order.
	pub fn entries(&self) -> Vec<Entry<'_>> {
		let mut out = Vec::new();
		self.root.walk("", &mut out);
		out
	}

	/// The parameters in `named_parameters()` order.
	pub fn parameters(&self) -> Vec<(String, Tensor)> {
		self.entries()
			.into_iter()
			.filter(|e| e.kind == EntryKind::Parameter)
			.map(|e| (e.name, e.tensor.shallow_clone()))
			.collect()
	}

	/// The tensors `state_dict()` holds, in its order.
	pub fn state_dict(&self) -> Vec<(String, Tensor)> {
		self.entries()
			.into_iter()
			.filter(|e| e.kind != EntryKind::TransientBuffer)
			.map(|e| (e.name, e.tensor.shallow_clone()))
			.collect()
	}

	/// The named tensor, parameter or buffer.
	pub fn get(&self, name: &str) -> Result<Tensor> {
		self.entries()
			.into_iter()
			.find(|e| e.name == name)
			.map(|e| e.tensor.shallow_clone())
			.ok_or_else(|| fail!("the model has no tensor {name}"))
	}

	/// Copies `tensors` into the state-dict entries of the same name, as `load_state_dict(strict)` does.
	///
	/// A strict load refuses a missing or an unexpected key. A non-strict load copies the keys both hold and returns
	/// the missing and unexpected keys. Either refuses a shape mismatch. Each copy converts to the entry's dtype.
	pub fn load(&self, tensors: &[(String, Tensor)], strict: bool) -> Result<(Vec<String>, Vec<String>)> {
		let entries = self.state_dict();
		let mut missing = Vec::new();
		for (name, target) in &entries {
			match tensors.iter().find(|(n, _)| n == name) {
				Some((_, source)) => {
					if source.size() != target.size() {
						return Err(fail!(
							"checkpoint tensor {name} has shape {:?}, the model's is {:?}",
							source.size(),
							target.size()
						));
					}
					tch::no_grad(|| {
						let mut target = target.shallow_clone();
						target.copy_(&source.to_device(target.device()).to_kind(target.kind()));
					});
				}
				None => missing.push(name.clone()),
			}
		}
		let unexpected: Vec<String> = tensors
			.iter()
			.filter(|(n, _)| !entries.iter().any(|(e, _)| e == n))
			.map(|(n, _)| n.clone())
			.collect();
		if strict && (!missing.is_empty() || !unexpected.is_empty()) {
			return Err(fail!(
				"the checkpoint does not match the model: missing {missing:?}, unexpected {unexpected:?}"
			));
		}
		Ok((missing, unexpected))
	}

	/// The number of parameter elements, as `model_param_count` counts them.
	pub fn parameter_count(&self) -> i64 {
		self.parameters().iter().map(|(_, t)| t.numel() as i64).sum()
	}

	/// Moves every tensor to `device` as `module.to(device)` does. The tensors' data is replaced in place, so every
	/// handle a module holds sees the move.
	pub fn to_device(&self, device: tch::Device) {
		tch::no_grad(|| {
			for entry in self.entries() {
				let mut tensor = entry.tensor.shallow_clone();
				let moved = tensor.to_device(device);
				tensor.set_data(&moved);
			}
		});
	}
}
