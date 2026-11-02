// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

// Prints every tile piece Planetiler's FeatureRenderer produces for a fixed profile, in the line format of
// hrt-render's render-dump example, so the two renderers can be compared line for line.
//
// The profile sends each tagged node to layer "p" as a point, each way or multipolygon that can be a polygon to layer
// "a", and each remaining way to layer "l" as a line, all with Planetiler's default settings for zooms 0 to 14.
//
// Run with the basemaps fork's shaded jar on the class path:
//   java -cp protomaps-basemap-HEAD-with-deps.jar RenderDump.java <input.osm.pbf> <scratch dir> > java.txt
//
// Each line is: <z>/<x>/<y> <layer> <id> <geometry type> <scale> s<sort key> g<group or -> <commands, comma separated>

import com.onthegomap.planetiler.FeatureCollector;
import com.onthegomap.planetiler.Planetiler;
import com.onthegomap.planetiler.Profile;
import com.onthegomap.planetiler.config.Arguments;
import com.onthegomap.planetiler.config.PlanetilerConfig;
import com.onthegomap.planetiler.reader.SourceFeature;
import com.onthegomap.planetiler.render.FeatureRenderer;
import com.onthegomap.planetiler.render.RenderedFeature;
import com.onthegomap.planetiler.stats.Stats;
import java.io.PrintStream;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.stream.Collectors;

public class RenderDump {
  static final PrintStream OUT = new PrintStream(System.out, false);

  static String line(RenderedFeature rendered) {
    var tile = rendered.tile();
    var feature = rendered.vectorTileFeature();
    var geometry = feature.geometry();
    String group = rendered.group().map(g -> g.group() + ":" + g.limit()).orElse("-");
    String commands = Arrays.stream(geometry.commands()).mapToObj(c -> Integer.toUnsignedString(c))
      .collect(Collectors.joining(","));
    return tile.z() + "/" + tile.x() + "/" + tile.y() + " " + feature.layer() + " " + feature.id() + " "
      + geometry.geomType() + " " + geometry.scale() + " s" + rendered.sortKey() + " g" + group + " " + commands;
  }

  public static void main(String[] args) throws Exception {
    Path input = Path.of(args[0]);
    Path scratch = Path.of(args[1]);
    // An optional third argument sets the thread count; a fourth, "quiet", builds the archive without the dump, for
    // timing the build alone.
    String threads = args.length > 2 ? args[2] : "2";
    boolean quiet = args.length > 3 && args[3].equals("quiet");
    Arguments arguments = Arguments.of("tmpdir", scratch.resolve("tmp").toString(), "threads", threads);
    PlanetilerConfig config = PlanetilerConfig.from(arguments);
    Stats stats = Stats.inMemory();

    Profile profile = new Profile() {
      @Override
      public void processFeature(SourceFeature source, FeatureCollector features) {
        if (source.isPoint()) {
          if (source.tags().isEmpty()) {
            return;
          }
          features.point("p");
        } else if (source.canBePolygon()) {
          features.polygon("a");
        } else if (source.canBeLine()) {
          features.line("l");
        }
        if (quiet) {
          return;
        }
        StringBuilder out = new StringBuilder();
        var renderer = new FeatureRenderer(config, rendered -> out.append(line(rendered)).append('\n'), stats);
        for (var feature : features) {
          renderer.accept(feature);
        }
        synchronized (OUT) {
          OUT.print(out);
        }
      }
    };

    Planetiler.create(arguments)
      .setProfile(profile)
      .addOsmSource("osm", input)
      .overwriteOutput(scratch.resolve("out.pmtiles"))
      .run();
    OUT.flush();
  }
}
