# @mailwoman/astrogeology

The planetary data pipeline behind `moon.mailwoman.ai` and `mars.mailwoman.ai`. It turns two USGS Astrogeology products, the planetary nomenclature gazetteer and the LOLA and MOLA global elevation models, into the artifacts the planetary app serves: a nomenclature PMTiles archive, a hillshade PMTiles archive, a search artifact and a build manifest with checksums, per body.

Private: this workspace never publishes. The artifacts it builds are published to the public bucket through `mailwoman tiles publish`.

Spec: `docs/superpowers/specs/2026-09-06-astrogeology-pipeline-design.md`. Plan: `docs/superpowers/plans/2026-09-07-astrogeology-pipeline.md`.
