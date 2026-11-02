/** Only declared report operations and read-only PayPal verification may cross the provider boundary. */
export const agentTools = {
  "recovery-analyst": ["get_recovery_summary", "get_refund_breakdown", "get_revenue_breakdown", "get_cover_summary", "verify_with_paypal", "add_preset_chart", "get_disruptions", "get_refund_receipts", "delegate_to"],
  lead: ["view_schema", "view_report", "view_page", "view_plan", "update_plan", "clear_plan", "rename_thread", "delegate_to", "complete_task"],
  planning: ["view_schema", "view_report", "view_page", "view_plan", "create_plan", "complete_task"],
  data: ["view_schema", "execute_query", "create_expression", "update_expression", "delete_expression", "complete_task"],
  page: ["view_schema", "view_page", "view_plan", "add_widget", "position_widget", "remove_widget", "add_page_filter", "remove_page_filter", "complete_task"],
  widget: ["view_schema", "view_plan", "view_widget", "configure_widget", "add_widget_filter", "remove_widget_filter", "complete_task"],
} as const;
export type RecoveryAgentId = keyof typeof agentTools;
export const recoveryDelegates = ["data", "page", "planning", "widget"] as const;
