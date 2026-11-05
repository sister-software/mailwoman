// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// The block identities and the wall-reading predicates are ported from Arnis `src/block_definitions.rs` and
// `src/element_processing/buildings.rs` at commit d8e8b662 (github.com/louis-e/arnis, Apache-2.0). Modified: only
// the blocks the building style path can choose are listed, a slab is its full block, and the palette index is this
// enum's order rather than Arnis's numeric block id.

//! The blocks a facade decision can name. Each is one byte in a building record, the index into
//! `packages/structures/data/facade/block-palette.json`, which carries its sRGB color.

use serde::{Deserialize, Serialize};

/// A Minecraft block, by Arnis's constant name in snake case. The discriminant is the palette index.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[repr(u8)]
pub enum Block {
	WhiteConcrete,
	WhiteTerracotta,
	WhiteWool,
	QuartzBlock,
	QuartzBricks,
	SnowBlock,
	IronBlock,
	LightGrayConcrete,
	LightGrayTerracotta,
	Diorite,
	PolishedDiorite,
	PolishedAndesite,
	SmoothStone,
	StoneBricks,
	ChiseledStoneBricks,
	CrackedStoneBricks,
	Stone,
	Cobblestone,
	Andesite,
	GrayConcrete,
	GrayTerracotta,
	Deepslate,
	DeepslateBricks,
	PolishedDeepslate,
	CobbledDeepslate,
	Blackstone,
	PolishedBlackstone,
	PolishedBlackstoneBricks,
	BlackConcrete,
	BlackTerracotta,
	BlackWool,
	NetheriteBlock,
	BrownConcrete,
	BrownTerracotta,
	MudBricks,
	Dirt,
	CoarseDirt,
	OakPlanks,
	OakLog,
	SprucePlanks,
	SpruceLog,
	DarkOakPlanks,
	DarkOakLog,
	Granite,
	PolishedGranite,
	Sandstone,
	SmoothSandstone,
	EndStoneBricks,
	HayBale,
	Brick,
	RedTerracotta,
	RedWool,
	RedConcrete,
	RedNetherBricks,
	NetherBrick,
	Terracotta,
	OrangeTerracotta,
	OrangeWool,
	OrangeConcrete,
	WaxedCopperBlock,
	WaxedExposedCopper,
	YellowConcrete,
	YellowTerracotta,
	YellowWool,
	GoldBlock,
	GreenConcrete,
	GreenWool,
	LimeConcrete,
	MossBlock,
	MossyCobblestone,
	WaxedOxidizedCopper,
	BlueConcrete,
	BlueTerracotta,
	BlueWool,
	GrayConcretePowder,
	BrownConcretePowder,
	LightBlueConcrete,
	LightBlueTerracotta,
	PurpleConcrete,
	MagentaConcrete,
	CyanConcrete,
	CyanTerracotta,
	Tuff,
	CherryPlanks,
	MushroomStem,
	BirchPlanks,
	LightGrayConcretePowder,
	MangrovePlanks,
	DeepslateTiles,
	PinkTerracotta,
	LimeTerracotta,
	GrayWool,
	SmoothBasalt,
	GrassBlock,
	Gravel,
	MossyStoneBricks,
	DarkPrismarine,
	SmoothQuartz,
	Calcite,
	Scaffolding,
	StoneBrickSlab,
	Glass,
	WhiteStainedGlass,
	LightGrayStainedGlass,
	GrayStainedGlass,
	BlackStainedGlass,
	BrownStainedGlass,
	CyanStainedGlass,
	BlueStainedGlass,
	LightBlueStainedGlass,
}

/// The number of blocks, one past the last palette index.
pub const BLOCK_COUNT: usize = Block::LightBlueStainedGlass as usize + 1;

impl Block {
	/// The palette index, the byte a building record stores.
	#[inline]
	pub fn index(self) -> u8 {
		self as u8
	}

	/// Every block in palette order.
	pub fn all() -> impl Iterator<Item = Block> {
		(0..BLOCK_COUNT as u8).map(|index| {
			// SAFETY: `Block` is `repr(u8)` with contiguous discriminants from 0 to `BLOCK_COUNT - 1`.
			unsafe { std::mem::transmute::<u8, Block>(index) }
		})
	}

	/// The snake-case name, as the data files spell it.
	pub fn name(self) -> String {
		serde_json::to_value(self)
			.ok()
			.and_then(|value| value.as_str().map(str::to_owned))
			.unwrap_or_default()
	}

	/// The block a data file names, or `None` for a name outside the palette.
	pub fn from_name(name: &str) -> Option<Block> {
		serde_json::from_value(serde_json::Value::String(name.to_owned())).ok()
	}
}

/// Whether a wall block is a glass pane: a curtain wall rather than a wall with windows punched in it.
/// Arnis `is_glass_wall`.
pub fn is_glass_wall(block: Block) -> bool {
	matches!(
		block,
		Block::Glass
			| Block::WhiteStainedGlass
			| Block::GrayStainedGlass
			| Block::LightGrayStainedGlass
			| Block::BlackStainedGlass
			| Block::BrownStainedGlass
			| Block::CyanStainedGlass
			| Block::BlueStainedGlass
			| Block::LightBlueStainedGlass
	)
}

/// Whether a wall block reads as load-bearing masonry, which carries piers and spandrels rather than glass bands.
/// Arnis `is_masonry_wall`.
pub fn is_masonry_wall(block: Block) -> bool {
	matches!(
		block,
		Block::Brick
			| Block::StoneBricks
			| Block::Sandstone
			| Block::SmoothSandstone
			| Block::Granite
			| Block::PolishedGranite
			| Block::Terracotta
			| Block::RedTerracotta
			| Block::OrangeTerracotta
			| Block::BrownTerracotta
			| Block::WhiteTerracotta
			| Block::EndStoneBricks
			| Block::QuartzBricks
			| Block::MudBricks
			| Block::NetherBrick
			| Block::RedNetherBricks
			| Block::PolishedDiorite
			| Block::Cobblestone
	)
}

/// Walls dark enough that black glass in them reads as a hole. Arnis `is_dark_wall`.
pub fn is_dark_wall(wall: Block) -> bool {
	matches!(
		wall,
		Block::Brick
			| Block::NetherBrick
			| Block::RedNetherBricks
			| Block::MudBricks
			| Block::BrownTerracotta
			| Block::BlackTerracotta
			| Block::GrayTerracotta
			| Block::GrayConcrete
			| Block::BlackConcrete
			| Block::BrownConcrete
			| Block::Blackstone
			| Block::PolishedBlackstone
			| Block::DeepslateBricks
			| Block::PolishedDeepslate
			| Block::Granite
			| Block::PolishedGranite
			| Block::DarkOakPlanks
	)
}

/// Pale limestone, sandstone and render walls. Arnis `is_light_stone`.
pub fn is_light_stone(wall: Block) -> bool {
	matches!(
		wall,
		Block::Sandstone
			| Block::SmoothSandstone
			| Block::EndStoneBricks
			| Block::QuartzBricks
			| Block::QuartzBlock
			| Block::SmoothQuartz
			| Block::PolishedDiorite
			| Block::Diorite
			| Block::Calcite
			| Block::MushroomStem
			| Block::SmoothStone
			| Block::StoneBricks
			| Block::WhiteConcrete
			| Block::LightGrayConcrete
			| Block::LightGrayConcretePowder
	)
}

/// Buff and warm stone, which takes a bronze panel rather than a slate one. Arnis `is_warm_stone`.
pub fn is_warm_stone(wall: Block) -> bool {
	matches!(
		wall,
		Block::Sandstone
			| Block::SmoothSandstone
			| Block::EndStoneBricks
			| Block::MushroomStem
			| Block::BirchPlanks
			| Block::WhiteTerracotta
			| Block::YellowTerracotta
	)
}

/// Walls accepted only about 20 percent of the time when picked, to keep them rare. Arnis `is_rare_wall_block`.
#[inline]
pub fn is_rare_wall_block(block: Block) -> bool {
	matches!(
		block,
		Block::NetherBrick | Block::RedNetherBricks | Block::RedTerracotta
	)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn names_round_trip_and_indexes_are_contiguous() {
		for (expected, block) in Block::all().enumerate() {
			assert_eq!(usize::from(block.index()), expected);
			assert_eq!(Block::from_name(&block.name()), Some(block));
		}
		assert_eq!(Block::from_name("brick"), Some(Block::Brick));
		assert_eq!(Block::from_name("obsidian"), None);
	}
}
