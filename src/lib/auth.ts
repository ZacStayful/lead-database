import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { User } from "@supabase/supabase-js";
import type { Customer } from "@/lib/types";

export function isAdminUser(user: User | null): boolean {
  if (!user) return false;
  // Only app_metadata is trustworthy: users can edit their own user_metadata
  // from the browser via supabase.auth.updateUser, so it must never grant admin.
  return (user.app_metadata?.role as string | undefined) === "admin";
}

/** Current authenticated user, or null. */
export async function getUser(): Promise<User | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/**
 * Current authenticated user's customer row. Uses the service role so the
 * customer record is always resolvable even before subscription is active.
 */
export async function getCurrentCustomer(): Promise<{
  user: User | null;
  customer: Customer | null;
}> {
  const user = await getUser();
  if (!user) return { user: null, customer: null };

  const admin = createAdminClient();
  const { data } = await admin
    .from("customers")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  return { user, customer: (data as Customer | null) ?? null };
}
