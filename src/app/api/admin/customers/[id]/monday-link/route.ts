import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { enquiryBoardId, fetchEnquiryItem } from "@/lib/monday";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Point a customer at a specific Monday enquiries-board item by hand, or clear the
 * link. Admin only.
 *
 * The last resort behind the automatic resolution in mondayStatus.ts. That matches
 * on email, then mobile, then name, which covers everybody on live data except a
 * customer whose board item carries an old address AND an old name — and GR
 * customers whose only item is on the status-less GR enquiries board (they need an
 * item on 18420649520 before there is anything to link).
 *
 * Clearing monday_status_label is the point of the write, not a side effect. That
 * column is "the label we last wrote", and it short-circuits the sync; leaving a
 * stale value against a NEW item would suppress the first push to that item. Set
 * it to null and the customer's next lifecycle event writes the label properly.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!isAdminUser(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { monday_item_id?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const admin = createAdminClient();
  const raw = body.monday_item_id;

  // Empty or null unlinks, so a wrong link can be undone without inventing a
  // second endpoint.
  const itemId = typeof raw === "string" ? raw.trim() : null;
  if (!itemId) {
    const { error } = await admin
      .from("customers")
      .update({
        monday_item_id: null,
        monday_board_id: null,
        monday_link_state: "unlinked",
        monday_link_matched_by: null,
        monday_status_label: null,
        monday_status_synced_at: null,
        monday_status_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ status: "ok", linked: false });
  }

  if (!/^\d+$/.test(itemId)) {
    return NextResponse.json(
      { error: "A Monday item id is all digits — copy it from the item's URL." },
      { status: 400 }
    );
  }

  // Confirm the item exists before storing it. An admin typing an id from a URL
  // can transpose a digit, and a link to a non-existent item would look correct in
  // the table while every push failed.
  const found = await fetchEnquiryItem(itemId);
  if (!found.ok) {
    return NextResponse.json(
      { error: `Could not check that item against Monday: ${found.error}` },
      { status: 502 }
    );
  }
  if (!found.item) {
    return NextResponse.json(
      { error: `No Monday item with id ${itemId}.` },
      { status: 400 }
    );
  }

  // `items(ids:)` is not board-scoped — Monday resolves an id against the whole
  // account — so "the item exists" is not "the item is on the enquiries board".
  // Without this an id copied from any other board stores happily and then fails on
  // every push with not_status_board, which reads as a broken sync rather than a
  // mistyped id.
  if (found.item.boardId !== enquiryBoardId()) {
    return NextResponse.json(
      {
        error: `Item ${itemId} ("${found.item.name}") is on board ${found.item.boardId}, not the enquiries board ${enquiryBoardId()}. Only items on that board carry a Status column.`,
      },
      { status: 400 }
    );
  }

  // Refuse an item another customer already holds. The schema deliberately does
  // not enforce uniqueness — a constraint violation inside the Stripe webhook's
  // lazy resolution would be far worse than a recorded collision — so the check
  // belongs at the one entry point where a human is choosing.
  const { data: clash } = await admin
    .from("customers")
    .select("id, email")
    .eq("monday_item_id", itemId)
    .neq("id", params.id)
    .maybeSingle<{ id: string; email: string }>();

  if (clash) {
    return NextResponse.json(
      {
        error: `Item ${itemId} is already linked to ${clash.email}. Unlink them first.`,
      },
      { status: 409 }
    );
  }

  const { error } = await admin
    .from("customers")
    .update({
      monday_item_id: itemId,
      monday_board_id: enquiryBoardId(),
      monday_link_state: "linked",
      monday_link_matched_by: "manual",
      // See the header — this must be cleared, not carried over.
      monday_status_label: null,
      monday_status_synced_at: null,
      monday_status_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({
    status: "ok",
    linked: true,
    item: { id: found.item.id, name: found.item.name },
  });
}
