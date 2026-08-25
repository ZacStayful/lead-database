import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Sits beside Export at the top of the dashboard and the leads page.
 *
 * Deliberately next to Export rather than only in the sidebar: a customer
 * thinking about their leads as a spreadsheet — the ones they could take out —
 * is looking at exactly that corner of the screen, and that is the moment it
 * occurs to them they have a list of their own they could bring in. Outline
 * variant so it reads as the quieter sibling of a control that already exists,
 * not as a competing primary action.
 */
export function AddLeadsButton() {
  return (
    <Button asChild variant="outline" size="sm">
      <Link href="/dashboard/leads/add">
        <Plus className="h-4 w-4" />
        Add your own leads
      </Link>
    </Button>
  );
}
