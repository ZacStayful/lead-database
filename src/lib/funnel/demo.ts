/**
 * The dashboard demo video on the "Why it works" screen (02 Phase 3), from
 * NEXT_PUBLIC_FUNNEL_DEMO_URL. Import-free and pure, so both the funnel and the
 * partner summary can use it and a test can pin it.
 *
 * Unset, or anything we would not want to embed, means NO BLOCK AT ALL (the
 * doc: "hide the block if unset"), never an empty player.
 *
 *   - Only https. An http or javascript: URL is refused, so a typo in an env
 *     var can never put a script in the page.
 *   - A direct .mp4 or .webm file plays in a <video>; anything else is
 *     treated as an embed page (YouTube, Vimeo, Loom) and goes in an iframe.
 */
export type DemoEmbed = { kind: "video" | "iframe"; src: string };

export function demoEmbed(raw: string | null | undefined): DemoEmbed | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const src = url.toString();
  return /\.(mp4|webm)$/i.test(url.pathname) ? { kind: "video", src } : { kind: "iframe", src };
}
