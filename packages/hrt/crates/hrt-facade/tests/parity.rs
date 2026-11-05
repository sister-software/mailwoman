// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Parity with Arnis at d8e8b662. The fixtures under `tests/fixtures/` were written by Arnis's own functions, from a
//! throwaway test module added to a scratch copy of that checkout (`parity_dump.rs`, not in this repository), and
//! every case here asks the vendored code the same question.

use hrt_facade::facade::{BayLayout, BayRhythm};
use hrt_facade::height::{infer_building_height, InferredHeight};
use hrt_facade::{
	district_seed, resolve, Block, FacadeInput, MaterialRegion, NeighborFacts, Outline, Tags, WindowArchetype,
};
use serde_json::Value;

const REGIONS: &str = include_str!("fixtures/regions.txt");
const COLORS: &str = include_str!("fixtures/colors.jsonl");
const BAYS: &str = include_str!("fixtures/bays.jsonl");
const HEIGHTS: &str = include_str!("fixtures/heights.jsonl");
const STYLES: &str = include_str!("fixtures/styles.jsonl");

/// A Minecraft block id as Arnis prints it, read as the palette block: three ids differ from Arnis's constant
/// names, and a slab is the full block of its texture.
fn block(name: &str) -> Block {
	let name = match name {
		"bricks" => "brick",
		"nether_bricks" => "nether_brick",
		"hay_block" => "hay_bale",
		"smooth_stone_slab" => "smooth_stone",
		"stone_brick_slab" => "stone_bricks",
		"quartz_slab" => "quartz_block",
		"cut_sandstone_slab" => "sandstone",
		"smooth_quartz_slab" => "smooth_quartz",
		"polished_diorite_slab" => "polished_diorite",
		"polished_andesite_slab" => "polished_andesite",
		"polished_blackstone_slab" => "polished_blackstone",
		"deepslate_tile_slab" => "deepslate_tiles",
		"brick_slab" => "brick",
		"polished_granite_slab" => "polished_granite",
		"mud_brick_slab" => "mud_bricks",
		"oak_slab" => "oak_planks",
		"spruce_slab" => "spruce_planks",
		"dark_oak_slab" => "dark_oak_planks",
		"polished_deepslate_slab" => "polished_deepslate",
		"cobbled_deepslate_slab" => "cobbled_deepslate",
		"blackstone_slab" => "blackstone",
		"red_nether_brick_slab" => "red_nether_bricks",
		"nether_brick_slab" => "nether_brick",
		"dark_prismarine_slab" => "dark_prismarine",
		"waxed_oxidized_cut_copper_slab" => "waxed_oxidized_copper",
		"mangrove_slab" => "mangrove_planks",
		"cherry_slab" => "cherry_planks",
		"stone_slab" => "stone",
		other => other,
	};
	Block::from_name(name).unwrap_or_else(|| panic!("Arnis block {name} is in the palette"))
}

fn region_letter(region: MaterialRegion) -> char {
	use MaterialRegion as R;
	let all = [
		R::NorthAmerica,
		R::NorthAmericaSunbelt,
		R::Canada,
		R::BritishIsles,
		R::BrickNorth,
		R::France,
		R::Central,
		R::CentralEast,
		R::Nordic,
		R::Mediterranean,
		R::EastEurope,
		R::CentralAsia,
		R::MiddleEast,
		R::SubSaharanAfrica,
		R::SouthAsia,
		R::SoutheastAsia,
		R::EastAsia,
		R::Korea,
		R::Japan,
		R::LatinAmerica,
		R::SouthernCone,
		R::Australasia,
		R::Other,
	];
	(b'a' + all.iter().position(|x| *x == region).unwrap() as u8) as char
}

#[test]
fn regions_match_arnis_on_a_world_grid_and_a_detroit_box() {
	let mut lines = REGIONS.lines();
	let mut checked = 0;
	for row in 0..90 {
		let lat = -89.0 + 2.0 * row as f64 + 0.37;
		let line = lines.next().unwrap();
		for (col, expected) in line.chars().enumerate() {
			let lon = -179.0 + 2.0 * col as f64 + 0.37;
			let got = region_letter(MaterialRegion::at(lat, lon));
			assert_eq!(got, expected, "region at lat {lat} lon {lon}");
			checked += 1;
		}
	}
	assert_eq!(lines.next(), Some("#detroit"));
	for row in 0..21 {
		let lat = 42.25 + 0.01 * row as f64;
		let line = lines.next().unwrap();
		for (col, expected) in line.chars().enumerate() {
			let lon = -83.30 + 0.01 * col as f64;
			assert_eq!(
				region_letter(MaterialRegion::at(lat, lon)),
				expected,
				"region at lat {lat} lon {lon}"
			);
			checked += 1;
		}
	}
	assert_eq!(checked, 90 * 180 + 21 * 41);
}

#[test]
fn color_matching_matches_arnis() {
	use hrt_facade::rng::element_rng;
	let mut checked = 0;
	for line in COLORS.lines() {
		let case: Value = serde_json::from_str(line).unwrap();
		let rgb = case["rgb"].as_array().unwrap();
		let rgb = (
			rgb[0].as_u64().unwrap() as u8,
			rgb[1].as_u64().unwrap() as u8,
			rgb[2].as_u64().unwrap() as u8,
		);
		assert_eq!(
			hrt_facade::walls::wall_block_for_color(rgb, &mut element_rng(7)),
			block(case["wall"].as_str().unwrap()),
			"wall for {rgb:?}"
		);
		assert_eq!(
			hrt_facade::walls::roof_block_for_color(rgb, &mut element_rng(7)),
			block(case["roof"].as_str().unwrap()),
			"roof for {rgb:?}"
		);
		assert_eq!(
			hrt_facade::walls::glass_for_color(rgb),
			block(case["glass"].as_str().unwrap()),
			"glass for {rgb:?}"
		);
		checked += 1;
	}
	assert_eq!(checked, 216);
}

#[test]
fn bay_layouts_match_arnis() {
	let rhythm = |name: &str| -> BayRhythm {
		match name {
			"shop" => hrt_facade::facade::shop_rhythm(),
			"closed" => BayRhythm {
				window: 1,
				pier: 5,
				corner: 3,
			},
			other => {
				let archetype: WindowArchetype = serde_json::from_value(Value::String(other.to_string())).unwrap();
				archetype.rhythm()
			}
		}
	};
	let mut checked = 0;
	for line in BAYS.lines() {
		let case: Value = serde_json::from_str(line).unwrap();
		let layout = BayLayout::plan(
			case["len"].as_i64().unwrap() as i32,
			rhythm(case["rhythm"].as_str().unwrap()),
		);
		assert_eq!(i64::from(layout.lead), case["lead"].as_i64().unwrap(), "{line}");
		assert_eq!(i64::from(layout.count), case["count"].as_i64().unwrap(), "{line}");
		assert_eq!(layout.wide_window, case["wide_window"].as_bool().unwrap(), "{line}");
		assert_eq!(layout.wide_pier, case["wide_pier"].as_bool().unwrap(), "{line}");
		checked += 1;
	}
	assert_eq!(checked, 800);
}

#[test]
fn height_inference_matches_arnis() {
	let mut checked = 0;
	for line in HEIGHTS.lines() {
		let case: Value = serde_json::from_str(line).unwrap();
		let ty = case["type"].as_str().unwrap();
		let tags: Tags = [("building".to_string(), ty.to_string())].into_iter().collect();
		let got = infer_building_height(
			ty,
			&tags,
			case["area"].as_u64().unwrap() as usize,
			1.0,
			case["seed"].as_u64().unwrap(),
		);
		let (hall, value) = match got {
			InferredHeight::Levels(l) => (false, l as i64),
			InferredHeight::HallBlocks(b) => (true, i64::from(b)),
		};
		assert_eq!(hall, case["hall"].as_bool().unwrap(), "{line}");
		assert_eq!(value, case["value"].as_i64().unwrap(), "{line}");
		checked += 1;
	}
	assert_eq!(checked, 220);
}

fn enum_name<T: serde::Serialize>(value: &T) -> String {
	serde_json::to_value(value).unwrap().as_str().unwrap().to_string()
}

/// Arnis prints its enums as Rust debug names; the crate spells them in snake case.
fn snake(debug: &str) -> String {
	let mut out = String::new();
	for (i, c) in debug.chars().enumerate() {
		if c.is_ascii_uppercase() {
			if i > 0 {
				out.push('_');
			}
			out.push(c.to_ascii_lowercase());
		} else {
			out.push(c);
		}
	}
	out
}

#[test]
fn styles_match_arnis_case_by_case() {
	let mut checked = 0;
	let mut mismatches: Vec<String> = Vec::new();
	for line in STYLES.lines() {
		let case: Value = serde_json::from_str(line).unwrap();
		let name = case["name"].as_str().unwrap();
		let tags: Tags = case["tags"]
			.as_object()
			.unwrap()
			.iter()
			.map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
			.collect();
		let (w, l) = (case["w"].as_i64().unwrap() as i32, case["l"].as_i64().unwrap() as i32);
		let outline = Outline {
			nodes: vec![(0, 0), (w, 0), (w, l), (0, l), (0, 0)],
			cells: case["cells"].as_u64().unwrap() as usize,
		};
		let cell = case["cell"].as_array().unwrap();
		let input = FacadeInput {
			seed: case["seed"].as_u64().unwrap(),
			element_id: case["element_id"].as_u64().unwrap(),
			tags: &tags,
			outline,
			lon: case["lon"].as_f64().unwrap(),
			lat: case["lat"].as_f64().unwrap(),
			district_cell: (cell[0].as_i64().unwrap(), cell[1].as_i64().unwrap()),
			relation_levels: None,
			neighbors: Some(NeighborFacts {
				attached: case["attached"].as_bool().unwrap(),
				enclosed: case["enclosed"].as_bool().unwrap(),
				has_any_street: case["street"].as_bool().unwrap(),
				street_corner: case["corner"].as_bool().unwrap(),
			}),
			has_mapped_entrance: false,
		};
		let got = resolve(&input);
		let out = &case["out"];
		let plain = |field: &str| match &out[field] {
			Value::String(s) => s.clone(),
			Value::Null => "null".to_string(),
			other => other.to_string(),
		};
		let block_or_null = |field: &str| out[field].as_str().map(block);
		let zoning_expected = out["zoning"].as_object().map(|z| {
			(
				z["base_top"].as_i64().unwrap() as i32,
				z["capital_from"].as_i64().map(|c| c as i32),
				block(z["stone"].as_str().unwrap()),
				z["groove"].as_str().map(block),
			)
		});
		let cover = out["cover"].as_array().unwrap();
		// (field, ours, arnis), every one a string.
		let comparisons: Vec<(&str, String, String)> = vec![
			("era", enum_name(&got.era), snake(out["era"].as_str().unwrap())),
			(
				"category",
				enum_name(&got.category),
				snake(out["category"].as_str().unwrap()),
			),
			("detail", enum_name(&got.detail), snake(out["detail"].as_str().unwrap())),
			(
				"roof_type",
				enum_name(&got.roof_type),
				snake(out["roof_type"].as_str().unwrap()),
			),
			(
				"archetype",
				enum_name(&got.window_archetype),
				snake(out["archetype"].as_str().unwrap()),
			),
			(
				"depth",
				enum_name(&got.wall_depth_style),
				snake(out["depth"].as_str().unwrap()),
			),
			("ground", enum_name(&got.ground), plain("ground")),
			("shell", enum_name(&got.shell_glass), plain("shell")),
			("floor_cycle", got.floor_cycle.to_string(), plain("floor_cycle")),
			("tall", got.is_tall_building.to_string(), plain("tall")),
			("generate_roof", got.generate_roof.to_string(), plain("generate_roof")),
			("top", got.top_treatment.to_string(), plain("top")),
			("attic", got.attic_style.to_string(), plain("attic")),
			("surrounds", got.surrounds.to_string(), plain("surrounds")),
			("nobile", got.piano_nobile.to_string(), plain("nobile")),
			("parapet", got.has_parapet.to_string(), plain("parapet")),
			(
				"bays",
				format!("[{},{},{}]", got.bays.window, got.bays.pier, got.bays.corner),
				plain("bays"),
			),
			("rustication", got.rustication.to_string(), plain("rustication")),
			("eff_height", got.building_height.to_string(), plain("eff_height")),
			(
				"rise",
				got.roof_rise.map_or("null".to_string(), |r| r.to_string()),
				plain("rise"),
			),
			("has_windows", got.has_windows.to_string(), plain("has_windows")),
			("phase", got.window_phase.to_string(), plain("phase")),
			(
				"horizontal",
				got.use_horizontal_windows.to_string(),
				plain("horizontal"),
			),
			("roof_line", got.use_accent_roof_line.to_string(), plain("roof_line")),
			("vertical", got.use_vertical_accent.to_string(), plain("vertical")),
			("chimney", got.has_chimney.to_string(), plain("chimney")),
			("wall", got.wall.name(), block(out["wall"].as_str().unwrap()).name()),
			(
				"accent",
				got.accent.name(),
				block(out["accent"].as_str().unwrap()).name(),
			),
			("glass", got.glass.name(), block(out["glass"].as_str().unwrap()).name()),
			(
				"spandrel",
				got.spandrel.name(),
				block(out["spandrel"].as_str().unwrap()).name(),
			),
			("trim", got.trim.name(), block(out["trim"].as_str().unwrap()).name()),
			(
				"shop_frame",
				got.shop_frame.name(),
				block(out["shop_frame"].as_str().unwrap()).name(),
			),
			(
				"coping",
				got.coping.name(),
				block(out["coping"].as_str().unwrap()).name(),
			),
			(
				"roof_block",
				format!("{:?}", got.roof_block),
				format!("{:?}", block_or_null("roof_block")),
			),
			(
				"base_course",
				format!("{:?}", got.base_course),
				format!("{:?}", block_or_null("base_course")),
			),
			(
				"cover",
				format!(
					"{:?}",
					[got.roof_cover.base, got.roof_cover.patch, got.roof_cover.repair]
				),
				format!(
					"{:?}",
					[
						block(cover[0].as_str().unwrap()),
						block(cover[1].as_str().unwrap()),
						block(cover[2].as_str().unwrap())
					]
				),
			),
			(
				"zoning",
				format!(
					"{:?}",
					got.zoning.map(|z| (z.base_top, z.capital_from, z.stone, z.groove))
				),
				format!("{zoning_expected:?}"),
			),
		];
		for (field, ours, arnis) in comparisons {
			if ours != arnis {
				mismatches.push(format!("{name} {field}: ours {ours}, arnis {arnis}"));
			}
		}
		let _ = district_seed(input.district_cell);
		checked += 1;
	}
	assert!(
		mismatches.is_empty(),
		"{} differences over {checked} cases:\n{}",
		mismatches.len(),
		mismatches.join("\n")
	);
	assert_eq!(checked, 300);
}
