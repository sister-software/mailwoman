// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from the basemaps fork's layers/Transit.java (BSD-3-Clause, Protomaps).

//! The `transit` layer. The fork's `Transit.processOsm` emits no features, so the layer is declared and stays empty;
//! railways are drawn by the roads layer.

pub const LAYER_NAME: &str = "transit";
