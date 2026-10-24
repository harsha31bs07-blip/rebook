"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { AgStudioAiModule, type AgReportState } from "ag-studio";
import type { Insights } from "@/lib/insights/data";
import { buildStudioData } from "@/lib/insights/studio-data";
import { buildRecoveryAi } from "@/lib/insights/ai";
import { initialReport, REPORT_STATE_VERSION, reportLayout, reportPages, restoreReportState } from "@/lib/insights/report";
import { rebookStudioTheme } from "@/lib/insights/theme";
import { customWidgets, type StudioRegistry } from "./widgets";
import { recoveryToolDisplay } from "./tool-cards";
import styles from "./insights.module.css";

const modules = [AgStudioAiModule];
const style = { height: "100%", width: "100%" };
const dataOptions = { maxExportRows: 10_000 };

export default function StudioReport({ id, data }: { id: string; data: Insights }) {
  const ref = useRef<AgStudio<StudioRegistry>>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasHeight, setCanvasHeight] = useState(444);
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setCanvasHeight(entry.contentRect.height));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(() => reportLayout(canvasHeight), [canvasHeight]);
  const key = `rebook:studio:${id}`;
  const [initialState] = useState<AgReportState<StudioRegistry>>(() => {
    try {
      return restoreReportState(localStorage.getItem(key));
    } catch { /* Storage can be unavailable or contain stale JSON. Start with the built-in report. */ }
    return initialReport;
  });
  const [selectedPage, setSelectedPage] = useState(initialState.selectedPageId);
  const [edit, setEdit] = useState(false);
  const [notice, setNotice] = useState("");
  const studioData = useMemo(() => buildStudioData(data), [data]);
  const ai = useMemo(() => buildRecoveryAi(id, data), [id, data]);
  const save = (state: AgReportState) => {
    setSelectedPage(state.selectedPageId);
    try { localStorage.setItem(key, JSON.stringify({ version: REPORT_STATE_VERSION, state })); } catch { setNotice("Changes work for this visit. Browser storage is unavailable."); }
  };
  const changePage = (pageId: string) => {
    const api = ref.current?.api;
    if (api) api.setState({ ...api.getState(), selectedPageId: pageId });
  };
  return <section className="insights-report" aria-label="Studio report">
    <div className="insights-toolbar"><nav aria-label="Insight pages">{reportPages.map((page) => <button key={page.id} aria-pressed={page.id === selectedPage} onClick={() => changePage(page.id)}>{page.label}</button>)}</nav>
      <div><button aria-pressed={edit} onClick={() => setEdit(!edit)}>{edit ? "Done editing" : "Edit report"}</button><button className="primary" onClick={() => {
        setEdit(true);
        const api = ref.current?.api;
        if (api) { const state = api.getState(); api.setState({ ...state, panels: { ...state.panels, ai: { ...state.panels?.ai, collapsed: false } } }); }
      }}>Ask Recovery analyst</button></div>
    </div>
    <p className={styles.pageDescription}>{reportPages.find((page) => page.id === selectedPage)?.description}</p>
    {notice && <p className="insights-storage-note" role="status">{notice}</p>}
    <div className="insights-studio" ref={canvasRef}><AgStudioProvider modules={modules} licenseKey={process.env.NEXT_PUBLIC_AG_STUDIO_LICENSE || undefined}>
      <AgStudio<StudioRegistry> ref={ref} style={style} data={studioData} dataOptions={dataOptions} theme={rebookStudioTheme} layout={layout} mode={edit ? "edit" : "view"} widgets={customWidgets} initialState={initialState} ai={ai} aiToolDisplay={recoveryToolDisplay}
        onStateUpdated={({ state }) => save(state)}
        onErrorRaised={(event) => { if (event.errorType === "state") setNotice("Some saved report settings could not be loaded. Edit the report or restore the default layout."); }} />
    </AgStudioProvider></div>
    <footer className="insights-footer"><span>USD · Simulated payments labelled · Applied recoveries in KPIs</span><button onClick={() => { ref.current?.api.setState(initialReport); setNotice(""); }}>Restore default report</button></footer>
  </section>;
}
