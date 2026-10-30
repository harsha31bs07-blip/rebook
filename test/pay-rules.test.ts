import { expect, it } from "vitest";
import { StateSchema } from "../lib/domain/schemas";
import { coverAttendees, coverFee, describePayRule, payRule } from "../lib/recovery/pay-rules";
import { seedStudio } from "../lib/seed/seed";

it("uses instructor, studio, then legacy default rules", () => {
  const state = seedStudio();
  for (const instructor of state.instructors) delete instructor.pay;
  expect(payRule(StateSchema.parse(state), "instructor-02")).toEqual({ perClass: "35.00" });
  state.studio.coverPay = { perClass: "32.00" };
  expect(payRule(StateSchema.parse(state), "instructor-02")).toEqual({ perClass: "32.00" });
  state.instructors[1].pay = { perClass: "37.00", perAttendee: "0.50" };
  expect(payRule(StateSchema.parse(state), "instructor-02")).toEqual(state.instructors[1].pay);
});

it.each([
  [{ perClass: "35.00" }, 6, "35.00", "$35 per class"],
  [{ perClass: "30.00", perAttendee: "2.00" }, 6, "42.00", "$30 per class + $2 per attendee"],
  [{ perClass: "30.00", perAttendee: "2.00", cap: "50.00" }, 20, "50.00", "$30 per class + $2 per attendee, up to $50"],
  [{ perClass: "0.10", perAttendee: "0.20" }, 3, "0.70", "$0.10 per class + $0.20 per attendee"],
  [{ perClass: "0.00", perAttendee: "0.01", cap: "0.02" }, 3, "0.02", "$0 per class + $0.01 per attendee, up to $0.02"],
  [{ perClass: "30.00", perAttendee: "2.00" }, 0, "30.00", "$30 per class + $2 per attendee"],
] as const)("calculates and describes %j exactly", (rule, attendees, fee, description) => {
  expect(coverFee(rule, attendees)).toBe(fee);
  expect(describePayRule(rule)).toBe(description);
});

it("counts only active bookings in that session", () => {
  const state = seedStudio(), booking = state.bookings[0];
  state.bookings = ["confirmed", "moved", "cancelled", "refunded", "refund_pending"].map((status, index) => ({ ...booking, id: `b-${index}`, status: status as typeof booking.status }));
  state.bookings.push({ ...booking, id: "other-session", sessionId: "other" });
  expect(coverAttendees(state, booking.sessionId)).toBe(2);
});

it("applies a cap before converting large exact totals and rejects unsafe uncapped totals", () => {
  expect(coverFee({ perClass: "0.01", perAttendee: "90071992547409.90", cap: "500.00" }, 3)).toBe("500.00");
  expect(() => coverFee({ perClass: "0.01", perAttendee: "90071992547409.90" }, 3)).toThrow("Invalid cents total");
  expect(() => coverFee({ perClass: "35.00" }, -1)).toThrow("Invalid attendee count");
});
