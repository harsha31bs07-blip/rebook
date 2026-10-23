import { studioTheme } from "ag-studio";

export const rebookStudioTheme = studioTheme.withParams({
  fontFamily: "var(--font-geist-sans), Arial, sans-serif", fontSize: 12,
  accentColor: "var(--primary)", textColor: "var(--foreground)", foregroundColor: "var(--foreground)",
  subtleTextColor: "var(--muted)", borderColor: "var(--border)", backgroundColor: "#ffffff",
  studioWrapperBorder: false, studioWrapperBorderRadius: 0, studioWrapperSpacing: 0,
  studioCanvasBackgroundColor: "var(--background)", studioCanvasBorder: false, studioCanvasShadow: false,
  studioCanvasPadding: 12, studioCanvasRowHeight: 14,
  studioWidgetBackgroundColor: "#ffffff", studioWidgetBorder: { color: "var(--border)", width: 1 },
  studioWidgetBorderRadius: 10, studioWidgetPadding: 12,
  studioWidgetTitleFontSize: 12, studioWidgetTitleFontWeight: 600, studioWidgetTitleTextColor: "var(--muted)",
  studioPanelContainerBorderRadius: 10, gridFontSize: 11, gridHeaderFontSize: 11,
  gridHeaderTextColor: "var(--muted)", gridHeaderBackgroundColor: "var(--background)", gridRowHeight: 32,
  chartFontFamily: "var(--font-geist-sans), Arial, sans-serif", chartTextColor: "var(--foreground)",
  chartSubtleTextColor: "var(--muted)", chartGridLineColor: "var(--border)",
  chartPaletteFills1Color: "#1d4ed8", chartPaletteStrokes1Color: "#1d4ed8",
  chartPaletteFills2Color: "#15803d", chartPaletteStrokes2Color: "#15803d",
});
