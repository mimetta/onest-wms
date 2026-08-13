import { code128PathData, encodeCode128B, Code128Error } from "@/lib/labels/code128";

/**
 * A Code 128 symbol as inline SVG.
 *
 * Sized in module units and scaled by viewBox, so the same component prints
 * crisply at 50mm and at 100mm — a rasterised barcode at label size is the
 * classic reason a scanner refuses to read a freshly printed sheet.
 *
 * `shapeRendering="crispEdges"` matters: without it the browser antialiases bar
 * edges, which on a 203dpi label printer smears the narrow bars into each other.
 */
export function Barcode({
  value,
  heightMm = 12,
  className = "",
}: {
  value: string;
  heightMm?: number;
  className?: string;
}) {
  let path: string;
  let modules: number;

  try {
    const widths = encodeCode128B(value);
    modules = widths.reduce((a, b) => a + b, 0);
    path = code128PathData(value, 1, 100);
  } catch (error) {
    // A label that cannot be encoded must say so on the page rather than render
    // a blank space that someone sticks on a drum.
    const message =
      error instanceof Code128Error ? error.message : "cannot encode this value";
    return <span className="text-destructive text-[8px] leading-tight">{message}</span>;
  }

  return (
    <svg
      viewBox={`0 0 ${modules} 100`}
      preserveAspectRatio="none"
      role="img"
      aria-label={value}
      shapeRendering="crispEdges"
      style={{ height: `${heightMm}mm`, width: "100%" }}
      className={className}
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
