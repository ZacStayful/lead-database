export type SubscriptionStatus =
  | "active"
  | "inactive"
  | "past_due"
  | "canceled"
  | "trialing";

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
  last_assignment_at: string | null;
  billing_cycle_anchor: string | null;
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
  assignment_count: number;
  max_assignments: number;
  created_at: string;
}

export interface LeadAssignment {
  id: string;
  lead_id: string;
  customer_id: string;
  price_paid: number;
  notification_sent: boolean;
  email_sent: boolean;
  viewed_at: string | null;
  status: string;
  assigned_at: string;
}

export interface AssignmentWithLead extends LeadAssignment {
  lead: Lead;
}

export interface LeadNote {
  id: string;
  lead_assignment_id: string;
  customer_id: string;
  body: string;
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

/** Exact shape n8n POSTs to /api/webhook/n8n. */
export interface N8nLeadPayload {
  monday_item_id: string;
  lead_name: string;
  address: string;
  phone: string;
  email: string;
  lead_profile: string;
  bedrooms: string;
  enquiry_date: string;
}
