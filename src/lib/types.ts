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
  // Pause subscription (management-only, 3-month, one-time). When paused_at is
  // set the customer is not billed and receives no new management leads, but
  // account_status stays 'active' so their capacity slot is reserved.
  paused_at: string | null;
  pause_resumes_at: string | null;
  pause_count: number;
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
  // Last Friday progress-report send, for same-week dedup (null = never sent).
  last_report_sent_at: string | null;
  // Goals (management only, 0051). The target is customer-settable — but only
  // through set_management_customer_goal(), never a direct write.
  // null = no goal set, which is a distinct state from a goal of zero (the
  // column's CHECK forbids zero).
  management_customer_goal: number | null;
  management_customer_goal_updated_at: string | null;
  // Monotonic count of management leads ever delivered. NOT a pacing counter
  // (leads_received_this_month resets on the anchor day) and NOT an allocation
  // gate (lead_balance is spent and topped up) — it only ever counts up.
  management_lifetime_leads_received: number;
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
  /**
   * How many customers this lead may reach through ordinary routing. Defaults
   * to DEFAULT_MAX_ASSIGNMENTS at the database level; admin can override it per
   * lead. Soft reclaim adds a derived slot on top of this without changing it
   * (0046).
   */
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
  | "contract_signed"
  // Terminal win for Management. GR uses contract_signed for the same thing;
  // both set status = 'won' via the 0050 trigger.
  | "won";

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
  // Soft reclaim (0043). Set on the ORIGINAL assignment when its lead is
  // released to a second operator; null otherwise.
  reclaimed_at: string | null;
  // True only on the SECOND (discounted) assignment of a reclaimed lead, never
  // on the original.
  is_reclaimed: boolean;
}

/**
 * Passive engagement signals (lead_events, 0043).
 *
 * These record what the operator DID, as distinct from `status`, which records
 * what they said they did. Only the browser-driven three are emitted today;
 * the remaining three are reserved for server-side emission.
 *
 * Distinct from `viewed_at`: that is set solely by expanding a lead CARD in the
 * feed, so a lead read end-to-end via a direct link or prev/next navigation
 * never sets it. `detail_opened` is the honest "this lead was read" signal.
 */
export type LeadEventType =
  | "detail_opened"
  | "tel_click"
  | "mailto_click"
  | "note_added"
  | "file_added"
  | "stage_changed"
  // System-generated (0044) — recorded here because it is the only
  // per-assignment record of a nudge. NOT an engagement signal: it is something
  // we did to the operator, not something they did.
  | "nudge_sent";

/**
 * The operator-generated subset. Engagement aggregates must filter to these
 * explicitly — counting every lead_events row would let our own nudges inflate
 * the score of the least engaged customers, inverting the measure.
 */
/**
 * How many customers one lead reaches through ordinary routing.
 *
 * This mirrors the database default on `leads.max_assignments` (0055 raised it
 * from 2 to 3). It is only ever a fallback for a row whose column is somehow
 * null — the stored per-lead value always wins, because admin can override it
 * on a single lead. Kept in one place so the three shortfall calculations
 * (ingest top-up, the admin overview count, assign-pending) cannot drift apart
 * the way the per-lead price once did.
 */
export const DEFAULT_MAX_ASSIGNMENTS = 3;

export const ENGAGEMENT_EVENT_TYPES = [
  "detail_opened",
  "tel_click",
  "mailto_click",
] as const satisfies readonly LeadEventType[];

/** Events a browser client is permitted to report via POST /api/customer/events. */
export const CLIENT_LEAD_EVENT_TYPES = [
  "detail_opened",
  "tel_click",
  "mailto_click",
] as const satisfies readonly LeadEventType[];

export type ClientLeadEventType = (typeof CLIENT_LEAD_EVENT_TYPES)[number];

export interface LeadEvent {
  id: string;
  assignment_id: string;
  event_type: LeadEventType;
  created_at: string;
  metadata: Record<string, unknown> | null;
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

export type TrainingContentType = "video" | "audio" | "article";

export type TrainingVideoProvider = "loom" | "youtube" | "vimeo";

/** Which product a module applies to. 'both' is the default and the common case. */
export type TrainingLeadTypeScope = LeadType | "both";

export interface TrainingModule {
  id: string;
  slug: string;
  title: string;
  summary: string;
  content_type: TrainingContentType;
  sort_order: number;
  video_provider: TrainingVideoProvider | null;
  video_url: string | null;
  video_duration_seconds: number | null;
  /** Path inside the private 'training-audio' bucket, never a public URL. */
  audio_storage_path: string | null;
  audio_duration_seconds: number | null;
  body_markdown: string | null;
  lead_type_scope: TrainingLeadTypeScope;
  is_published: boolean;
  created_at: string;
  updated_at: string;
}

export interface TrainingProgress {
  id: string;
  customer_id: string;
  module_id: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type CaseStudyOutcome = "signed" | "lost";

export type CaseStudyLossReason =
  | "ghosted_pre_meeting"
  | "competitor"
  | "numbers_did_not_stack"
  | "timing";

/** How far the lead got before it ended. */
export type CaseStudyGate = "pre_meeting" | "meeting_or_after";

export type CaseStudyChannel =
  | "form"
  | "email"
  | "call"
  | "sms"
  | "web_meeting"
  | "offer"
  | "telemetry"
  | "onboarding";

export type CaseStudyDirection = "outbound" | "inbound" | "none";

export type CaseStudyConfidence = "crm_verified" | "partly_reconstructed";

/**
 * An anonymised lead journey. There is deliberately no name, date, address or
 * postcode field — see migration 0057 for why those are absent from the schema
 * rather than merely left blank.
 */
export interface CaseStudy {
  id: string;
  slug: string;
  reference: string;
  outcome: CaseStudyOutcome;
  loss_reason: CaseStudyLossReason | null;
  gate_reached: CaseStudyGate;
  days_to_outcome: number;
  property_summary: string;
  headline: string;
  summary: string;
  lesson_markdown: string | null;
  emails_out: number | null;
  calls_made: number | null;
  calls_answered: number | null;
  inbound_replies: number | null;
  meetings_sat: number | null;
  had_no_show: boolean;
  offer_applied: boolean;
  data_confidence: CaseStudyConfidence;
  sort_order: number;
  is_published: boolean;
  created_at: string;
  updated_at: string;
}

export interface CaseStudyEvent {
  id: string;
  case_study_id: string;
  /** Days from enquiry, 0-based. Never a date. */
  day_offset: number;
  channel: CaseStudyChannel;
  direction: CaseStudyDirection;
  description: string;
  is_setback: boolean;
  is_outcome: boolean;
  sort_order: number;
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
