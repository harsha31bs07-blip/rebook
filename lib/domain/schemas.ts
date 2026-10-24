import { z } from "zod";

export const ClassTypeSchema = z.enum(["yoga", "pilates", "spin", "dance", "hiit", "barre"]);
export const MoneySchema = z.string().regex(/^(0|[1-9]\d*)\.\d{2}$/).refine((value) => {
  const [whole, fraction] = value.split(".");
  return Number.isSafeInteger(Number(whole) * 100 + Number(fraction));
}, "Amount must fit in safe integer cents");
export const IsoSchema = z.iso.datetime({ offset: true });
export const ClockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const HoursSchema = z.object({ open: ClockSchema, close: ClockSchema })
  .refine((hours) => hours.open < hours.close, "Hours must close after opening");
export const WindowSchema = z.object({ from: IsoSchema, to: IsoSchema })
  .refine((window) => Date.parse(window.from) < Date.parse(window.to), "Window must have positive duration");
export const StudioSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), timezone: z.string().min(1),
  weekStart: IsoSchema,
  // Weekdays use the studio's IANA time zone: 0 is Sunday. Missing weekdays are closed.
  openHours: z.record(z.coerce.number().int().min(0).max(6), z.array(HoursSchema)),
  currency: z.literal("USD"),
});
export const InstructorSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), skills: z.array(ClassTypeSchema),
  maxSessionsPerDay: z.number().int().positive(),
  unavailability: z.array(WindowSchema).optional(),
});
export const RoomSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), capacity: z.number().int().positive(),
  supports: z.array(ClassTypeSchema),
});
export const PlacementSchema = z.object({
  instructorId: z.string().min(1), roomId: z.string().min(1), start: IsoSchema, end: IsoSchema,
}).refine((value) => Date.parse(value.start) < Date.parse(value.end), "Session must have positive duration");
export const SessionSchema = PlacementSchema.safeExtend({
  id: z.string().min(1), classType: ClassTypeSchema, title: z.string().min(1),
  capacity: z.number().int().positive(), price: MoneySchema,
});
export const CustomerSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), email: z.email(),
  prefs: z.object({
    windows: z.array(z.object({
      weekday: z.number().int().min(0).max(6), from: ClockSchema, to: ClockSchema,
    }).refine((window) => window.from < window.to, "Preference window must have positive duration")),
    preferredInstructorIds: z.array(z.string()).optional(),
    acceptsSubstitute: z.boolean(), refundOnly: z.boolean().optional(),
  }),
});
export const BookingSchema = z.object({
  id: z.string().min(1), sessionId: z.string().min(1), customerId: z.string().min(1),
  status: z.enum(["confirmed", "moved", "refund_pending", "refunded", "cancelled"]),
  amount: MoneySchema,
  payment: z.object({ orderId: z.string(), captureId: z.string(), simulated: z.boolean().optional(), unknown: z.boolean().optional() }).optional(),
});
const DisruptionBase = { from: IsoSchema, to: IsoSchema, reason: z.string().optional() };
export const DisruptionSchema = z.discriminatedUnion("kind", [
  z.object({ ...DisruptionBase, kind: z.literal("instructor_unavailable"), instructorId: z.string() }),
  z.object({ ...DisruptionBase, kind: z.literal("room_unavailable"), roomId: z.string() }),
  z.object({ ...DisruptionBase, kind: z.literal("closure") }),
]).refine((value) => Date.parse(value.from) < Date.parse(value.to), "Disruption must have positive duration");
export const StateSchema = z.object({
  studio: StudioSchema, instructors: z.array(InstructorSchema), rooms: z.array(RoomSchema),
  sessions: z.array(SessionSchema), customers: z.array(CustomerSchema), bookings: z.array(BookingSchema),
});
export const RemedySchema = z.enum(["substitute", "move_room", "move_time", "cancel"]);
export const SessionChangeSchema = z.object({
  sessionId: z.string(), remedy: RemedySchema, before: PlacementSchema,
  after: PlacementSchema.optional(), reason: z.string(),
}).refine((change) => (change.remedy === "cancel") === (change.after === undefined),
  "Only cancellation omits the replacement placement");
export const BookingActionSchema = z.object({
  bookingId: z.string(), customerId: z.string(), action: z.enum(["keep", "move", "refund"]),
  amount: MoneySchema, reason: z.string(),
});
export const TotalsSchema = z.object({
  sessionsAffected: z.number().int().nonnegative(), kept: z.number().int().nonnegative(),
  moved: z.number().int().nonnegative(), refunded: z.number().int().nonnegative(),
  refundAmount: MoneySchema, revenueKept: MoneySchema,
});
export const PlanSchema = z.object({
  disruption: DisruptionSchema,
  // Recorded so validation can distinguish upcoming sessions from historical ones.
  now: IsoSchema,
  sessionChanges: z.array(SessionChangeSchema), bookingActions: z.array(BookingActionSchema),
  totals: TotalsSchema, warnings: z.array(z.string()),
});
export const WeightsSchema = z.object({
  substitute: z.number().finite().nonnegative(), moveRoom: z.number().finite().nonnegative(),
  moveTime: z.number().finite().nonnegative(), cancel: z.number().finite().nonnegative(),
  weekdayChange: z.number().finite().nonnegative(), timeShift: z.number().finite().nonnegative(),
  delay: z.number().finite().nonnegative(), refund: z.number().finite().nonnegative(),
});
export const ReplanOptionsSchema = z.object({
  horizonDays: z.number().int().min(0).max(365).optional(), now: IsoSchema.optional(),
  horizonEnd: IsoSchema.optional(),
  weights: WeightsSchema.partial().optional(),
});

export type ClassType = z.infer<typeof ClassTypeSchema>;
export type Studio = z.infer<typeof StudioSchema>;
export type Instructor = z.infer<typeof InstructorSchema>;
export type Room = z.infer<typeof RoomSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type Placement = z.infer<typeof PlacementSchema>;
export type Customer = z.infer<typeof CustomerSchema>;
export type Booking = z.infer<typeof BookingSchema>;
export type Disruption = z.infer<typeof DisruptionSchema>;
export type State = z.infer<typeof StateSchema>;
export type Remedy = z.infer<typeof RemedySchema>;
export type SessionChange = z.infer<typeof SessionChangeSchema>;
export type BookingAction = z.infer<typeof BookingActionSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type Weights = z.infer<typeof WeightsSchema>;
export type ReplanOptions = z.infer<typeof ReplanOptionsSchema>;
