export type MbId = string | number;
export type MbPerson = { Id: MbId; FirstName?: string; LastName?: string; DisplayName?: string; Email?: string | null };
export type MbService = { Id: number; Name: string; Count?: number | null; Remaining: number; ExpirationDate?: string; Current?: boolean };
export type MbVisit = { Id: number; ClientId: string; LateCancelled?: boolean; ServiceId?: number | null; ServiceName?: string | null; Service?: MbService | null };
export type MbWaitlist = { Id: number; ClassId: number; ClientId: string; Client?: MbPerson };
export type MbClass = { Id: number; StartDateTime: string; EndDateTime: string; ClassDescription: { Id: number; Name: string; Active?: boolean }; Staff: MbPerson;
  Location: { Id: number; Name: string }; Resource?: { Id: number; Name: string } | null; MaxCapacity: number; TotalBooked: number; IsCanceled?: boolean };
export type ClassSnapshot = { visits: Record<string, string>; waitlist: Record<string, string>; capacity: number };
export type MindbodyLink = {
  siteId: number; locationId: number; location: string; week: string;
  sessions: Record<string, { classId: number; descriptionId: number; locationId: number; resourceId?: number; staffId: number; inactive?: true }>;
  clients: Record<string, string>; services: Record<string, number>;
  snapshot: { classes: Record<string, ClassSnapshot>; packs: Record<string, { serviceId: number; remaining: number; expires?: string }> };
  ownChangeIds: string[]; ownWrites: Record<string, "added" | "removed">; ownPacks: Record<string, number>;
  progress: Record<string, { newClassId?: number; existingIds?: number[]; scheduleRequested?: boolean; done?: boolean }>;
  lastPush?: string; lastPull?: string;
  eventVersions?: Record<string, number>;
};
export type MindbodyStatus = { connected: boolean; location: string; week: string; lastPush?: string; lastPull?: string };
