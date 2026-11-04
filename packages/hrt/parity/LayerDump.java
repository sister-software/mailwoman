// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Builds an archive of one layer of the basemaps fork's own Basemap profile, for comparison with
// `hrt basemap-test` through `hrt clock`.
//
// Basemap is constructed for the one layer, so its own source routing, relation preprocessing and per-layer
// post-processing run, at maxzoom 15 as the production build uses. The country coder is the jar's borders.json, and the
// QRank table is empty, so POI ranking by QRank is off. With "pgf", the fonts Basemap's main registers are loaded from
// that pgf-encoding.zip, so names in their scripts get pgf: attributes; without it none are written.
//
// Run with the basemaps fork's shaded jar on the class path:
//   java -cp protomaps-basemap-HEAD-with-deps.jar LayerDump.java <layer> <input.osm.pbf> <scratch dir> [threads] \
//     [ne=<natural_earth_vector.gpkg.zip>] [osm-water=<water-polygons-split-3857.zip>] \
//     [osm-land=<land-polygons-split-3857.zip>] [landcover=<daylight-landcover.gpkg>] [clip=<polygon.geojson>] \
//     [clip-buffer=<pixels>] [pgf=<pgf-encoding.zip>] [raw]
// The archive is written to <scratch dir>/<layer>.pmtiles. With "raw", per-layer post-processing is skipped, so the
// archive holds the features as rendered, before any merging. With "clip", the fork's Clip clips every tile to the
// polygon, as Basemap's --clip and --clip-buffer do.

import com.carrotsearch.hppc.LongLongHashMap;
import com.onthegomap.planetiler.Planetiler;
import com.onthegomap.planetiler.VectorTile;
import com.onthegomap.planetiler.config.Arguments;
import com.onthegomap.planetiler.stats.Stats;
import com.protomaps.basemap.Basemap;
import com.protomaps.basemap.feature.CountryCoder;
import com.protomaps.basemap.feature.QrankDb;
import com.protomaps.basemap.postprocess.Clip;
import com.protomaps.basemap.text.FontRegistry;
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
    String landcover = null;
    String clipPath = null;
    double clipBuffer = Clip.DEFAULT_BUFFER;
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
      } else if (args[i].startsWith("landcover=")) {
        landcover = args[i].substring(10);
      } else if (args[i].startsWith("clip=")) {
        clipPath = args[i].substring(5);
      } else if (args[i].startsWith("clip-buffer=")) {
        clipBuffer = Double.parseDouble(args[i].substring(12));
      } else if (args[i].startsWith("pgf=")) {
        // As Basemap's main registers them.
        FontRegistry fontRegistry = FontRegistry.getInstance();
        fontRegistry.setZipFilePath(args[i].substring(4));
        fontRegistry.loadFontBundle("NotoSansDevanagari-Regular", "1", "Devanagari");
      }
    }

    var countryCoder = CountryCoder.fromJarResource();
    // An empty QRank table: every lookup returns 0, so no POI takes a QRank zoom. A null table would throw on each POI
    // with a wikidata tag and drop it.
    var qrank = new QrankDb(new LongLongHashMap());
    // As Basemap's main builds it: zooms 0 through the build's maxzoom, buffered.
    Clip clip = clipPath == null ? null :
      Clip.fromGeoJSONFile(Stats.inMemory(), 0, 15, true, clipBuffer, Path.of(clipPath));
    Basemap profile = raw ? new Basemap(qrank, countryCoder, clip, layer) {
      @Override
      public List<VectorTile.Feature> postProcessLayerFeatures(String name, int zoom, List<VectorTile.Feature> items) {
        return items;
      }
    } : new Basemap(qrank, countryCoder, clip, layer);
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
    if (landcover != null) {
      planetiler.addGeoPackageSource("landcover", Path.of(landcover), null);
    }
    planetiler.overwriteOutput(scratch.resolve(layer + ".pmtiles")).run();
  }
}
