/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `About` — the collapsible explainer for the browser geocoder: the neural model, the confidence colours, the
 *   gazetteer resolver, the byte-range database and the FST prior. Prose about the product a host places above or
 *   beside the geocoder; it renders nothing live.
 */

import type { ReactNode } from "react"

export function About(): ReactNode {
	return (
		<details className="mw-about">
			<summary className="mw-about__summary">
				<span className="mw-about__icon">ℹ️</span>
				About this geocoder
			</summary>
			<div className="mw-about__body">
				<section className="mw-about__section">
					<h3 className="mw-about__heading">Neural model</h3>
					<p>
						A ~29M-parameter BERT-style encoder classifies each token into one of 33 BIO labels covering 16 address
						components (street, house number, unit, locality, region, postcode, venue, country, intersection, etc.). It
						runs entirely in your browser via <strong>onnxruntime-web</strong> (WebGPU with WASM SIMD fallback). The
						model ships as a 37.6 MB int8-quantized ONNX bundle; fp32 weights are also available for higher accuracy.
					</p>
				</section>

				<section className="mw-about__section">
					<h3 className="mw-about__heading">Confidence colors</h3>
					<p>
						Every classified span carries a confidence score between 0 and 1. The colors in the results table give you a
						quick visual read:
					</p>
					<ul className="mw-about__legend">
						<li className="mw-about__item">
							<span className="mw-about__swatch mw-about__swatch--high" />
							<strong>Green</strong> (≥ 0.8) — high confidence. The model is nearly certain.
						</li>
						<li className="mw-about__item">
							<span className="mw-about__swatch mw-about__swatch--mid" />
							<strong>Amber</strong> (0.5–0.8) — moderate confidence. Worth verifying.
						</li>
						<li className="mw-about__item">
							<span className="mw-about__swatch mw-about__swatch--low" />
							<strong>Red</strong> (&lt; 0.5) — low confidence. The model is unsure — likely wrong.
						</li>
					</ul>
					<p>
						These are raw model scores. For calibrated probabilities, the library ships a per-locale isotonic calibrator
						(<code>calibration.json</code>) that maps the raw scores to well-calibrated probability estimates.
					</p>
				</section>

				<section className="mw-about__section">
					<h3 className="mw-about__heading">WOF resolver</h3>
					<p>
						After classification, the resolver queries a <strong>Who&apos;s On First</strong> (WOF) SQLite gazetteer to
						match the parsed components — locality, region, and postcode — against real-world places with coordinates.
						The cascade tries postcode first (most precise), then locality, then the raw input text. The result is a
						sorted list of candidate places with WOF IDs, placetypes, lat/lon, and bounding boxes.
					</p>
				</section>

				<section className="mw-about__section">
					<h3 className="mw-about__heading">Byte-range gazetteer</h3>
					<p>
						The gazetteer is a multi-gigabyte SQLite file served from a public bucket. It loads via{" "}
						<strong>sql.js-httpvfs</strong>, which range-requests only the pages a lookup touches, so your browser
						fetches a few hundred kilobytes per session instead of the whole file.
					</p>
				</section>

				<section className="mw-about__section">
					<h3 className="mw-about__heading">FST prior</h3>
					<p>
						A <strong>finite-state transducer</strong> (FST) built from ~94K US place names runs before the neural
						classifier. It pre-annotates known locality, region, and postcode spans in the input — places like
						&quot;Springfield&quot; or &quot;Cook County&quot; that the FST can match exactly. These &quot;FST
						prior&quot; hits feed the classifier as strong hints, improving locality and region recall on addresses
						where the neural model alone might miss them. The FST is active whenever the selected release includes it.
					</p>
				</section>
			</div>
		</details>
	)
}
