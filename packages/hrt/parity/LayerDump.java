// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

// Builds an archive of one layer of the basemaps fork's own Basemap profile, for comparison with
// `hrt basemap-test` through `hrt clock`.
//
// Basemap is constructed for the one layer, so its own source routing, relation preprocessing and per-layer
// post-processing run, at maxzoom 15 as the production build uses. The country coder is the jar's borders.json. No
// pgf-encoding.zip and no QRank file are registered, so no pgf: name attributes are written and POI ranking is off.
//
// Run with the basemaps fork's shaded jar on the class path:
//   java -cp protomaps-basemap-HEAD-with-deps.jar LayerDump.java <layer> <input.osm.pbf> <scratch dir> [threads] \
//     [ne=<natural_earth_vector.gpkg.zip>] [osm-water=<water-polygons-split-3857.zip>] \
//     [osm-land=<land-polygons-split-3857.zip>] [raw]
// The archive is written to <scratch dir>/<layer>.pmtiles. With "raw", per-layer post-processing is skipped, so the
// archive holds the features as rendered, before any merging.

import com.onthegomap.planetiler.Planetiler;
import com.onthegomap.planetiler.VectorTile;
import com.onthegomap.planetiler.config.Arguments;
import com.protomaps.basemap.Basemap;
import com.protomaps.basemap.feature.CountryCoder;
import java.nio.file.Path;
import java.util.List;

public class LayerDump {
  public static void main(String[] args) throws Exception {
    String layer = args[0];
    Path input = Path.of(args[1]);
    Path scratch = Path.of(args[2]);
    String threads = args.length > 3 ? args[3] : "2";
    String naturalEarth = null;
    String osmWater = null;
    String osmLand = null;
    boolean raw = false;
    for (int i = 4; i < args.length; i++) {
      if (args[i].equals("raw")) {
        raw = true;
      } else if (args[i].startsWith("ne=")) {
        naturalEarth = args[i].substring(3);
      } else if (args[i].startsWith("osm-water=")) {
        osmWater = args[i].substring(10);
      } else if (args[i].startsWith("osm-land=")) {
        osmLand = args[i].substring(9);
      }
    }

    var countryCoder = CountryCoder.fromJarResource();
    Basemap profile = raw ? new Basemap(null, countryCoder, null, layer) {
      @Override
      public List<VectorTile.Feature> postProcessLayerFeatures(String name, int zoom, List<VectorTile.Feature> items) {
        return items;
      }
    } : new Basemap(null, countryCoder, null, layer);
    var planetiler = Planetiler
      .create(Arguments.of("tmpdir", scratch.resolve("tmp").toString(), "threads", threads, "maxzoom", "15"))
      .setProfile(profile)
      .addOsmSource("osm", input);
    if (naturalEarth != null) {
      planetiler.addGeoPackageSource("ne", Path.of(naturalEarth), null);
    }
    if (osmWater != null) {
      planetiler.addShapefileSource("osm_water", Path.of(osmWater));
    }
    if (osmLand != null) {
      planetiler.addShapefileSource("osm_land", Path.of(osmLand));
    }
    planetiler.overwriteOutput(scratch.resolve(layer + ".pmtiles")).run();
  }
}
