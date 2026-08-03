import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { TrainingProgressControls } from "@/components/dashboard/TrainingProgressControls";
import {
  formatDuration,
  isAllowedEmbedUrl,
  readMinutes,
} from "@/lib/training";
import { signedAudioUrl } from "@/lib/trainingAudio";
import type { TrainingModule, TrainingProgress } from "@/lib/types";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  video: "Video",
  audio: "Audio",
  article: "Read",
};

export default async function TrainingModulePage({
  params,
}: {
  params: { slug: string };
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();

  const { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!customer) redirect("/dashboard");

  // Published only. An unpublished slug 404s rather than rendering — a draft
  // must not be reachable by guessing its URL.
  const { data } = await admin
    .from("training_modules")
    .select("*")
    .eq("slug", params.slug)
    .eq("is_published", true)
    .maybeSingle();

  if (!data) notFound();
  const module = data as TrainingModule;

  const { data: siblings } = await admin
    .from("training_modules")
    .select("slug, title, sort_order")
    .eq("is_published", true)
    .order("sort_order", { ascending: true });

  const ordered = siblings ?? [];
  const position = ordered.findIndex((m) => m.slug === module.slug);
  const previous = position > 0 ? ordered[position - 1] : null;
  const next =
    position >= 0 && position < ordered.length - 1 ? ordered[position + 1] : null;

  const { data: progressRow } = await admin
    .from("training_progress")
    .select("*")
    .eq("customer_id", customer.id)
    .eq("module_id", module.id)
    .maybeSingle();

  const progress = progressRow as TrainingProgress | null;

  // Re-checked at render, never trusted from the row. The write route refuses
  // a bad host, but this is what guarantees no stored value can produce an
  // iframe — including one that predates the check or arrived another way.
  const embeddable =
    module.content_type === "video" && isAllowedEmbedUrl(module.video_url);

  const audioUrl =
    module.content_type === "audio"
      ? await signedAudioUrl(module.audio_storage_path)
      : null;

  const marker =
    module.content_type === "article"
      ? `Read · ${readMinutes(module.body_markdown)} min`
      : [
          TYPE_LABEL[module.content_type],
          formatDuration(
            module.content_type === "video"
              ? module.video_duration_seconds
              : module.audio_duration_seconds
          ),
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/dashboard/training"
          className="text-sm text-muted-foreground hover:underline"
        >
          Back to training
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{module.title}</h1>
        <p className="text-sm text-muted-foreground">{marker}</p>
      </div>

      {module.content_type === "video" && (
        <section className="overflow-hidden rounded-xl border border-black/10 bg-white">
          {embeddable ? (
            <div className="relative w-full" style={{ paddingTop: "56.25%" }}>
              <iframe
                src={module.video_url!}
                title={module.title}
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
                sandbox="allow-scripts allow-same-origin allow-presentation"
                className="absolute inset-0 h-full w-full"
              />
            </div>
          ) : (
            <p className="p-6 text-sm text-[#52514e]">
              This video cannot be displayed. Please let us know.
            </p>
          )}
        </section>
      )}

      {module.content_type === "audio" && (
        <section className="rounded-xl border border-black/10 bg-white p-6">
          {audioUrl ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <audio controls preload="none" src={audioUrl} className="w-full">
              Your browser cannot play this recording.
            </audio>
          ) : (
            <p className="text-sm text-[#52514e]">
              This recording cannot be played at the moment. Please let us know.
            </p>
          )}
        </section>
      )}

      {module.body_markdown && (
        <section className="rounded-xl border border-black/10 bg-white p-6">
          {/* Plain text, split on blank lines. No markdown renderer is
              installed, so nothing here can produce markup from stored
              content. */}
          <div className="space-y-4">
            {module.body_markdown
              .split(/\n\s*\n/)
              .map((paragraph) => paragraph.trim())
              .filter(Boolean)
              .map((paragraph, i) => (
                <p
                  key={i}
                  className="whitespace-pre-line text-sm leading-relaxed text-[#1a1a19]"
                >
                  {paragraph}
                </p>
              ))}
          </div>
        </section>
      )}

      <section className="rounded-xl border border-black/10 bg-white p-6">
        <TrainingProgressControls
          moduleId={module.id}
          completedAt={progress?.completed_at ?? null}
        />
      </section>

      <div className="flex flex-wrap justify-between gap-3 text-sm">
        {previous ? (
          <Link
            href={`/dashboard/training/${previous.slug}`}
            className="text-[#52514e] hover:underline"
          >
            ← {previous.title}
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link
            href={`/dashboard/training/${next.slug}`}
            className="text-[#52514e] hover:underline"
          >
            {next.title} →
          </Link>
        )}
      </div>
    </div>
  );
}
