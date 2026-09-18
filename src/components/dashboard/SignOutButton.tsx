"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
import { VIEW_AS_ROUTE } from "@/lib/viewAs";

export function SignOutButton() {
  const router = useRouter();

  async function signOut() {
    // An admin's view-as cookie is HttpOnly and outlives the session, so a
    // customer logging in next on this browser would have every write refused
    // (§62). The route clears it for any caller; a failure costs nothing.
    await fetch(VIEW_AS_ROUTE, { method: "DELETE" }).catch(() => {});
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <Button variant="ghost" size="sm" onClick={signOut} title="Sign out">
      <LogOut className="h-4 w-4" />
    </Button>
  );
}
