export type SubscriptionStatus =
  | "active"
  | "inactive"
  | "past_due"
  | "canceled"
  | "trialing";

export type LeadType = "management" | "guaranteed_rent";

export type FilterStatus = "off" | "active" | "pending_lift";

/**
 * Per-customer notification opt-in flags (customers.notification_preferences).
 * Stored as jsonb; the column is NOT NULL with every key defaulting to true.
 * Application code should still treat a missing key as `true` defensively.
 */
export interface NotificationPreferences {
  new_lead: boolean;
  credit_warnings: boolean;
  inactivity_nudge: boolean;
  progress_report: boolean;
}

export interface Customer {
  id: string;
  user_id: string | null;
  business_name: string;
  contact_name: string;
  email: string;
  phone: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: SubscriptionStatus | string;
  monthly_allocation: number;
  leads_received_this_month: number;
  lead_balance: number;
  account_status: "waitlisted" | "invited" | "active" | "cancelled" | string;
  is_active: boolean;
  first_login_at: string | null;
  last_assignment_at: string | null;
  billing_cycle_anchor: string | null;
  // Guaranteed Rent subscription (independent of the management subscription).
  gr_subscription_status: SubscriptionStatus | string;
  gr_stripe_subscription_id: string | null;
  gr_stripe_price_id: string | null;
  gr_monthly_allocation: number;
  gr_leads_received_this_month: number;
  gr_billing_cycle_anchor: string | null;
  gr_last_assignment_at: string | null;
  gr_lead_balance: number;
  // Lead filtering (management product).
  filter_status: FilterStatus | string;
  filter_areas: string[] | null;
  filter_min_bedrooms: number | null;
  filter_max_bedrooms: number | null;
  filter_enabled_at: string | null;
  filter_lift_effective_date: string | null;
  // Lead filtering (guaranteed-rent product) — gr_ mirror of the above.
  gr_filter_status: FilterStatus | string;
  gr_filter_areas: string[] | null;
  gr_filter_min_bedrooms: number | null;
  gr_filter_max_bedrooms: number | null;
  gr_filter_enabled_at: string | null;
  gr_filter_lift_effective_date: string | null;
  // Enquiry-form fields captured on the landing page.
  website_url: string | null;
  properties_managed: string | null;
  // Opt-out for the instant new-lead SMS alert (default true).
  sms_alerts_enabled: boolean;
  // Per-stream notification opt-in flags (jsonb, NOT NULL, all default true).
  notification_preferences: NotificationPreferences;
  // Last inactivity-nudge send, for same-day dedup (null = never nudged).
  last_nudge_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Lead {
  id: string;
  monday_item_id: string;
  lead_name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  lead_profile: string | null;
  bedrooms: string | null;
  enquiry_date: string | null;
  postcode: string | null;
  postcode_area: string | null;
  lead_type: LeadType;
  assignment_count: number;
  max_assignments: number;
  created_at: string;
  // GR-specific fields (null for management leads).
  last_contact: string | null;
  desired_rent: string | null;
  pmi_analysis: string | null;
  tenancy_agreement: string | null;
  sourcing_agreement: string | null;
  formula: string | null;
}

export type PipelineStage =
  | "cold"
  | "interested_in_the_future"
  | "web_meeting_booked"
  | "web_meeting_no_show"
  | "web_meeting_attended"
  | "abandoned"
  | "viewing_booked"
  | "contract_sent"
  | "contract_signed";

export interface LeadAssignment {
  id: string;
  lead_id: string;
  customer_id: string;
  price_paid: number;
  notification_sent: boolean;
  email_sent: boolean;
  viewed_at: string | null;
  first_contacted_at: string | null;
  status: string;
  pipeline_stage: PipelineStage | string;
  due_to_call_date: string | null;
  income_estimate: number | null;
  assigned_at: string;
  // When `status` last changed (NOT NULL, defaults to now() at insert so a
  // brand-new 'new' assignment is stamped at assignment time). Powers the
  // inactivity nudge's "days since last activity" measure.
  last_status_change_at: string;
}

export interface AssignmentWithLead extends LeadAssignment {
  lead: Lead;
}

export interface Testimonial {
  id: string;
  customer_id: string;
  lead_assignment_id: string | null;
  body: string;
  rating: number | null;
  consent_to_publish: boolean;
  created_at: string;
}

export interface LeadNote {
  id: string;
  lead_assignment_id: string;
  customer_id: string;
  body: string;
  created_at: string;
}

export interface LeadFile {
  id: string;
  lead_assignment_id: string;
  customer_id: string;
  file_name: string;
  storage_path: string;
  size_bytes: number | null;
  mime_type: string | null;
  created_at: string;
}

export interface Notification {
  id: string;
  customer_id: string;
  lead_assignment_id: string | null;
  notification_type: string;
  message: string;
  read_at: string | null;
  email_sent: boolean;
  created_at: string;
}

export interface Payment {
  id: string;
  customer_id: string;
  stripe_payment_intent_id: string | null;
  stripe_invoice_id: string | null;
  amount_pence: number;
  credits_added: number | null;
  payment_type: string | null;
  status: string | null;
  created_at: string;
}

/**
 * Shape n8n POSTs to /api/webhook/n8n.
 *
 * Management leads carry the fixed field set below. Guaranteed-rent leads set
 * `lead_type: "guaranteed_rent"` and carry the GR board fields keyed by their
 * Monday column id (or the equivalent friendly name), so the payload is left
 * open with an index signature. The two banned GR columns are stripped at the
 * webhook entry point before this payload reaches ingest.
 */
export interface N8nLeadPayload {
  monday_item_id: string;
  lead_name: string;
  lead_type?: LeadType;
  address?: string;
  phone?: string;
  email?: string;
  lead_profile?: string;
  bedrooms?: string;
  enquiry_date?: string;
  [key: string]: unknown;
}
