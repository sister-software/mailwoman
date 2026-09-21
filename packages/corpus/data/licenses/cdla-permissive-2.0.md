# Community Data License Agreement — Permissive, Version 2.0 — as retrieved

- Source: `https://raw.githubusercontent.com/spdx/license-list-data/main/text/CDLA-Permissive-2.0.txt`
- Retrieved: 2026-09-21
- Publisher: The Linux Foundation, as the steward of the agreement
- Version stated in the text: 2.0

This is the grant the Overture Maps Foundation places its Places theme under, which is the `poi`
runtime bundle. The text was taken from the SPDX license list rather than from `cdla.dev`, because
SPDX publishes it as plain text and the two carry the same words.

## Sharing the data, quoted

> 2.1. A Data Recipient may share Data, with or without modifications, so long as the Data Recipient
> makes available the text of this agreement with the shared Data.

That is the one condition the agreement places on redistributing the database, and it is a condition
to supply this text rather than to name a contributor. This repository hosts `poi.db` for download,
so the condition attaches to that hosting, which is why this file is committed.

## A model trained on the data, quoted

> 3. No Restrictions on Results
>
> 3.1. This agreement does not impose any restriction or obligations with respect to the use,
> modification, or sharing of Results.

> 5.4. "Results" means any outcome obtained by computational analysis of Data, including for example
> machine learning models and models' insights.

Read together, the agreement states that a machine-learning model is a Result and that it carries no
restriction or obligation under the agreement. Among the grants this repository reads, this is the
one that addresses a trained model in its own text rather than leaving it to be argued from the
definition of a derived work.

Two things that does not establish. It says nothing about the terms of whatever sources Overture
itself drew each row from, which the `poi` bundle's record still carries as an open question. And it
is a statement about this agreement alone, so it does not decide the question for any other source.

## What this text does not settle

Nothing here is elected. The `poi` bundle's record cites these terms and no license decision in
`address-source-register.json` reads anything but `unchecked`.
