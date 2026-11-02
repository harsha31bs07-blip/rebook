import type { Disruption } from "../domain/types";
import { localParts } from "../domain/time";
import type { OwnerCover } from "./cover-pay";
import type { summarizeRecovery } from "./outcomes";

type Cover = Pick<OwnerCover, "instructor" | "class" | "status" | "current" | "fee" | "payout"> & Partial<Pick<OwnerCover, "next">>;

const money = (value: string | number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value));
const IN_MOTION = ["REQUESTED", "PENDING", "UNCLAIMED", "ONHOLD"];

/** Covers a recovery still depends on: whoever teaches the class now, plus anyone with a payout on record. */
export const activeCovers = <T extends Cover>(covers: T[] = []) => covers.filter((cover) => cover.current || cover.payout);

export function coverSettled(cover: Cover): boolean {
  if (cover.payout?.status === "SUCCESS") return true;
  // Someone no longer teaching this class only holds things up while their money is still moving.
  if (!cover.current) return !IN_MOTION.includes(cover.payout?.status ?? "");
  return cover.status === "accepted" && !cover.payout && Number(cover.fee) === 0;
}

/** The owner has to do something: the class has no teacher, or a payout needs them. */
export function coverNeedsOwner(cover: Cover): boolean {
  if (coverSettled(cover) || !cover.current) return false;
  if (cover.status === "declined") return true;
  if (!cover.payout) return cover.status === "accepted";
  // A send finishes within the request, so a payout still REQUESTED is one PayPal never confirmed. Only the owner's check resolves it.
  return !IN_MOTION.includes(cover.payout.status) || cover.payout.status === "REQUESTED";
}

/** One plain sentence for a cover. Every payout status is named, so a failed payout never reads as on its way. */
export function coverLine(cover: Cover): string {
  const { instructor: name, payout } = cover;
  if (payout) {
    const amount = money(payout.amount);
    switch (payout.status) {
      case "SUCCESS": return `${name} paid ${amount} with PayPal`;
      case "REQUESTED": return `PayPal hasn't confirmed ${name}'s ${amount} payout; check it before paying another way`;
      case "PENDING": return `${name}'s ${amount} payout is processing at PayPal`;
      case "UNCLAIMED": return `${name} hasn't claimed the ${amount} payout yet`;
      case "ONHOLD": return `PayPal has put ${name}'s ${amount} payout on hold`;
      case "RETURNED": case "REFUNDED": case "REVERSED": return `${name}'s ${amount} payout came back; ${name} hasn't been paid`;
      default: return `${name}'s ${amount} payout failed; ${name} hasn't been paid`;
    }
  }
  if (cover.status === "declined") return cover.next ? `${name} can't cover ${cover.class}; ask ${cover.next}` : cover.next === null ? `${name} can't cover ${cover.class} and no one else qualified is free; plan this class again` : `${name} can't cover ${cover.class}`;
  if (cover.status === "accepted") return Number(cover.fee) === 0 ? `${name} is covering` : `${name} is covering · ${money(cover.fee)} to pay`;
  return `${name} hasn't answered the cover request yet`;
}

/** One answer to "is this finished?" for the headline, the plan heading and What happens next. */
export const recoveryHandled = (recovery: ReturnType<typeof summarizeRecovery>, covers: Cover[] = []) =>
  recovery.complete && recovery.pending === 0 && activeCovers(covers).every(coverSettled);

/** "Monday" when a disruption fits in one studio day; a longer one has no single name. */
export function recoveryDay(disruption: Disruption, timezone: string): string | undefined {
  const from = localParts(disruption.from, timezone), last = localParts(new Date(Date.parse(disruption.to) - 1).toISOString(), timezone);
  return from.dateKey === last.dateKey ? new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(new Date(disruption.from)) : undefined;
}
