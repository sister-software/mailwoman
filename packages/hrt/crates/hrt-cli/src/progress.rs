// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Progress lines on stderr while a build runs.
//!
//! A build prints one line when each stage starts and, from a background thread, one line per interval while the
//! stage runs. A line gives the elapsed time, the stage, the stage's count and rate, and during tile encoding the zoom
//! being written and how far through that zoom's tile ids the encoder is.
//!
//! Each thread also records the feature or tile it is working on. The background thread prints a `running` line for
//! work that has run for [`SLOW`] or longer, and the thread prints a `slow` line with the duration when such work ends.

use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use hrt_pmtiles::tile_id_to_zxy;

/// The interval between progress lines while a stage runs.
const INTERVAL: Duration = Duration::from_secs(30);

/// Work that runs this long or longer is reported while it runs and when it ends.
const SLOW: Duration = Duration::from_secs(60);

/// The feature or tile one thread is working on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Work {
	Node(i64),
	Way(i64),
	Relation(i64),
	/// A feature from a source other than OpenStreetMap, by its id in that source.
	Other(i64),
	/// A tile being encoded, by its PMTiles tile id.
	Tile(u64),
}

impl Work {
	fn tag(self) -> u64 {
		match self {
			Work::Node(_) => 1,
			Work::Way(_) => 2,
			Work::Relation(_) => 3,
			Work::Other(_) => 4,
			Work::Tile(_) => 5,
		}
	}

	fn bits(self) -> u64 {
		match self {
			Work::Node(id) | Work::Way(id) | Work::Relation(id) | Work::Other(id) => id as u64,
			Work::Tile(id) => id,
		}
	}

	fn from_parts(tag: u64, bits: u64) -> Option<Work> {
		match tag {
			1 => Some(Work::Node(bits as i64)),
			2 => Some(Work::Way(bits as i64)),
			3 => Some(Work::Relation(bits as i64)),
			4 => Some(Work::Other(bits as i64)),
			5 => Some(Work::Tile(bits)),
			_ => None,
		}
	}
}

impl fmt::Display for Work {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match *self {
			Work::Node(id) => write!(f, "node {id}"),
			Work::Way(id) => write!(f, "way {id}"),
			Work::Relation(id) => write!(f, "relation {id}"),
			Work::Other(id) => write!(f, "source feature {id}"),
			Work::Tile(id) => {
				let (z, x, y) = tile_id_to_zxy(id);
				write!(f, "tile {z}/{x}/{y}")
			}
		}
	}
}

/// One thread's current work. `tag` is zero while the thread is idle. The fields are written separately, so a reader
/// can see a mix of two consecutive pieces of work; the lines are diagnostics and tolerate that.
#[derive(Default)]
struct Slot {
	tag: AtomicU64,
	bits: AtomicU64,
	/// Milliseconds from the build's start to the work's start.
	started_ms: AtomicU64,
}

struct Stage {
	name: &'static str,
	unit: &'static str,
	started: Instant,
}

struct Shared {
	started: Instant,
	stage: Mutex<Stage>,
	count: AtomicU64,
	/// The tile id last written, plus one, during encoding. Zero before the first tile.
	tile: AtomicU64,
	done: AtomicBool,
	wake: Condvar,
	wake_lock: Mutex<()>,
	/// One slot per rayon thread and a last one shared by every other thread.
	slots: Vec<Slot>,
}

impl Shared {
	fn millis(&self) -> u64 {
		self.started.elapsed().as_millis() as u64
	}

	/// Prints a `running` line for each piece of work that has run for [`SLOW`] or longer.
	fn report_running(&self) {
		let now = self.millis();
		for slot in &self.slots {
			let Some(work) = Work::from_parts(slot.tag.load(Ordering::Acquire), slot.bits.load(Ordering::Relaxed))
			else {
				continue;
			};
			let running = Duration::from_millis(now.saturating_sub(slot.started_ms.load(Ordering::Relaxed)));
			if running >= SLOW {
				eprintln!(
					"progress {} running: {work} for {}",
					clock(self.started.elapsed()),
					clock(running)
				);
			}
		}
	}

	fn line(&self) -> String {
		let stage = self.stage.lock().unwrap();
		let count = self.count.load(Ordering::Relaxed);
		let stage_seconds = stage.started.elapsed().as_secs_f64();
		let mut line = format!("progress {} {}", clock(self.started.elapsed()), stage.name);
		if !stage.unit.is_empty() {
			let rate = if stage_seconds > 0.0 {
				count as f64 / stage_seconds
			} else {
				0.0
			};
			line += &format!(": {count} {} ({rate:.0}/s)", stage.unit);
		}
		let tile = self.tile.load(Ordering::Relaxed);
		if tile > 0 {
			let id = tile - 1;
			let (z, _, _) = tile_id_to_zxy(id);
			let first = zoom_start(z);
			let span = zoom_start(z + 1) - first;
			line += &format!(
				"; at z{z}, {:.1}% of its tile ids",
				100.0 * (id - first) as f64 / span as f64
			);
		}
		line
	}
}

/// The first tile id of zoom `z`: the count of tiles at every lower zoom.
fn zoom_start(z: u8) -> u64 {
	((1u64 << (2 * u32::from(z))) - 1) / 3
}

fn clock(elapsed: Duration) -> String {
	let seconds = elapsed.as_secs();
	format!("{}:{:02}:{:02}", seconds / 3600, seconds / 60 % 60, seconds % 60)
}

/// Prints build progress to stderr until it is dropped.
pub struct Progress {
	shared: Arc<Shared>,
	thread: Option<JoinHandle<()>>,
}

impl Progress {
	pub fn start() -> Progress {
		let now = Instant::now();
		let shared = Arc::new(Shared {
			started: now,
			stage: Mutex::new(Stage {
				name: "starting",
				unit: "",
				started: now,
			}),
			count: AtomicU64::new(0),
			tile: AtomicU64::new(0),
			done: AtomicBool::new(false),
			wake: Condvar::new(),
			wake_lock: Mutex::new(()),
			slots: (0..=rayon::current_num_threads()).map(|_| Slot::default()).collect(),
		});
		let worker = Arc::clone(&shared);
		let thread = std::thread::spawn(move || {
			// The thread holds the lock except while it waits, and the drop sets `done` before it takes the lock to
			// notify. A drop before the first wait is seen by the check above the wait.
			let mut guard = worker.wake_lock.lock().unwrap();
			loop {
				if worker.done.load(Ordering::Relaxed) {
					break;
				}
				guard = worker.wake.wait_timeout(guard, INTERVAL).unwrap().0;
				if worker.done.load(Ordering::Relaxed) {
					break;
				}
				eprintln!("{}", worker.line());
				worker.report_running();
			}
		});
		Progress {
			shared,
			thread: Some(thread),
		}
	}

	/// Starts a stage, resetting the count. `unit` names what the count counts, or is empty for a stage without one.
	pub fn stage(&self, name: &'static str, unit: &'static str) {
		{
			let mut stage = self.shared.stage.lock().unwrap();
			*stage = Stage {
				name,
				unit,
				started: Instant::now(),
			};
		}
		self.shared.count.store(0, Ordering::Relaxed);
		eprintln!("progress {} {name}: started", clock(self.shared.started.elapsed()));
	}

	/// Adds to the current stage's count.
	pub fn add(&self, amount: u64) {
		self.shared.count.fetch_add(amount, Ordering::Relaxed);
	}

	/// Adds one to the current stage's count from a hot loop on many threads.
	///
	/// Each thread counts locally and adds to the shared count every 4,096 calls, so the threads do not contend on
	/// one counter. The count a line prints can trail by up to 4,095 per thread.
	pub fn tick(&self) {
		thread_local! {
			static LOCAL: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
		}
		LOCAL.with(|local| {
			let value = local.get() + 1;
			if value == 4096 {
				self.add(value);
				local.set(0);
			} else {
				local.set(value);
			}
		});
	}

	/// Records the tile id the encoder last wrote.
	pub fn tile(&self, id: u64) {
		self.shared.tile.store(id + 1, Ordering::Relaxed);
	}

	/// Records that this thread is working on `work` until the returned guard drops.
	///
	/// The work is reported while it runs once it has run for [`SLOW`], and its duration is printed when it ends.
	pub fn working(&self, work: Work) -> Working<'_> {
		let slots = &self.shared.slots;
		let index = rayon::current_thread_index().map_or(slots.len() - 1, |index| index.min(slots.len() - 1));
		let slot = &slots[index];
		let started = Instant::now();
		slot.bits.store(work.bits(), Ordering::Relaxed);
		slot.started_ms.store(self.shared.millis(), Ordering::Relaxed);
		slot.tag.store(work.tag(), Ordering::Release);
		Working {
			shared: &self.shared,
			slot,
			work,
			started,
		}
	}
}

/// A thread's record of its current work, cleared when dropped.
pub struct Working<'a> {
	shared: &'a Shared,
	slot: &'a Slot,
	work: Work,
	started: Instant,
}

impl Working<'_> {
	/// The time since the work started.
	pub fn elapsed(&self) -> Duration {
		self.started.elapsed()
	}
}

impl Drop for Working<'_> {
	fn drop(&mut self) {
		self.slot.tag.store(0, Ordering::Release);
		let took = self.started.elapsed();
		if took >= SLOW {
			eprintln!(
				"progress {} slow: {} took {}",
				clock(self.shared.started.elapsed()),
				self.work,
				clock(took)
			);
		}
	}
}

impl Drop for Progress {
	fn drop(&mut self) {
		self.shared.done.store(true, Ordering::Relaxed);
		{
			let _guard = self.shared.wake_lock.lock().unwrap();
			self.shared.wake.notify_all();
		}
		if let Some(thread) = self.thread.take() {
			let _ = thread.join();
		}
		eprintln!("progress {} done", clock(self.shared.started.elapsed()));
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use hrt_pmtiles::tile_id;

	#[test]
	fn zoom_start_is_the_first_tile_id_of_each_zoom() {
		for z in 0..=15u8 {
			assert_eq!(zoom_start(z), tile_id(z, 0, 0));
		}
	}

	#[test]
	fn a_line_during_encoding_gives_the_zoom_and_its_share_of_tile_ids() {
		let progress = Progress::start();
		progress.stage("encode", "tiles");
		progress.add(10);
		progress.tile(zoom_start(3));
		let line = progress.shared.line();
		assert!(line.contains("encode: 10 tiles"), "{line}");
		assert!(line.contains("at z3, 0.0% of its tile ids"), "{line}");
	}
}
