// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

// Writes, for each line of a name list, the fork's TextEngine.encodeRegisteredScripts output and the raw glyph data
// the JDK's shaping gives each registered-script segment, for comparison with `hrt pgf-probe`.
//
// Each output row holds the name, its encoded codepoints in decimal, and per segment the glyphs as
// `<glyph id>:<advance float bits>:<position double bits>`. The fonts are those Basemap's main registers.
//
// Run with the basemaps fork's shaded jar on the class path:
//   java -cp protomaps-basemap-HEAD-with-deps.jar PgfProbe.java <pgf-encoding.zip> <names.txt> <out.tsv>

import com.protomaps.basemap.names.Script;
import com.protomaps.basemap.text.FontRegistry;
import com.protomaps.basemap.text.TextEngine;
import java.awt.Font;
import java.awt.font.FontRenderContext;
import java.awt.font.GlyphVector;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

public class PgfProbe {
  public static void main(String[] args) throws Exception {
    FontRegistry registry = FontRegistry.getInstance();
    registry.setZipFilePath(args[0]);
    registry.loadFontBundle("NotoSansDevanagari-Regular", "1", "Devanagari");
    Font font = registry.getFont("Devanagari");
    try (PrintWriter out = new PrintWriter(Files.newBufferedWriter(Path.of(args[2]), StandardCharsets.UTF_8))) {
      for (String line : Files.readAllLines(Path.of(args[1]), StandardCharsets.UTF_8)) {
        StringBuilder row = new StringBuilder(line).append('\t');
        String encoded = TextEngine.encodeRegisteredScripts(line);
        encoded.codePoints().forEach(cp -> row.append(Integer.toString(cp)).append(' '));
        row.append('\t');
        for (String segment : TextEngine.segment(line, registry.getScripts())) {
          if (!Script.getScript(segment).equals("Devanagari")) {
            continue;
          }
          // The FontRenderContext and layout call TextEngine.encode uses.
          FontRenderContext frc = new FontRenderContext(null, true, true);
          char[] chars = segment.toCharArray();
          GlyphVector gv = font.layoutGlyphVector(frc, chars, 0, chars.length, 0);
          for (int i = 0; i < gv.getNumGlyphs(); i++) {
            row.append(gv.getGlyphCode(i)).append(':')
              .append(Float.floatToIntBits((float) gv.getGlyphMetrics(i).getAdvanceX())).append(':')
              .append(Double.doubleToLongBits(gv.getGlyphPosition(i).getX())).append(' ');
          }
          row.append('|');
        }
        out.println(row);
      }
    }
  }
}
