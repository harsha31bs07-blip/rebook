import { studioTheme } from "ag-studio";

export const rebookStudioTheme = studioTheme.withParams({
  fontFamily: "var(--font-ui), Arial, sans-serif", fontSize: 12,
  accentColor: "var(--primary)", textColor: "var(--foreground)", foregroundColor: "var(--foreground)",
  subtleTextColor: "var(--muted)", borderColor: "var(--border)", backgroundColor: "var(--surface)",
  studioWrapperBorder: false, studioWrapperBorderRadius: 0, studioWrapperSpacing: 0,
  studioCanvasBackgroundColor: "var(--background)", studioCanvasBorder: false, studioCanvasShadow: false,
  studioCanvasPadding: 12, studioCanvasRowHeight: 14,
  studioWidgetBackgroundColor: "var(--surface)", studioWidgetBorder: { color: "var(--border)", width: 1 },
  studioWidgetBorderRadius: 10, studioWidgetPadding: 8,
  studioWidgetTitleFontSize: 12, studioWidgetTitleFontWeight: 600, studioWidgetTitleTextColor: "var(--muted)",
  studioPanelContainerBorderRadius: 10, gridFontSize: 11, gridHeaderFontSize: 11,
  gridHeaderTextColor: "var(--muted)", gridHeaderBackgroundColor: "var(--background)", gridRowHeight: 32,
  chartFontFamily: "var(--font-ui), Arial, sans-serif", chartTextColor: "var(--foreground)",
  chartSubtleTextColor: "var(--muted)", chartGridLineColor: "var(--border)",
  // Charts draw on canvas and cannot read CSS variables: Studio Linen sage and clay as literals.
  chartPaletteFills1Color: "#3f6b4f", chartPaletteStrokes1Color: "#3f6b4f",
  chartPaletteFills2Color: "#b5643c", chartPaletteStrokes2Color: "#b5643c",
});
