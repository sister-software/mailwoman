// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

// Prints every source feature Planetiler's OSM reader offers a profile, in the line format hrt-osm's parity-dump
// example prints, so the two readers can be compared line for line.
//
// Run with the basemaps fork's shaded jar on the class path:
//   java -cp protomaps-basemap-HEAD-with-deps.jar OsmDump.java <input.osm.pbf> <scratch dir> > java.txt
//
// Each line is: <n|w|r><id> L<0|1> P<0|1> rels=<role:relation:path,...> geom=<geometry>
// Coordinates are world x,y as the hexadecimal bits of each double. Rings are joined by '|' and polygons by ';'.

import com.onthegomap.planetiler.FeatureCollector;
import com.onthegomap.planetiler.Planetiler;
import com.onthegomap.planetiler.Profile;
import com.onthegomap.planetiler.config.Arguments;
import com.onthegomap.planetiler.reader.SourceFeature;
import com.onthegomap.planetiler.reader.osm.OsmElement;
import com.onthegomap.planetiler.reader.osm.OsmRelationInfo;
import com.onthegomap.planetiler.reader.osm.OsmSourceFeature;
import java.io.PrintStream;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Collectors;
import org.locationtech.jts.geom.Geometry;
import org.locationtech.jts.geom.LineString;
import org.locationtech.jts.geom.Point;
import org.locationtech.jts.geom.Polygon;

public class OsmDump {
  record Kept(long id) implements OsmRelationInfo {}

  static final PrintStream OUT = new PrintStream(System.out, false);

  static String coords(LineString line) {
    StringBuilder out = new StringBuilder();
    for (int i = 0; i < line.getNumPoints(); i++) {
      if (i > 0) {
        out.append(' ');
      }
      out.append(Long.toHexString(Double.doubleToRawLongBits(line.getCoordinateN(i).x)))
        .append(',')
        .append(Long.toHexString(Double.doubleToRawLongBits(line.getCoordinateN(i).y)));
    }
    return out.toString();
  }

  static String polygon(Polygon polygon) {
    StringBuilder out = new StringBuilder(coords(polygon.getExteriorRing()));
    for (int i = 0; i < polygon.getNumInteriorRing(); i++) {
      out.append('|').append(coords(polygon.getInteriorRingN(i)));
    }
    return out.toString();
  }

  static String geometry(Geometry geometry) {
    if (geometry instanceof Point point) {
      return "point " + Long.toHexString(Double.doubleToRawLongBits(point.getX())) + ','
        + Long.toHexString(Double.doubleToRawLongBits(point.getY()));
    } else if (geometry instanceof LineString line) {
      return "line " + coords(line);
    } else if (geometry instanceof Polygon polygon) {
      return "polygon " + polygon(polygon);
    } else {
      StringBuilder out = new StringBuilder("polygon ");
      for (int i = 0; i < geometry.getNumGeometries(); i++) {
        if (i > 0) {
          out.append(';');
        }
        out.append(polygon((Polygon) geometry.getGeometryN(i)));
      }
      return out.toString();
    }
  }

  public static void main(String[] args) throws Exception {
    Path input = Path.of(args[0]);
    Path scratch = Path.of(args[1]);
    Profile profile = new Profile() {
      @Override
      public List<OsmRelationInfo> preprocessOsmRelation(OsmElement.Relation relation) {
        return List.of(new Kept(relation.id()));
      }

      @Override
      public void processFeature(SourceFeature feature, FeatureCollector features) {
        OsmElement element = ((OsmSourceFeature) feature).originalElement();
        if (element instanceof OsmElement.Node && feature.tags().isEmpty()) {
          return;
        }
        char kind = element instanceof OsmElement.Node ? 'n' : element instanceof OsmElement.Way ? 'w' : 'r';
        String rels = feature.relationInfo(Kept.class, true).stream()
          .map(member -> member.role() + ':' + member.relation().id() + ':'
            + member.parentRelationPath().stream().map(String::valueOf).collect(Collectors.joining("/")))
          .collect(Collectors.joining(","));
        String geom;
        try {
          geom = geometry(feature.worldGeometry());
        } catch (Exception e) {
          geom = "error";
        }
        String line = kind + Long.toString(feature.id()) + " L" + (feature.canBeLine() ? 1 : 0) + " P"
          + (feature.canBePolygon() ? 1 : 0) + " rels=" + rels + " geom=" + geom;
        synchronized (OUT) {
          OUT.println(line);
        }
      }
    };

    Planetiler.create(Arguments.of("tmpdir", scratch.resolve("tmp").toString(), "threads", "2"))
      .setProfile(profile)
      .addOsmSource("osm", input)
      .overwriteOutput(scratch.resolve("out.pmtiles"))
      .run();
    OUT.flush();
  }
}
