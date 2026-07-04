import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatDateTime } from "@/lib/utils";
import type { AssignmentWithLead, LeadNote } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: customer } = await admin
    .from("customers")
    .select("id, business_name")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!customer) {
    return NextResponse.json({ error: "No customer record" }, { status: 404 });
  }

  const { data: assignments } = await admin
    .from("lead_assignments")
    .select("*, lead:leads(*)")
    .eq("customer_id", customer.id)
    .order("assigned_at", { ascending: false });

  // Pull every note for this customer and group by assignment so each exported
  // lead carries its full, timestamped contact history in one cell.
  const { data: notesData } = await admin
    .from("lead_notes")
    .select("id, lead_assignment_id, customer_id, body, created_at")
    .eq("customer_id", customer.id)
    .order("created_at", { ascending: true });

  const notesByAssignment = new Map<string, LeadNote[]>();
  for (const note of (notesData ?? []) as LeadNote[]) {
    const list = notesByAssignment.get(note.lead_assignment_id) ?? [];
    list.push(note);
    notesByAssignment.set(note.lead_assignment_id, list);
  }

  const rows = ((assignments ?? []) as AssignmentWithLead[]).map((a) => ({
    "Lead name": a.lead?.lead_name ?? "",
    Address: a.lead?.address ?? "",
    Email: a.lead?.email ?? "",
    Phone: a.lead?.phone ?? "",
    Bedrooms: a.lead?.bedrooms ?? "",
    "Lead profile": a.lead?.lead_profile ?? "",
    "Enquiry date": a.lead?.enquiry_date ?? "",
    "Received on": a.assigned_at
      ? new Date(a.assigned_at).toLocaleDateString("en-GB")
      : "",
    Status: a.status ?? (a.viewed_at ? "Viewed" : "New"),
    Notes: (notesByAssignment.get(a.id) ?? [])
      .map((n) => `[${formatDateTime(n.created_at)}] ${n.body}`)
      .join("\n"),
    "Price paid": `£${Number(a.price_paid).toFixed(2)}`,
  }));

  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet["!cols"] = [
    { wch: 22 }, // Lead name
    { wch: 34 }, // Address
    { wch: 26 }, // Email
    { wch: 16 }, // Phone
    { wch: 10 }, // Bedrooms
    { wch: 40 }, // Lead profile
    { wch: 14 }, // Enquiry date
    { wch: 14 }, // Received on
    { wch: 14 }, // Status
    { wch: 50 }, // Notes
    { wch: 12 }, // Price paid
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Leads");

  const buffer = XLSX.write(workbook, {
    type: "array",
    bookType: "xlsx",
  }) as ArrayBuffer;

  const filename = `stayful-leads-${new Date().toISOString().slice(0, 10)}.xlsx`;

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
