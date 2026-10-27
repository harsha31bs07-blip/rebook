"use client";

import { useState, useSyncExternalStore } from "react";

export const PHONE_QUERY = "(max-width: 760px)";
function subscribe(notify: () => void) {
  const media = window.matchMedia(PHONE_QUERY);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
}
const phoneSnapshot = () => window.matchMedia(PHONE_QUERY).matches;

export function useScheduleView() {
  const phone = useSyncExternalStore(subscribe, phoneSnapshot, () => false);
  const [selection, setView] = useState<"timeline" | "list">();
  return { phone, view: selection ?? (phone ? "list" : "timeline"), setView };
}
