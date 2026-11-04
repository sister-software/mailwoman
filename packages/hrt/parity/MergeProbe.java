// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Runs Planetiler's polygon merge, step by step, on one tile's features written by `hrt merge-probe`, so the JTS and
// GEOS paths can be compared on identical input.
//
//   java -cp protomaps-basemap-HEAD-with-deps.jar MergeProbe.java <features.txt> <kind_detail>
//
// Each input line is <id>\t<key=s:value;key=i:value;key=d:value>\t<comma-separated commands>, where s: marks a
// string, i: an integer and d: a double.

import com.onthegomap.planetiler.FeatureMerge;
import com.onthegomap.planetiler.VectorTile;
import com.onthegomap.planetiler.geo.GeoUtils;
import com.onthegomap.planetiler.geo.GeometryType;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.locationtech.jts.geom.Geometry;
import org.locationtech.jts.operation.buffer.BufferOp;
import org.locationtech.jts.operation.buffer.BufferParameters;

public class MergeProbe {
  public static void main(String[] args) throws Exception {
    String detail = args[1];
    List<VectorTile.Feature> features = new ArrayList<>();
    for (String line : Files.readAllLines(Path.of(args[0]))) {
      String[] fields = line.split("\t");
      Map<String, Object> attrs = new HashMap<>();
      for (String pair : fields[1].split(";")) {
        if (pair.isEmpty()) {
          continue;
        }
        String key = pair.substring(0, pair.indexOf('='));
        String value = pair.substring(pair.indexOf('=') + 1);
        attrs.put(key, value.startsWith("i:") ? (Object) Long.parseLong(value.substring(2)) :
          value.startsWith("d:") ? (Object) Double.parseDouble(value.substring(2)) : value.substring(2));
      }
      String[] parts = fields[2].split(",");
      int[] commands = new int[parts.length];
      for (int i = 0; i < parts.length; i++) {
        commands[i] = Integer.parseUnsignedInt(parts[i]);
      }
      features.add(new VectorTile.Feature("water", Long.parseLong(fields[0]),
        new VectorTile.VectorGeometry(commands, GeometryType.POLYGON, 0), attrs));
    }

    List<Geometry> group = new ArrayList<>();
    for (var feature : features) {
      if (detail.equals(feature.tags().get("kind_detail"))) {
        group.add(feature.geometry().decode());
      }
    }
    System.out.println(group.size() + " features with kind_detail=" + detail);
    for (int i = 0; i < group.size(); i++) {
      System.out.printf("  input %d: area %.4f, %d points%n", i, group.get(i).getArea(), group.get(i).getNumPoints());
    }
    BufferParameters params = new BufferParameters();
    params.setJoinStyle(BufferParameters.JOIN_MITRE);
    List<Geometry> buffered = new ArrayList<>();
    for (Geometry geometry : group) {
      buffered.add(new BufferOp(geometry, params).getResultGeometry(0.0625));
    }
    Geometry union = GeoUtils.createGeometryCollection(buffered).union();
    Geometry merged = new BufferOp(union, params).getResultGeometry(-0.0625);
    System.out.printf("  union area %.4f; after unbuffer area %.4f, %d points, valid %s%n", union.getArea(),
      merged.getArea(), merged.getNumPoints(), merged.isValid());

    var result = FeatureMerge.mergeNearbyPolygons(features, 1.0, 1.0, 0.5, 0.0625);
    for (var feature : result) {
      if (detail.equals(feature.tags().get("kind_detail"))) {
        Geometry geometry = feature.geometry().decode();
        System.out.printf("  mergeNearbyPolygons: area %.4f, %d polygons, %d points%n", geometry.getArea(),
          geometry.getNumGeometries(), geometry.getNumPoints());
      }
    }
  }
}
