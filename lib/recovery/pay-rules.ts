import { z } from "zod";
import { MoneySchema } from "../domain/schemas";
import type { Instructor, State } from "../domain/types";
import { fromCents, toCents } from "../domain/time";
import { isActiveBooking } from "../solver/score";

export const COVER_FEE = "35.00";
export type PayRule = NonNullable<Instructor["pay"]>;
const AmountSchema = MoneySchema.refine((value) => Number(value) <= 500, "Amount must be between $0 and $500");
export const PayRuleSchema = z.strictObject({ perClass: AmountSchema, perAttendee: AmountSchema.optional(), cap: AmountSchema.optional() })
  .refine((rule) => rule.cap === undefined || Number(rule.cap) >= Number(rule.perClass), { path: ["cap"], message: "Cap must be at least the per-class amount" });
export const PayRuleUpdateSchema = z.union([PayRuleSchema, z.strictObject({ reset: z.literal(true) })]);

export function payRule(state: State, instructorId: string): PayRule {
  return state.instructors.find((item) => item.id === instructorId)?.pay ?? state.studio.coverPay ?? { perClass: COVER_FEE };
}

export function coverFee(rule: PayRule, attendees: number): string {
  if (!Number.isSafeInteger(attendees) || attendees < 0) throw new Error("Invalid attendee count");
  const total = BigInt(toCents(rule.perClass)) + BigInt(toCents(rule.perAttendee ?? "0.00")) * BigInt(attendees);
  return fromCents(Number(rule.cap !== undefined && total > BigInt(toCents(rule.cap)) ? BigInt(toCents(rule.cap)) : total));
}

export function describePayRule(rule: PayRule): string {
  const dollars = (value: string) => `$${value.replace(/\.00$/, "")}`;
  return `${dollars(rule.perClass)} per class${rule.perAttendee !== undefined ? ` + ${dollars(rule.perAttendee)} per attendee` : ""}${rule.cap !== undefined ? `, up to ${dollars(rule.cap)}` : ""}`;
}

export function coverAttendees(state: State, sessionId: string): number {
  return state.bookings.filter((booking) => booking.sessionId === sessionId && isActiveBooking(booking)).length;
}
