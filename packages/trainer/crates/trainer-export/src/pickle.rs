//! The subset of Python's pickle machine that `torch.save` uses for a state dict.
//!
//! `torch.save` pickles the state dict with protocol 2 into `<archive>/data.pkl`. Each tensor is a call to
//! `torch._utils._rebuild_tensor_v2` whose first argument is a persistent id naming a storage file in the same
//! archive. The machine here builds values and leaves every call unevaluated, so it never imports or runs Python
//! code: a `GLOBAL` is a pair of names and a `REDUCE` is a [`Value::Call`] record. An opcode outside the set below is
//! an error that names it.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::{fail, Result};

/// One unpickled value.
#[derive(Clone, Debug)]
pub enum Value {
	None,
	Bool(bool),
	Int(i64),
	Float(f64),
	Str(String),
	Bytes(Vec<u8>),
	Tuple(Vec<Value>),
	/// A list, shared so that a memoized copy sees the appends made after it was stored.
	List(Rc<RefCell<Vec<Value>>>),
	/// A dict in insertion order, shared for the same reason as a list.
	Dict(Rc<RefCell<Vec<(Value, Value)>>>),
	/// A `module.name` reference that `GLOBAL` or `STACK_GLOBAL` pushes.
	Global {
		module: String,
		name: String,
	},
	/// A `REDUCE`: `callable(*args)`, recorded rather than evaluated. Items a `SETITEMS` adds to a call's result
	/// (an `OrderedDict()`) go into `items`.
	Call {
		callable: Box<Value>,
		args: Box<Value>,
		items: Rc<RefCell<Vec<(Value, Value)>>>,
	},
	/// A `BINPERSID` reference to an object outside the pickle, such as a tensor storage.
	Persistent(Box<Value>),
}

impl Value {
	/// The entries of a dict, or of a call whose result received `SETITEMS` (an `OrderedDict`).
	pub fn entries(&self) -> Option<Vec<(Value, Value)>> {
		match self {
			Value::Dict(items) => Some(items.borrow().clone()),
			Value::Call { items, .. } => Some(items.borrow().clone()),
			_ => None,
		}
	}

	pub fn as_str(&self) -> Option<&str> {
		match self {
			Value::Str(s) => Some(s),
			_ => None,
		}
	}

	pub fn as_int(&self) -> Option<i64> {
		match self {
			Value::Int(i) => Some(*i),
			Value::Bool(b) => Some(i64::from(*b)),
			_ => None,
		}
	}

	pub fn as_tuple(&self) -> Option<&[Value]> {
		match self {
			Value::Tuple(items) => Some(items),
			_ => None,
		}
	}
}

#[derive(Clone)]
enum Slot {
	Value(Value),
	Mark,
}

struct Machine<'a> {
	data: &'a [u8],
	pos: usize,
	stack: Vec<Slot>,
	memo: HashMap<u32, Value>,
}

impl<'a> Machine<'a> {
	fn take(&mut self, n: usize) -> Result<&'a [u8]> {
		let end = self.pos.checked_add(n).filter(|end| *end <= self.data.len());
		let end = end.ok_or_else(|| fail!("pickle truncated at byte {}", self.pos))?;
		let bytes = &self.data[self.pos..end];
		self.pos = end;
		Ok(bytes)
	}

	fn byte(&mut self) -> Result<u8> {
		Ok(self.take(1)?[0])
	}

	fn u16(&mut self) -> Result<u16> {
		Ok(u16::from_le_bytes(self.take(2)?.try_into().expect("2 bytes")))
	}

	fn u32(&mut self) -> Result<u32> {
		Ok(u32::from_le_bytes(self.take(4)?.try_into().expect("4 bytes")))
	}

	fn line(&mut self) -> Result<String> {
		let start = self.pos;
		let rest = &self.data[start..];
		let end = rest
			.iter()
			.position(|b| *b == b'\n')
			.ok_or_else(|| fail!("pickle GLOBAL without a newline"))?;
		self.pos = start + end + 1;
		String::from_utf8(rest[..end].to_vec()).map_err(|_| fail!("pickle GLOBAL name is not UTF-8"))
	}

	fn utf8(&mut self, n: usize) -> Result<Value> {
		let bytes = self.take(n)?;
		let text = std::str::from_utf8(bytes).map_err(|_| fail!("pickle string is not UTF-8"))?;
		Ok(Value::Str(text.to_owned()))
	}

	fn push(&mut self, value: Value) {
		self.stack.push(Slot::Value(value));
	}

	fn pop(&mut self) -> Result<Value> {
		match self.stack.pop() {
			Some(Slot::Value(value)) => Ok(value),
			Some(Slot::Mark) => Err(fail!("pickle popped a mark where a value was expected")),
			None => Err(fail!("pickle stack underflow")),
		}
	}

	fn top(&self) -> Result<&Value> {
		match self.stack.last() {
			Some(Slot::Value(value)) => Ok(value),
			_ => Err(fail!("pickle expected a value on top of the stack")),
		}
	}

	/// The values above the topmost mark, which is removed.
	fn pop_mark(&mut self) -> Result<Vec<Value>> {
		let mark = self
			.stack
			.iter()
			.rposition(|slot| matches!(slot, Slot::Mark))
			.ok_or_else(|| fail!("pickle has no mark to pop to"))?;
		let items = self.stack.split_off(mark + 1);
		self.stack.pop();
		items
			.into_iter()
			.map(|slot| match slot {
				Slot::Value(value) => Ok(value),
				Slot::Mark => Err(fail!("pickle nested mark")),
			})
			.collect()
	}

	fn memo_put(&mut self, key: u32) -> Result<()> {
		let value = self.top()?.clone();
		self.memo.insert(key, value);
		Ok(())
	}

	fn memo_get(&mut self, key: u32) -> Result<()> {
		let value = self
			.memo
			.get(&key)
			.cloned()
			.ok_or_else(|| fail!("pickle memo {key} is unset"))?;
		self.push(value);
		Ok(())
	}

	fn set_items(&mut self, pairs: Vec<Value>) -> Result<()> {
		if !pairs.len().is_multiple_of(2) {
			return Err(fail!("pickle SETITEMS with an odd item count"));
		}
		let target = match self.top()? {
			Value::Dict(items) => items.clone(),
			Value::Call { items, .. } => items.clone(),
			other => return Err(fail!("pickle SETITEMS on {other:?}")),
		};
		let mut target = target.borrow_mut();
		let mut iter = pairs.into_iter();
		while let (Some(key), Some(value)) = (iter.next(), iter.next()) {
			target.push((key, value));
		}
		Ok(())
	}

	fn append(&mut self, values: Vec<Value>) -> Result<()> {
		match self.top()? {
			Value::List(items) => {
				items.borrow_mut().extend(values);
				Ok(())
			}
			other => Err(fail!("pickle APPENDS on {other:?}")),
		}
	}

	fn run(mut self) -> Result<Value> {
		loop {
			let at = self.pos;
			let op = self.byte()?;
			match op {
				0x80 => {
					self.byte()?;
				}
				0x95 => {
					self.take(8)?;
				}
				b'.' => return self.pop(),
				b'(' => self.stack.push(Slot::Mark),
				b'N' => self.push(Value::None),
				0x88 => self.push(Value::Bool(true)),
				0x89 => self.push(Value::Bool(false)),
				b'K' => {
					let v = self.byte()?;
					self.push(Value::Int(i64::from(v)));
				}
				b'M' => {
					let v = self.u16()?;
					self.push(Value::Int(i64::from(v)));
				}
				b'J' => {
					let v = self.u32()? as i32;
					self.push(Value::Int(i64::from(v)));
				}
				0x8a => {
					let n = usize::from(self.byte()?);
					let bytes = self.take(n)?;
					if n > 8 {
						return Err(fail!("pickle LONG1 of {n} bytes does not fit in 64 bits"));
					}
					let mut buf = [0u8; 8];
					buf[..n].copy_from_slice(bytes);
					if n > 0 && bytes[n - 1] & 0x80 != 0 {
						buf[n..].fill(0xff);
					}
					self.push(Value::Int(i64::from_le_bytes(buf)));
				}
				b'G' => {
					let bytes = self.take(8)?;
					self.push(Value::Float(f64::from_be_bytes(bytes.try_into().expect("8 bytes"))));
				}
				b'X' => {
					let n = self.u32()? as usize;
					let value = self.utf8(n)?;
					self.push(value);
				}
				0x8c => {
					let n = usize::from(self.byte()?);
					let value = self.utf8(n)?;
					self.push(value);
				}
				b'C' => {
					let n = usize::from(self.byte()?);
					let bytes = self.take(n)?.to_vec();
					self.push(Value::Bytes(bytes));
				}
				b'B' => {
					let n = self.u32()? as usize;
					let bytes = self.take(n)?.to_vec();
					self.push(Value::Bytes(bytes));
				}
				b')' => self.push(Value::Tuple(Vec::new())),
				b'}' => self.push(Value::Dict(Rc::new(RefCell::new(Vec::new())))),
				b']' => self.push(Value::List(Rc::new(RefCell::new(Vec::new())))),
				b't' => {
					let items = self.pop_mark()?;
					self.push(Value::Tuple(items));
				}
				0x85..=0x87 => {
					let n = usize::from(op - 0x84);
					let mut items = Vec::with_capacity(n);
					for _ in 0..n {
						items.push(self.pop()?);
					}
					items.reverse();
					self.push(Value::Tuple(items));
				}
				b'q' => {
					let key = u32::from(self.byte()?);
					self.memo_put(key)?;
				}
				b'r' => {
					let key = self.u32()?;
					self.memo_put(key)?;
				}
				0x94 => {
					let key = self.memo.len() as u32;
					self.memo_put(key)?;
				}
				b'h' => {
					let key = u32::from(self.byte()?);
					self.memo_get(key)?;
				}
				b'j' => {
					let key = self.u32()?;
					self.memo_get(key)?;
				}
				b'c' => {
					let module = self.line()?;
					let name = self.line()?;
					self.push(Value::Global { module, name });
				}
				0x93 => {
					let name = self.pop()?;
					let module = self.pop()?;
					match (module, name) {
						(Value::Str(module), Value::Str(name)) => self.push(Value::Global { module, name }),
						_ => return Err(fail!("pickle STACK_GLOBAL without two strings")),
					}
				}
				b'Q' => {
					let pid = self.pop()?;
					self.push(Value::Persistent(Box::new(pid)));
				}
				b'R' => {
					let args = self.pop()?;
					let callable = self.pop()?;
					self.push(Value::Call {
						callable: Box::new(callable),
						args: Box::new(args),
						items: Rc::new(RefCell::new(Vec::new())),
					});
				}
				b'u' => {
					let pairs = self.pop_mark()?;
					self.set_items(pairs)?;
				}
				b's' => {
					let value = self.pop()?;
					let key = self.pop()?;
					self.set_items(vec![key, value])?;
				}
				b'e' => {
					let values = self.pop_mark()?;
					self.append(values)?;
				}
				b'a' => {
					let value = self.pop()?;
					self.append(vec![value])?;
				}
				// BUILD sets an object's state, such as an `OrderedDict`'s `_metadata`. The state dict's tensors do not
				// depend on it, so the state is dropped and the object kept.
				b'b' => {
					self.pop()?;
				}
				other => return Err(fail!("pickle opcode 0x{other:02x} at byte {at} is not supported")),
			}
		}
	}
}

/// Runs a pickle and returns the value its `STOP` leaves.
pub fn load(data: &[u8]) -> Result<Value> {
	Machine {
		data,
		pos: 0,
		stack: Vec::new(),
		memo: HashMap::new(),
	}
	.run()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn reads_a_protocol_2_dict_of_mixed_values() {
		// {"a": 1, "b": (2.5, "x", None, True), "c": -300} in protocol 2, the four-item tuple as MARK ... TUPLE.
		let data = [
			0x80, 0x02, b'}', b'q', 0x00, b'(', b'X', 1, 0, 0, 0, b'a', b'K', 0x01, b'X', 1, 0, 0, 0, b'b', b'(', b'G',
			0x40, 0x04, 0, 0, 0, 0, 0, 0, b'X', 1, 0, 0, 0, b'x', b'N', 0x88, b't', b'X', 1, 0, 0, 0, b'c', b'J', 0xd4,
			0xfe, 0xff, 0xff, b'u', b'.',
		];
		let value = load(&data).unwrap();
		let entries = value.entries().unwrap();
		assert_eq!(entries.len(), 3);
		assert_eq!(entries[0].0.as_str(), Some("a"));
		assert_eq!(entries[0].1.as_int(), Some(1));
		let tuple = entries[1].1.as_tuple().unwrap();
		assert!(matches!(tuple[0], Value::Float(f) if f == 2.5));
		assert_eq!(tuple[1].as_str(), Some("x"));
		assert!(matches!(tuple[2], Value::None));
		assert!(matches!(tuple[3], Value::Bool(true)));
		assert_eq!(entries[2].1.as_int(), Some(-300));
	}

	#[test]
	fn memo_shares_a_dict_filled_after_it_was_stored() {
		// d = {}; [d, d] with d filled between: EMPTY_DICT BINPUT 0, MARK key value SETITEMS, then BINGET 0, TUPLE2.
		let data = [
			0x80, 0x02, b'}', b'q', 0x00, b'(', b'X', 1, 0, 0, 0, b'k', b'K', 0x07, b'u', b'h', 0x00, 0x86, b'.',
		];
		let value = load(&data).unwrap();
		let pair = value.as_tuple().unwrap();
		assert_eq!(pair[0].entries().unwrap().len(), 1);
		assert_eq!(pair[1].entries().unwrap().len(), 1);
	}

	#[test]
	fn refuses_an_unknown_opcode_by_name() {
		let error = load(&[0x80, 0x02, b'i']).unwrap_err();
		assert!(error.0.contains("0x69"), "{error}");
	}

	#[test]
	fn long1_sign_extends() {
		let value = load(&[0x80, 0x02, 0x8a, 0x02, 0x00, 0xff, b'.']).unwrap();
		assert_eq!(value.as_int(), Some(-256));
	}
}
