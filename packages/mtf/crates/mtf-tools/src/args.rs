// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The command line: a command name, positional arguments, and `--name value` or `--name=value` options.

use std::collections::HashMap;

pub type Result<T> = std::result::Result<T, String>;

pub struct Args {
	pub command: String,
	positional: Vec<String>,
	options: HashMap<String, Vec<String>>,
}

impl Args {
	pub fn parse(argv: Vec<String>) -> Result<Self> {
		let mut iter = argv.into_iter();
		let command = iter.next().ok_or("usage: mtf-tokenizer <command> [options]")?;
		let mut positional = Vec::new();
		let mut options: HashMap<String, Vec<String>> = HashMap::new();
		while let Some(arg) = iter.next() {
			let Some(name) = arg.strip_prefix("--") else {
				positional.push(arg);
				continue;
			};
			let (name, value) = match name.split_once('=') {
				Some((n, v)) => (n.to_owned(), v.to_owned()),
				None => {
					let value = iter.next().ok_or_else(|| format!("--{name} needs a value"))?;
					(name.to_owned(), value)
				}
			};
			options.entry(name).or_default().push(value);
		}
		Ok(Self {
			command,
			positional,
			options,
		})
	}

	pub fn positional(&self, index: usize, what: &str) -> Result<&str> {
		self.positional
			.get(index)
			.map(String::as_str)
			.ok_or_else(|| format!("{}: missing the {what} argument", self.command))
	}

	pub fn optional(&self, name: &str) -> Option<&str> {
		self.options.get(name).and_then(|v| v.last()).map(String::as_str)
	}

	pub fn required(&self, name: &str) -> Result<&str> {
		self.optional(name)
			.ok_or_else(|| format!("{}: --{name} is required", self.command))
	}

	/// Every value given for a repeatable option, in order.
	pub fn all(&self, name: &str) -> Vec<&str> {
		self.options
			.get(name)
			.map(|v| v.iter().map(String::as_str).collect())
			.unwrap_or_default()
	}

	pub fn number<T: std::str::FromStr>(&self, name: &str) -> Result<Option<T>> {
		self.optional(name)
			.map(|v| v.parse::<T>().map_err(|_| format!("--{name} is not a number: {v:?}")))
			.transpose()
	}
}
