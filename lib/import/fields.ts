import type { Booking, ClassType } from "../domain/types";

/** The columns Rebook reads from a booking export: one row per booking (or per class with no bookings). */
export const IMPORT_FIELDS = ["class", "date", "start", "end", "duration", "instructor", "room", "capacity", "price", "payment", "customer_name", "customer_email", "accepts_substitute", "status", "visitsLeft", "expires"] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type ColumnMapping = Partial<Record<ImportField, string>>;
/** A date column is optional when the start column carries the date too. */
export const REQUIRED_FIELDS: ImportField[] = ["class", "start", "instructor"];
export const FIELD_LABELS: Record<ImportField, string> = {
  class: "Class name", date: "Date", start: "Start time", end: "End time", duration: "Duration (minutes)", instructor: "Instructor",
  room: "Room", capacity: "Capacity", price: "Price paid", customer_name: "Customer name", customer_email: "Customer email", accepts_substitute: "Accepts a substitute",
  status: "Booking status", payment: "Paid with", visitsLeft: "Visits left", expires: "Pack expires",
};

const SYNONYMS: Record<ImportField, string[]> = {
  visitsLeft: ["visitsleft", "remaining", "remainingvisits", "classesleft", "creditsleft", "sessionsremaining", "balance"],
  expires: ["packexpires", "expires", "expiry", "expiration", "expirationdate", "validuntil"],
  class: ["class", "classname", "classtitle", "title", "servicename", "session", "sessionname", "program", "activity"],
  date: ["date", "classdate", "sessiondate", "day", "visitdate"],
  start: ["start", "starttime", "time", "begins", "classtime", "from", "startsat"],
  end: ["end", "endtime", "finishes", "to", "endsat"],
  duration: ["duration", "durationminutes", "durationmin", "length", "minutes", "mins"],
  instructor: ["instructor", "instructorname", "teacher", "staff", "staffname", "trainer", "coach", "leader"],
  room: ["room", "roomname", "location", "space", "resource", "studioroom"],
  capacity: ["capacity", "maxcapacity", "spots", "classsize", "maxattendees", "spaces"],
  payment: ["payment", "paymentmethod", "paidwith", "pricingoption", "pricing", "service", "pass", "membership"],
  price: ["price", "pricepaid", "amount", "amountpaid", "paid", "cost", "fee", "total"],
  customer_name: ["customer", "customername", "client", "clientname", "member", "membername", "name", "attendee", "attendeename", "fullname"],
  customer_email: ["email", "customeremail", "clientemail", "memberemail", "emailaddress", "attendeeemail"],
  accepts_substitute: ["acceptssubstitute", "substituteok", "subok", "acceptssub"],
  status: ["status", "bookingstatus", "attendance", "visitstatus"],
};
const normal = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Rules first: exact header synonyms. Whatever stays unmatched may go to the AI as headers only. */
export function ruleMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {}, used = new Set<string>();
  for (const field of IMPORT_FIELDS) {
    const header = headers.find((item) => !used.has(item) && SYNONYMS[field].includes(normal(item)));
    if (header) { mapping[field] = header; used.add(header); }
  }
  return mapping;
}

// Specific types first: "Dance Flow" is dance and "Pilates Flow" pilates; a bare "flow" means yoga.
const KEYWORDS: [ClassType, RegExp][] = [
  ["barre", /\bbarre\b/i],
  ["pilates", /pilates|reformer|\bmat\b|\bcore\b/i],
  ["spin", /spin|cycl|\bride\b|\bbike\b|rhythm ride/i],
  ["dance", /dance|zumba|hip ?hop|ballet|salsa|jazz/i],
  ["hiit", /hiit|bootcamp|boot camp|circuit|tabata|interval|strength|conditioning|boxing|crossfit|sculpt/i],
  ["yoga", /yoga|vinyasa|hatha|\byin\b|ashtanga|restorative|kundalini|power flow|\bflow\b/i],
];
/** Class name -> one of Rebook's class types by keyword, or undefined for the AI and the owner to decide. */
export function ruleClassType(name: string): ClassType | undefined {
  return KEYWORDS.find(([, pattern]) => pattern.test(name))?.[0];
}

/** A pass describes the booking's visit, not a payment captured by Rebook. */
export function paymentEntitlement(value: string): Booking["entitlement"] {
  const name = value.trim().slice(0, 60);
  if (/pack|class pass|classpass|credits|\b\d+\s*-?\s*(class|visit)/i.test(value)) return { kind: "pack", name };
  if (/member|unlimited|monthly|annual|autopay/i.test(value)) return { kind: "membership", name };
  return undefined;
}
