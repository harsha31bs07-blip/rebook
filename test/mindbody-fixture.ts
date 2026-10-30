import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MindbodyClient } from "../lib/connectors/mindbody/client";
import type { MbClass, MbPerson, MbService, MbVisit, MbWaitlist } from "../lib/connectors/mindbody/types";

export const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(__dirname, "fixtures/mindbody", `${name}.json`), "utf8"));
export type Call = { path: string; query: URLSearchParams; body?: Record<string, unknown>; headers: Headers };
export const reply = (data: unknown, status = 200) => Response.json(data, { status });
export function sandbox() {
  const classes = fixture<{ Classes: MbClass[] }>("classes").Classes;
  const people = fixture<{ Clients: MbPerson[] }>("clients").Clients;
  const services: Record<string, MbService[]> = { "100015648": fixture<{ ClientServices: MbService[] }>("clientservices").ClientServices };
  const visits: Record<number, MbVisit[]> = { 19167: fixture<{ Class: { Visits: MbVisit[] } }>("classvisits").Class.Visits };
  const waitlist: MbWaitlist[] = [];
  const calls: Call[] = [];
  const api = { classes, people, services, visits, waitlist, calls, hook: undefined as ((call: Call) => Response | undefined) | undefined };
  let nextId = 90000;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), path = url.pathname.replace("/public/v6/", "");
    const call: Call = { path, query: url.searchParams, headers: new Headers(init?.headers), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) }; calls.push(call);
    const hooked = api.hook?.(call); if (hooked) return hooked;
    const page = (field: string, rows: unknown[]) => reply({ [field]: rows.slice(Number(call.query.get("Offset") ?? 0), Number(call.query.get("Offset") ?? 0) + 200), PaginationResponse: { TotalResults: rows.length } });
    if (path === "usertoken/issue") return reply({ AccessToken: "fixture-staff-token" });
    if (path === "site/sites") return reply(fixture("sites"));
    if (path === "class/classes") return page("Classes", classes.filter((row) => row.StartDateTime >= (call.query.get("StartDateTime") ?? "") && row.StartDateTime <= (call.query.get("EndDateTime") ?? "z")));
    if (path === "class/classvisits") return reply({ Class: { Visits: visits[Number(call.query.get("ClassID"))] ?? [] } });
    if (path === "class/waitlistentries") return page("WaitlistEntries", waitlist.filter((row) => call.query.get("ClassIds")?.split(",").includes(String(row.ClassId))));
    if (path === "client/clients") return page("Clients", people.filter((row) => call.query.has("SearchText") ? row.Email === call.query.get("SearchText") : call.query.get("ClientIds")?.split(",").includes(String(row.Id))));
    if (path === "client/clientservices") return page("ClientServices", services[call.query.get("ClientId")!] ?? []);
    const body = call.body!;
    if (path === "class/addclassschedule") {
      const source = classes.find((row) => row.ClassDescription.Id === body.ClassDescriptionId)!;
      classes.push({ ...structuredClone(source), Id: ++nextId, StartDateTime: `${body.StartDate}T${String(body.StartTime).slice(11)}`, EndDateTime: `${body.EndDate}T${String(body.EndTime).slice(11)}`,
        Staff: { Id: Number(body.StaffId) }, Resource: body.ResourceId ? { Id: Number(body.ResourceId), Name: "Replacement" } : null, TotalBooked: 0 });
      return reply({ ClassId: nextId + 1000, ClassInstanceIds: [nextId] });
    }
    if (path === "class/addclienttoclass") {
      const classId = Number(body.ClassId), clientId = String(body.ClientId), roster = visits[classId] ??= [];
      if (roster.some((row) => row.ClientId === clientId)) return reply({ Error: { Message: "Client already in class" } }, 400);
      roster.push({ Id: ++nextId, ClientId: clientId, ServiceId: body.ClientServiceId === undefined ? null : Number(body.ClientServiceId) });
      const row = classes.find((row) => row.Id === classId); if (row) row.TotalBooked = roster.length;
      return reply({ Visit: roster.at(-1) });
    }
    if (path === "class/removeclientfromclass") {
      const id = Number(body.ClassId); visits[id] = (visits[id] ?? []).filter((row) => row.ClientId !== body.ClientId);
      return reply({});
    }
    if (path === "class/cancelsingleclass") { const row = classes.find((row) => row.Id === body.ClassID); if (row) row.IsCanceled = true; return reply({}); }
    if (path === "class/substituteclassteacher") return reply({});
    if (path === "client/addclient") { const person = { Id: String(++nextId), FirstName: String(body.FirstName), LastName: String(body.LastName), Email: String(body.Email) }; people.push(person); return reply({ Client: person }); }
    throw new Error(`Unexpected fixture request: ${path}`);
  };
  const client = new MindbodyClient({ apiKey: "fixture-api-key", fetch: transport, sleep: async () => {} });
  return { ...api, get hook() { return api.hook; }, set hook(value) { api.hook = value; }, client, transport };
}
