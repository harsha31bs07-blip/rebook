// Published sandbox delivery from PayPal's postback verification example:
// https://developer.paypal.com/api/rest/webhooks/rest/#postback-method
// This is not a recording of the reported production delivery. Verification is mocked in tests.
export const sandboxWebhook = {
  headers: {
    "content-type": "application/json",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-ab66f33d",
    "paypal-transmission-id": "db49fb10-1343-11ef-ac58-e32457403f67",
    "paypal-transmission-time": "2024-05-16T05:19:23Z",
    "paypal-transmission-sig": "ab2tJk1VCFm4EqdSuKqezr38rTdY3JeRQlw94V1xYAIQVgLScAFn2XLRAhtyo/1jp8RZPO80hLpWfbdvvwyxK1u6L6NX/bnr0vA1wpfkwbqDT/Z01YP2VvJiYQdhpf/yXosoIKwP+37pYdAhwCsIu2D5fJAaDXpM8A06SpZJkR4f5+k566PDVPP7RCED9Xny4Yo0WyVaFORkiDJkBLGhUUIoO7Jv5JP5RQmFqVxhwSAaf4YYy/2r21r5HMQgAIgtS7oHYRea43Ze03Zz0EWqJu/hvKBzKHqhcvUPF64hVg8Nk2yqjnW7ZHgBWoHil2SJ1xQzaq2vDCXv5gWDn5+TZA==",
  },
  body: {
    id: "WH-3F562076HD293871E-75F399086E414290U",
    event_version: "1.0",
    create_time: "2024-05-16T05:19:19.355Z",
    resource_type: "capture",
    resource_version: "2.0",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    summary: "Payment completed for $ 500.0 USD",
    resource: {
      payee: { email_address: "receivingbusiness@example.com", merchant_id: "QDGTZ7B92B9QT" },
      amount: { value: "500.00", currency_code: "USD" },
      seller_protection: { dispute_categories: ["ITEM_NOT_RECEIVED", "UNAUTHORIZED_TRANSACTION"], status: "ELIGIBLE" },
      supplementary_data: { related_ids: { order_id: "9P99943869582473S" } },
      update_time: "2024-05-16T05:19:15Z",
      create_time: "2024-05-16T05:19:15Z",
      final_capture: true,
      seller_receivable_breakdown: {
        paypal_fee: { value: "25.44", currency_code: "USD" },
        gross_amount: { value: "500.00", currency_code: "USD" },
        net_amount: { value: "474.56", currency_code: "USD" },
      },
      links: [
        { method: "GET", rel: "self", href: "https://api.sandbox.paypal.com/v2/payments/captures/3Y662965014333303" },
        { method: "POST", rel: "refund", href: "https://api.sandbox.paypal.com/v2/payments/captures/3Y662965014333303/refund" },
        { method: "GET", rel: "up", href: "https://api.sandbox.paypal.com/v2/checkout/orders/9P99943869582473S" },
      ],
      id: "3Y662965014333303",
      status: "COMPLETED",
    },
    links: [
      { href: "https://api.sandbox.paypal.com/v1/notifications/webhooks-events/WH-3F562076HD293871E-75F399086E414290U", rel: "self", method: "GET" },
      { href: "https://api.sandbox.paypal.com/v1/notifications/webhooks-events/WH-3F562076HD293871E-75F399086E414290U/resend", rel: "resend", method: "POST" },
    ],
  },
};
