"use client";

import { useEffect, type ReactNode } from "react";

export type StudioTool = { id: string; title: string; badge?: string; children: ReactNode };

/** Secondary tools stay folded so the recovery reads as one story; a link to a tool (e.g. #waitlist) unfolds it. */
export default function StudioTools({ tools }: { tools: StudioTool[] }) {
  useEffect(() => {
    const unfold = (hash: string) => {
      const target = hash.length > 1 ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
      const tool = target?.closest("details.studio-tool");
      if (!(tool instanceof HTMLDetailsElement)) return undefined;
      tool.open = true;
      return target!;
    };
    const onClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a[href^='#']") : null;
      const target = link && unfold(link.getAttribute("href")!);
      if (!target) return;
      event.preventDefault();
      history.replaceState(null, "", link.getAttribute("href"));
      requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
    };
    const onHash = () => { unfold(location.hash)?.scrollIntoView({ block: "start" }); };
    document.addEventListener("click", onClick); window.addEventListener("hashchange", onHash); onHash();
    return () => { document.removeEventListener("click", onClick); window.removeEventListener("hashchange", onHash); };
  }, []);
  if (!tools.length) return null;
  return <section className="studio-tools" aria-labelledby="studio-tools-title"><h3 id="studio-tools-title">Studio tools</h3>
    {tools.map((tool) => <details key={tool.id} className="studio-tool" data-tool={tool.id}>
      <summary><span>{tool.title}</span>{tool.badge && <span className="pill">{tool.badge}</span>}</summary>
      {tool.children}
    </details>)}
  </section>;
}
