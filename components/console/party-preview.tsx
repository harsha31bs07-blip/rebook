"use client";

import { useEffect, useRef, useState } from "react";

type Party = "customer" | "instructor";

/** The real private pages a customer and the substitute receive, framed as phones inside the console. */
export default function PartyPreview({ initial, customerPath, coverPath, instructor, onClose }: {
  initial: Party; customerPath?: string; coverPath?: string; instructor?: string; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [party, setParty] = useState<Party>(initial);
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => { element?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  const tabs = ([["customer", "Customer", customerPath], ["instructor", instructor ? `${instructor} (cover)` : "Cover instructor", coverPath]] as const).filter(([, , path]) => path);
  const path = party === "customer" ? customerPath : coverPath;
  return <dialog ref={dialog} className="party-preview" aria-labelledby="party-preview-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="drawer-header"><div><p className="eyebrow">See what they see</p><h2 id="party-preview-title">Their private page</h2></div><button autoFocus onClick={onClose} aria-label="Close preview">Close</button></div>
    <div className="segmented" role="tablist" aria-label="Whose page">{tabs.map(([key, label]) =>
      <button key={key} role="tab" aria-selected={party === key} aria-controls="party-frame" onClick={() => setParty(key)}>{label}</button>)}</div>
    <p className="muted">The real link they receive. Anything you do here really happens (PayPal sandbox).</p>
    {path && <div className="phone-frame"><iframe id="party-frame" key={path} src={path} title={party === "customer" ? "Customer’s private page" : "Cover instructor’s private page"} /></div>}
  </dialog>;
}
