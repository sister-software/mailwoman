// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Mailwoman's training-row sampler.
//!
//! The sampler must draw the rows the Python sampler draws, so its randomness comes from [`pyrandom::PyRandom`], which
//! reproduces CPython 3.12's `random.Random` for the methods the sampler and the corpus builders call.

pub mod pyrandom;
