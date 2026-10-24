export type EligibleMethods = { isEligible(method: string): boolean; getDetails(method: string): { productCode?: string; countryCode?: string } };
export function eligibleCheckoutMethods(methods: EligibleMethods) {
  return { paypal: methods.isEligible("paypal"), paylater: methods.isEligible("paylater"), cards: methods.isEligible("advanced_cards") };
}
// The supplied setup and migration references use different Pay Later tag names.
// Prefer the component registered by the loaded SDK, retaining its documented short alias.
export function payLaterButtonTag(registry: Pick<CustomElementRegistry, "get">): string {
  return registry.get("paypal-pay-later-button") ? "paypal-pay-later-button" : "paylater-button";
}
type Callbacks = { onApprove(data: { orderId: string }): Promise<void>; onCancel(): void; onError(error: { message?: string }): void };
export type PaymentSession = { start(options: { presentationMode: "auto" }, order: Promise<{ orderId: string }>): Promise<void> };
export type CardSession = {
  createCardFieldsComponent(options: { type: "number" | "expiry" | "cvv"; placeholder: string; style?: { input: { fontSize: string } } }): HTMLElement;
  submit(orderId: string, options?: { billingAddress: { postalCode: string } }): Promise<{ state: "succeeded" | "canceled" | "failed"; data: { orderId: string; message?: string } }>;
};
export type PayPalV6 = {
  findEligibleMethods(options: { currencyCode: string; amount: string }): Promise<EligibleMethods>;
  createPayPalOneTimePaymentSession(callbacks: Callbacks): PaymentSession;
  createPayLaterOneTimePaymentSession(callbacks: Callbacks): PaymentSession;
  createCardFieldsOneTimePaymentSession(): CardSession;
};
declare global {
  interface Window { paypal?: { createInstance(options: { clientId: string; components: string[]; pageType: string }): Promise<PayPalV6> } }
}

export function calendarFile(receipt: { bookingId: string; class: string; start: string; end: string }, studio: string) {
  const escape = (text: string) => text.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll(";", "\\;").replaceAll(",", "\\,").replaceAll("\r", "");
  const instant = (value: string) => new Date(value).toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Rebook//Class booking//EN", "BEGIN:VEVENT",
    `UID:${receipt.bookingId}@rebook`, `DTSTAMP:${instant(new Date().toISOString())}`, `DTSTART:${instant(receipt.start)}`,
    `DTEND:${instant(receipt.end)}`, `SUMMARY:${escape(receipt.class)}`, `LOCATION:${escape(studio)}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
}
