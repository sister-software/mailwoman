// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

// Builds an archive of the basemaps fork's water layer, for comparison with `hrt water-test` through `hrt clock`.
//
// The profile calls the fork's own Water class: processOsm for OpenStreetMap features, processNe for Natural Earth
// and processPreparedOsm for the prepared ocean polygons, routed by source name as Basemap.java routes them, and
// Water.postProcess for every tile, at maxzoom 15 as the production build uses. No pgf-encoding.zip is registered, so
// no pgf: name attributes are written.
//
// Run with the basemaps fork's shaded jar on the class path:
//   java -cp protomaps-basemap-HEAD-with-deps.jar WaterDump.java <input.osm.pbf> <scratch dir> [threads] \
//     [raw] [ne=<natural_earth_vector.gpkg.zip>] [osm-water=<water-polygons-split-3857.zip>]
// The archive is written to <scratch dir>/water.pmtiles. With "raw", Water.postProcess is skipped, so the archive
// holds the features as rendered, before any merging.

import com.onthegomap.planetiler.FeatureCollector;
import com.onthegomap.planetiler.Planetiler;
import com.onthegomap.planetiler.Profile;
import com.onthegomap.planetiler.VectorTile;
import com.onthegomap.planetiler.config.Arguments;
import com.onthegomap.planetiler.geo.GeometryException;
import com.onthegomap.planetiler.reader.SourceFeature;
import com.protomaps.basemap.layers.Water;
import java.nio.file.Path;
import java.util.List;

public class WaterDump {
  public static void main(String[] args) throws Exception {
    Path input = Path.of(args[0]);
    Path scratch = Path.of(args[1]);
    String threads = args.length > 2 ? args[2] : "2";
    boolean raw = false;
    String naturalEarth = null;
    String osmWater = null;
    for (int i = 3; i < args.length; i++) {
      if (args[i].equals("raw")) {
        raw = true;
      } else if (args[i].startsWith("ne=")) {
        naturalEarth = args[i].substring(3);
      } else if (args[i].startsWith("osm-water=")) {
        osmWater = args[i].substring(10);
      }
    }
    boolean skipPostProcess = raw;
    Water water = new Water();

    Profile profile = new Profile() {
      @Override
      public void processFeature(SourceFeature source, FeatureCollector features) {
        switch (source.getSource()) {
          case "osm" -> water.processOsm(source, features);
          case "ne" -> water.processNe(source, features);
          case "osm_water" -> water.processPreparedOsm(source, features);
          default -> {
          }
        }
      }

      @Override
      public List<VectorTile.Feature> postProcessLayerFeatures(String layer, int zoom, List<VectorTile.Feature> items)
        throws GeometryException {
        return Water.LAYER_NAME.equals(layer) && !skipPostProcess ? water.postProcess(zoom, items) : items;
      }
    };

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
    planetiler.overwriteOutput(scratch.resolve("water.pmtiles")).run();
  }
}
