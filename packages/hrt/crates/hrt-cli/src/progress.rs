// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Progress lines on stderr while a build runs.
//!
//! A build prints one line when each stage starts and, from a background thread, one line per interval while the
//! stage runs. A line gives the elapsed time, the stage, the stage's count and rate, and during tile encoding the zoom
//! being written and how far through that zoom's tile ids the encoder is.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use hrt_pmtiles::tile_id_to_zxy;

/// The interval between progress lines while a stage runs.
const INTERVAL: Duration = Duration::from_secs(30);

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
}

impl Shared {
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
