# Which locales need the German treatment, and which don't (2026-06-02)

The German coverage shard taught the model one thing: addresses where the house number comes after
the street and the postcode comes before the city. Before generalizing that recipe to more locales,
it's worth knowing which locales actually have that problem, because "the parser is bad at European
addresses" is not one bug. A spot-check of the v0.7.2 parser against a handful of native-order
addresses per locale sorts them into three groups.

## The map

| locale | convention                                         | what the parser does                                                                       | the fix                          |
| ------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------- |
| DE     | house after street, postcode before city           | `Hauptstraße 5` → street=`Hauptstraße 5` (house swallowed)                                 | order shard (done)               |
| ES     | house after street, postcode before city           | `Calle Mayor 12` → street=`Calle Mayor 12`                                                 | **same order shard**             |
| IT     | house after street, postcode before city           | `Via Roma 12` → street=`Via Roma 12`                                                       | **same order shard**             |
| NL     | house after street, `1012 LM` postcode before city | `Damrak 70, 1012 LM Amsterdam` → street tagged venue, `locality: "LM Amsterdam"`           | order shard + Dutch postcode     |
| GB     | house **first**, alphanumeric postcode last        | `10 Downing Street, London SW1A 2AA` → house+street correct, `locality: "London SW1A 2AA"` | postcode coverage, **not** order |

## What this means for the recipe

ES and IT are German all over again. They share the exact convention the model never learned, and
they fail the exact same way: the house number gets absorbed into the street span because the model
expects the number first. The `synthesize-german.ts` approach (real OpenAddresses tuples rendered in
locale order through the OpenCage template) drops straight onto them. When the German train
validates the recipe, ES and IT are the obvious next two, and the only new inputs are their OA source
keys and a bounding box.

NL is mostly the same story with a twist: the Dutch postcode carries two letters (`1012 LM`), and the
model glues that letter-part onto the city. Rendering real Dutch tuples teaches both the order and
the postcode shape at once, so the same tooling covers it, but the postcode format is worth watching
in the eval.

GB is the one that does not fit. British addresses already run house-number-first, which is what the
model was trained on, so it tags house and street correctly. What it cannot do is recognize
`SW1A 2AA` as a postcode, so the postcode lands inside the locality. An order shard would do nothing
for GB. It needs postcode coverage, which is closer to the existing postcode-repair work than to the
German order shard.

## Sequencing

Hold all of this behind the German result. If the German train lifts street and house_number without
costing US or French accuracy, the recipe is proven and ES, IT, and NL follow on the same rails. If
German shows interference instead, that same interference would hit the others, and pre-building them
would just be three more shards to pull back out. So this is a map, not a backlog. Measure the first
one before you commit to the rest.

The spot-check is directional (a few hand-written addresses per locale, not a labeled set); treat the
groupings as a planning aid, and confirm each locale with a held-out set the way German was confirmed
before training on it.
