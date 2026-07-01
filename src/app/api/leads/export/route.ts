import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AssignmentWithLead } from "@/lib/types";

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

  const rows = ((assignments ?? []) as AssignmentWithLead[]).map((a) => ({
    "Lead name": a.lead?.lead_name ?? "",
    Address: a.lead?.address ?? "",
    Email: a.lead?.email ?? "",
    Phone: a.lead?.phone ?? "",
    Bedrooms: a.lead?.bedrooms ?? "",
    "Estimated monthly income": a.lead?.estimated_monthly_income ?? "",
    "Lead profile": a.lead?.lead_profile ?? "",
    "Enquiry date": a.lead?.enquiry_date ?? "",
    "Received on": a.assigned_at
      ? new Date(a.assigned_at).toLocaleDateString("en-GB")
      : "",
    Status: a.viewed_at ? "Viewed" : "New",
    "Price paid": `£${Number(a.price_paid).toFixed(2)}`,
  }));

  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet["!cols"] = [
    { wch: 22 },
    { wch: 34 },
    { wch: 26 },
    { wch: 16 },
    { wch: 10 },
    { wch: 22 },
    { wch: 40 },
    { wch: 14 },
    { wch: 14 },
    { wch: 10 },
    { wch: 12 },
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
