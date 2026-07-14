/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   AboutDemo — a collapsible explainer box that describes the major pieces of the Mailwoman browser
 *   demo to a first-time visitor. Intended to sit at the top of the controls panel on both the full
 *   demo page and the PipelineExplorer embed.
 *
 *   The content covers: the model architecture, confidence color thresholds, the WOF resolver, the
 *   slim subset limits, and the FST prior — without duplicating the docs site proper.
 */

import BrowserOnly from "@docusaurus/BrowserOnly"
import React from "react"

import styles from "./styles.module.css"

// ---------------------------------------------------------------------------
// Inner component (below BrowserOnly boundary)
// ---------------------------------------------------------------------------

const AboutDemoInner: React.FC = () => {
	return (
		<details className={styles.aboutDemo}>
			<summary className={styles.summary}>
				<span className={styles.summaryIcon}>ℹ️</span>
				About this demo
			</summary>
			<div className={styles.body}>
				<section className={styles.section}>
					<h3 className={styles.sectionHeading}>Neural model</h3>
					<p>
						A 33.9M-parameter BERT-style encoder classifies each token into one of 33 BIO labels covering 16 address
						components (street, house number, unit, locality, region, postcode, venue, country, intersection, etc.). It
						runs entirely in your browser via <strong>onnxruntime-web</strong> (WebGPU with WASM SIMD fallback). The
						model ships as a 36.8 MB int8-quantized ONNX bundle; fp32 weights are also available for higher accuracy.
					</p>
				</section>

				<section className={styles.section}>
					<h3 className={styles.sectionHeading}>Confidence colors</h3>
					<p>
						Every classified span carries a confidence score between 0 and 1. The colors in the results table give you a
						quick visual read:
					</p>
					<ul className={styles.confLegend}>
						<li className={styles.confItem}>
							<span className={`${styles.swatch} ${styles.swatchHigh}`} />
							<strong>Green</strong> (≥ 0.8) — high confidence. The model is nearly certain.
						</li>
						<li className={styles.confItem}>
							<span className={`${styles.swatch} ${styles.swatchMid}`} />
							<strong>Amber</strong> (0.5–0.8) — moderate confidence. Worth verifying.
						</li>
						<li className={styles.confItem}>
							<span className={`${styles.swatch} ${styles.swatchLow}`} />
							<strong>Red</strong> (&lt; 0.5) — low confidence. The model is unsure — likely wrong.
						</li>
					</ul>
					<p>
						These are raw model scores. For honest probabilities, the library ships a per-locale isotonic calibrator (
						<code>calibration.json</code>) that maps the raw scores to well-calibrated probability estimates.
					</p>
				</section>

				<section className={styles.section}>
					<h3 className={styles.sectionHeading}>WOF resolver</h3>
					<p>
						After classification, the resolver queries a <strong>Who&apos;s On First</strong> (WOF) SQLite gazetteer to
						match the parsed components — locality, region, and postcode — against real-world places with coordinates.
						The cascade tries postcode first (most precise), then locality, then the raw input text. The result is a
						sorted list of candidate places with WOF IDs, placetypes, lat/lon, and bounding boxes.
					</p>
				</section>

				<section className={styles.section}>
					<h3 className={styles.sectionHeading}>WOF slim subset (&quot;hot&quot; DB)</h3>
					<p>
						The full WOF database is ~70 GB and covers every place on Earth. The demo uses a slim
						<strong>&quot;hot&quot; subset</strong> (~35 MB) that includes major US localities, postcodes, and regions —
						enough to resolve most real US addresses. It loads via <strong>sql.js-httpvfs</strong>, which range-requests
						only the pages it needs from the same-origin server, so your browser fetches ~5 MB per session instead of
						the whole file.
					</p>
				</section>

				<section className={styles.section}>
					<h3 className={styles.sectionHeading}>FST prior</h3>
					<p>
						A <strong>finite-state transducer</strong> (FST) built from ~94K US place names runs before the neural
						classifier. It pre-annotates known locality, region, and postcode spans in the input — places like
						&quot;Springfield&quot; or &quot;Cook County&quot; that the FST can match exactly. These &quot;FST
						prior&quot; hits feed the classifier as strong hints, improving locality and region recall on addresses
						where the neural model alone might miss them. The FST shipped in v4.0.0 and is active whenever the selected
						release includes it.
					</p>
				</section>
			</div>
		</details>
	)
}

// ---------------------------------------------------------------------------
// Public component (SSR-safe via BrowserOnly — Docusaurus renders <details> as
// plain HTML on the server, but the collapsible behavior needs the client.)
// ---------------------------------------------------------------------------

export const AboutDemo: React.FC = () => {
	return <BrowserOnly fallback={<p>Loading demo info…</p>}>{() => <AboutDemoInner />}</BrowserOnly>
}
