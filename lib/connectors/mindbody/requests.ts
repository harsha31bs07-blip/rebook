import { localParts } from "../../domain/time";
import type { Session } from "../../domain/types";
import type { MindbodyLink } from "./types";

const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const staffLogin = (username: string, password: string) => ({ Username: username, Password: password });
export const substitute = (classId: number, staffId: number) => ({ ClassId: classId, StaffId: staffId });
export const cancelClass = (classId: number) => ({ ClassID: classId, SendClientEmail: false, SendStaffEmail: false });
export const addBooking = (clientId: string, classId: number, serviceId?: number) => ({ ClientId: clientId, ClassId: classId,
  RequirePayment: false, Waitlist: false, SendEmail: false, ...(serviceId === undefined ? {} : { ClientServiceId: serviceId }) });
export const removeBooking = (clientId: string, classId: number) => ({ ClientId: clientId, ClassId: classId, LateCancel: false, SendEmail: false });
export const removeWaitlist = (ids: number[]) => ({ WaitlistEntryIds: ids });
export function addClient(name: string, email: string) {
  const [first, ...last] = name.trim().split(/\s+/);
  return { FirstName: first, LastName: last.join(" ") || first, Email: email, SendEmail: false };
}
export function oneOff(session: Session, mapping: MindbodyLink["sessions"][string], timezone: string) {
  const start = localParts(session.start, timezone), end = localParts(session.end, timezone);
  if (start.dateKey !== end.dateKey) throw new Error("Mindbody one-off classes must end on the same local day.");
  // Mindbody reads only the time of day from these date-times (verified against the sandbox); a bare "HH:MM:SS" is rejected.
  const clock = (minutes: number) => `1900-01-01T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00`;
  return { ClassDescriptionId: mapping.descriptionId, LocationId: mapping.locationId, StartDate: start.dateKey, EndDate: start.dateKey,
    StartTime: clock(start.minutesOfDay), EndTime: clock(end.minutesOfDay),
    ...Object.fromEntries(days.map((day, index) => [`Day${day}`, index === start.weekday])),
    StaffId: mapping.staffId, StaffPayRate: 1, ...(mapping.resourceId === undefined ? {} : { ResourceId: mapping.resourceId }),
    MaxCapacity: session.capacity, WebCapacity: session.capacity, WaitlistCapacity: 10, BookingStatus: "PaymentRequired",
    AllowOpenEnrollment: false, AllowDateForwardEnrollment: false };
}
