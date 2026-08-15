import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import {
  OperatorProof,
  type ProofRow,
  type AnonymisedWin,
} from "@/components/dashboard/OperatorProof";

export const dynamic = "force-dynamic";

/**
 * Insights → Leaderboard.
 *
 * A note on the name, because the page deliberately does not do what it says:
 * there is no ranking here and no position. With around twenty active
 * operators a ranked table means most of them open this page to find out they
 * are in the bottom half, and the people most likely to drift away are exactly
 * the ones a ranking punishes. So the page reports what the operators who have
 * signed a landlord DID, against everyone else, with the reader's own figures
 * beside them — the social proof a leaderboard is usually reached for, without
 * the demotivation.
 *
 * Every figure is a group average. Nobody is named and nobody is placed.
 */
export default async function LeaderboardPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  // Both functions derive identity from auth.uid() and return aggregates only,
  // so they are called on the customer's own session rather than the service
  // role — same boundary as the benchmarks on the analytics page.
  const userClient = createClient();
  const [{ data: proofRaw }, { data: winsRaw }] = await Promise.all([
    userClient.rpc("get_operator_proof"),
    userClient.rpc("get_recent_wins_anonymised", { p_limit: 10 }),
  ]);
  const rows = (proofRaw ?? []) as ProofRow[];
  const wins = (winsRaw ?? []) as AnonymisedWin[];

  // OperatorProof renders nothing below three signed operators, which is right
  // for a block sitting among others on the dashboard and wrong for a page the
  // customer navigated to on purpose. Say why it is empty instead of showing
  // them a heading and white space.
  const winners = rows.find((r) => r.group_key === "winners");
  const hasContent = Boolean(winners && !winners.suppressed);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Leaderboard</h1>
        <p className="text-sm text-muted-foreground">
          Some subscribers here have already signed landlords onto management
          contracts from the leads they were sent. This page tracks what those
          operators do differently from everyone else — so you can copy it.
        </p>
      </div>

      {hasContent ? (
        <OperatorProof rows={rows} wins={wins} />
      ) : (
        <Card>
          <CardContent className="pt-6">
            <h2 className="mb-1 text-lg font-semibold">
              Not enough signed management clients to show this yet
            </h2>
            <p className="text-sm text-muted-foreground">
              This page compares the operators who have signed a landlord onto a
              management contract against everyone else, so you can see which
              habits are behind it. Until at least three subscribers have
              recorded a signing there is no group to describe — only
              individuals, and reporting on those would tell you more about
              specific businesses than about what works. It fills in on its own
              as more outcomes are recorded.
            </p>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        Figures cover management leads only, and every one is an average across
        a group of subscribers. Nobody is named, nobody is ranked, and no one
        else can see your figures.
      </p>
    </div>
  );
}
