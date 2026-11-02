// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

// Builds an archive of the basemaps fork's water layer from OpenStreetMap alone, for comparison with `hrt water-test`
// through `hrt clock`.
//
// The profile calls the fork's own Water.processOsm for every OpenStreetMap feature and Water.postProcess for every
// tile, at maxzoom 15 as the production build uses. The Natural Earth and prepared ocean sources are left out, and no
// pgf-encoding.zip is registered, so no pgf: name attributes are written.
//
// Run with the basemaps fork's shaded jar on the class path:
//   java -cp protomaps-basemap-HEAD-with-deps.jar WaterDump.java <input.osm.pbf> <scratch dir> [threads] [raw]
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
    boolean raw = args.length > 3 && args[3].equals("raw");
    Water water = new Water();

    Profile profile = new Profile() {
      @Override
      public void processFeature(SourceFeature source, FeatureCollector features) {
        water.processOsm(source, features);
      }

      @Override
      public List<VectorTile.Feature> postProcessLayerFeatures(String layer, int zoom, List<VectorTile.Feature> items)
        throws GeometryException {
        return Water.LAYER_NAME.equals(layer) && !raw ? water.postProcess(zoom, items) : items;
      }
    };

    Planetiler.create(Arguments.of("tmpdir", scratch.resolve("tmp").toString(), "threads", threads, "maxzoom", "15"))
      .setProfile(profile)
      .addOsmSource("osm", input)
      .overwriteOutput(scratch.resolve("water.pmtiles"))
      .run();
  }
}
