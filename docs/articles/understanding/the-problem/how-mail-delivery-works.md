---
sidebar_position: 2
title: How mail delivery actually works
tags:
  - domain
  - motivation
  - en-us
  - international
---

# How mail delivery actually works

Before you can judge a parser, you need to know what it is parsing _for_. Address parsing is not an academic exercise in string labelling — it exists to route physical objects to physical places through a system designed in the 19th century and patched ever since.

This article walks through what happens when you mail a letter. The point is not the mechanics. The point is that the postal system is **already fuzzy** — it handles ambiguity through human intervention, local knowledge, and layered fallbacks — and a parser that is honest about its own uncertainty is more faithful to the real world than one that returns a confident wrong answer.

## Step 1 — Collection

You drop a letter in a blue box or hand it to a carrier. The letter enters the USPS network at the nearest **processing and distribution center** (P&DC). There are about 250 of these in the United States. Each one serves a region roughly the size of a congressional district.

At this point, nobody has read your address. The letter is in a bin with thousands of others, sorted only by rough destination zone. The destination ZIP code — not the street address — determines which P&DC it goes to next. This is the first hint that the postal system cares about routing codes more than precise addresses.

## Step 2 — OCR and the Remote Encoding Center

At the destination P&DC, the letter passes through an **optical character reader** at about 10 letters per second. The OCR tries to read the address block and resolve it to an 11-digit **delivery point code** — ZIP+4 plus the last two digits of the street number or PO box. If it succeeds, the letter gets a barcode sprayed on the envelope and proceeds to sorting. About **85-90%** of machine-printed mail passes OCR on the first pass.

If the OCR cannot read the address — handwriting, smudged ink, non-standard formatting, foreign scripts — the system takes a photograph of the envelope and sends it to a **Remote Encoding Center** (REC). A human operator at a keyboard sees the photograph for about **two seconds** and types the ZIP code. Another human sees the street number and street name. Between them, they produce enough information for the sorting machines to route it.

The RECs handle roughly **200 million pieces per year**. That is 200 million pieces where the machine gave up and a human squinted at bad handwriting and figured it out anyway. This is the postal equivalent of graceful degradation. The system does not fail on bad input — it escalates.

## Step 3 — ZIP+4 resolution

The 5-digit ZIP code gets the letter to the right post office. The **+4 extension** gets it to the right carrier route or building. The full 11-digit delivery point code gets it to the right mailbox.

ZIP codes are not polygons. They are **carrier routes** — the sequence a postal carrier walks or drives. A ZIP code boundary follows streets, not census blocks. It can change when a carrier retires and routes get redrawn. The US Census Bureau publishes ZIP Code Tabulation Areas (ZCTAs) as an approximation, but ZCTAs are not USPS ground truth and USPS explicitly disclaims them. If you are geocoding by ZIP centroid and calling it "the address," you are off by anywhere from a few hundred feet to several miles, and the error is systematic for rural areas.

The +4 extension narrows this: it maps to a block face (one side of one street between two cross streets), a single large building, or a PO box section. The delivery point code narrows further: the specific mailbox.

## Step 4 — Carrier delivery

The letter arrives at the destination post office, sorted into trays by carrier route and walk sequence. The carrier loads their vehicle (or satchel) and delivers.

Carriers possess **local knowledge** that no database has. They know that the blue house on Elm Street is 142 Elm, even though the mailbox says 140. They know that the new apartment building at the end of the block uses the address of the demolished warehouse that stood there before, because USPS hasn't updated the delivery sequence yet. They know that the occupant of 15 Main Street moved to Florida six months ago and mail should be forwarded.

This is the deepest layer of the postal system's fuzziness: the human at the end of the chain who overrides the machine's decisions. It is not an edge case — it is how the system works every day.

## Step 5 — What happens when the address is wrong

If the address is malformed enough that even the REC operators cannot resolve it, the letter goes to **dead letter** processing. The Mail Recovery Center in Atlanta tries to identify the sender or recipient from the contents. If it cannot, the letter is destroyed or auctioned.

But usually, wrong addresses get handled earlier:

- **Return to sender.** If the address exists but the recipient has moved, the letter gets a yellow sticker and goes back.
- **Forwarding.** If the recipient filed a change-of-address, the letter gets a new barcode and continues to the new destination. Forwarding orders last 12 months for first-class mail; after that, mail is returned.
- **Carrier correction.** The carrier knows the delivery point. If the address is close but not quite right ("142 Elm" when the mailbox says "140"), the carrier corrects it without returning it. This is friction, but it works often enough that the system tolerates it.

## What this means for a parser

The postal system has **four layers of ambiguity resolution**, escalating from cheapest to most expensive:

| Layer                           | Mechanism     | Cost                     | Success rate               |
| ------------------------------- | ------------- | ------------------------ | -------------------------- |
| 1. OCR + delivery point barcode | Machine       | Near zero                | ~85-90%                    |
| 2. Remote Encoding Center       | Human typing  | ~$0.03/piece             | Most of the remaining ~10% |
| 3. Carrier local knowledge      | Human walking | ~$0.50/piece (amortized) | Most of the rest           |
| 4. Dead letter / return         | Disposal      | ~$1.00+                  | The rest                   |

A parser that returns **"I'm 70% sure this is Springfield IL, 25% Springfield MA, 5% Springfield MO"** is mimicking Layer 2 — human triage — before the letter ever leaves the sender's computer. It tells the downstream system: "you need more information before you can route this." That is _more honest_ than returning "Springfield IL" with 98% confidence because the gazetteer has a population-weighted default.

The design principle for Mailwoman's confidence model: **a low-confidence correct answer is better than a high-confidence wrong one.** The postal system already works this way. The carrier would rather get an envelope that says "maybe 142 Elm St?" than one that says "definitely 140 Elm St" when the correct address is 142. The machine said it was uncertain — the human can fix it. The machine said it was certain, so the human didn't look.

## See also

- [How humans break addresses](../why-its-hard/how-humans-break-addresses.md) — the failure taxonomy the parser must handle
- [The database fallacy](../why-its-hard/the-database-fallacy.md) — why there is no master list of all addresses
- [The 90% trap](../why-its-hard/the-90-percent-trap.md) — why the 90% that works isn't enough
