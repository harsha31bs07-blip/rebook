import { z } from "zod";
import { BookingSchema, CustomerSchema, IsoSchema, MoneySchema, SessionSchema } from "../domain/schemas";

const session = z.union([z.strictObject({ id: z.string().min(1).max(100) }), z.strictObject({ title: SessionSchema.shape.title.max(200), start: IsoSchema })]);
const customer = z.strictObject({ name: CustomerSchema.shape.name.trim().max(100), email: CustomerSchema.shape.email.optional() });
const entitlement = BookingSchema.shape.entitlement.unwrap().transform((value) => value);
const optionalEntitlement = z.preprocess((value) => value && typeof value === "object" && !("name" in value)
  ? { ...value, name: (value as { kind: string }).kind === "pack" ? "Class pack" : "Membership" } : value, entitlement).optional();
const base = { eventId: z.string().trim().min(1).max(100) };
export const InboundEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...base, type: z.literal("booking.created"), session, customer, entitlement: optionalEntitlement, amount: MoneySchema.optional() }),
  z.strictObject({ ...base, type: z.literal("booking.cancelled"), session, customer }),
  z.strictObject({ ...base, type: z.literal("pack.balance"), customer, visitsLeft: z.number().int().nonnegative().safe(), expires: z.iso.date().optional() }),
  z.strictObject({ ...base, type: z.literal("waitlist.joined"), session, customer, entitlement: optionalEntitlement }),
  z.strictObject({ ...base, type: z.literal("waitlist.left"), session, customer }),
  z.strictObject({ ...base, type: z.literal("session.capacity"), session, capacity: SessionSchema.shape.capacity.safe() }),
]);
export const EventsSchema = z.strictObject({ events: z.array(InboundEventSchema).min(1).max(100) });
export const AckSchema = z.strictObject({ ids: z.array(z.string().min(1).max(300)).max(500) });
export type InboundEvent = z.infer<typeof InboundEventSchema>;
