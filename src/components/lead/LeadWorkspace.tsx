"use client";

/**
 * A lead's workspace (§56.7): three columns on a wide screen, one pane at a
 * time on a phone.
 *
 *   mode "lead"          Lead details · Thread · Activity      (/dashboard/leads/[id])
 *   mode "conversation"  Inbox · Thread · Contact details      (/dashboard/conversations/[leadId])
 *
 * Owns the workflow state so the contact panel and the thread column cannot
 * drift, and records `detail_opened` EXACTLY ONCE — the honest "this lead was
 * read" signal (§11), fired from here and nowhere else in the tree.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { LeadWorkspaceData } from "@/lib/leadWorkspace";
import { SignedCelebration } from "@/components/dashboard/SignedCelebration";
import { ThreadColumn } from "@/components/conversations/ThreadColumn";
import { ActivityColumn } from "./ActivityColumn";
import { ContactPanel } from "./ContactPanel";
import { useLeadWorkflow } from "./useLeadWorkflow";
import { cn } from "@/lib/utils";

export type Pane = "list" | "thread" | "right";

export function LeadWorkspace({
  data,
  userId,
  mode,
  openReport = false,
  list,
  initialPane,
}: {
  data: LeadWorkspaceData;
  userId: string;
  mode: "lead" | "conversation";
  openReport?: boolean;
  /** The inbox column, in conversation mode. */
  list?: React.ReactNode;
  initialPane?: Pane;
}) {
  const router = useRouter();
  const wf = useLeadWorkflow(data);
  const { assignment } = data;
  const lead = assignment.lead;

  // Mobile: which pane is showing. Desktop: whether the right column is open
  // on a width where it does not fit as a third column.
  const [pane, setPane] = useState<Pane>(initialPane ?? "thread");
  const [rightOpen, setRightOpen] = useState(false);
  useEffect(() => {
    setPane(initialPane ?? "thread");
  }, [assignment.id, initialPane]);

  const { recordEvent } = wf;
  useEffect(() => {
    recordEvent("detail_opened");
  }, [recordEvent]);

  // Keyboard prev/next — ignored while a text field is focused.
  useEffect(() => {
    if (mode !== "lead") return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      if (e.key === "ArrowLeft" && wf.prevHref) router.push(wf.prevHref);
      if (e.key === "ArrowRight" && wf.nextHref) router.push(wf.nextHref);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, wf.prevHref, wf.nextHref, router]);

  const thread = (
    <ThreadColumn
      assignmentId={assignment.id}
      leadId={lead.id}
      leadName={lead.lead_name}
      address={lead.address ?? null}
      bedrooms={lead.bedrooms ?? null}
      phone={lead.phone ?? null}
      items={data.threadItems}
      channels={data.messageChannels}
      unread={data.unread}
      starred={data.starred}
      hasThread={data.hasThread}
      nameHref={mode === "conversation" ? `/dashboard/leads/${lead.id}` : null}
      onBack={mode === "conversation" ? () => setPane("list") : undefined}
      onToggleRight={() => {
        setRightOpen((v) => !v);
        setPane((p) => (p === "right" ? "thread" : "right"));
      }}
      rightOpen={rightOpen || pane === "right"}
      onTelClick={() => wf.recordEvent("tel_click")}
    />
  );

  const contact = (
    <ContactPanel
      data={data}
      wf={wf}
      userId={userId}
      header={mode === "lead" ? "lead" : "contact"}
      openReport={openReport}
      onClose={
        mode === "conversation"
          ? () => {
              setRightOpen(false);
              setPane("thread");
            }
          : undefined
      }
    />
  );

  const rightCol = "w-full flex-shrink-0 lg:w-[clamp(260px,30%,340px)]";
  const listCol = "w-full flex-shrink-0 lg:w-[clamp(260px,32%,360px)]";

  return (
    <>
      {mode === "lead" ? (
        <>
          <div className={cn(listCol, "min-h-0", pane === "list" || pane === "right" ? "flex" : "hidden lg:flex", "flex-col")}>
            {contact}
          </div>
          <div className={cn("min-h-0 min-w-0 flex-1", pane === "thread" ? "flex" : "hidden lg:flex")}>{thread}</div>
          <div
            className={cn(
              rightCol,
              "min-h-0",
              pane === "right" ? "flex lg:hidden" : "hidden",
              rightOpen ? "lg:flex" : "xl:flex"
            )}
          >
            <ActivityColumn
              items={data.activity}
              onClose={() => {
                setRightOpen(false);
                setPane("thread");
              }}
            />
          </div>
        </>
      ) : (
        <>
          <div className={cn(listCol, "min-h-0", pane === "list" ? "flex" : "hidden lg:flex", "flex-col")}>{list}</div>
          <div className={cn("min-h-0 min-w-0 flex-1", pane === "thread" ? "flex" : "hidden lg:flex")}>{thread}</div>
          <div
            className={cn(
              rightCol,
              "min-h-0",
              pane === "right" ? "flex" : "hidden",
              rightOpen ? "lg:flex" : "xl:flex"
            )}
          >
            {contact}
          </div>
        </>
      )}

      <SignedCelebration
        open={wf.celebrateOpen}
        onClose={() => {
          wf.setCelebrateOpen(false);
          router.refresh();
        }}
        signedNumber={data.signedCountBefore + 1}
        assignmentId={assignment.id}
      />
    </>
  );
}
