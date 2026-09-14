import { Mail, MessageCircle, Phone } from "lucide-react";
import { cn, initials } from "@/lib/utils";

/**
 * The design's five avatar palettes, picked by a stable hash of the name so
 * one landlord keeps one colour everywhere they appear.
 */
const PALETTES: { bg: string; fg: string }[] = [
  { bg: "#EAF3DE", fg: "#3B6D11" },
  { bg: "#e0ecf7", fg: "#1e4f8a" },
  { bg: "#fbe9d7", fg: "#8a4b12" },
  { bg: "#e9e6f5", fg: "#4c3d8f" },
  { bg: "#e2f0ea", fg: "#1f5c45" },
];

export function paletteFor(name: string | null | undefined): { bg: string; fg: string } {
  let h = 0;
  for (const ch of name ?? "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTES[h % PALETTES.length];
}

export type BadgeChannel = "whatsapp" | "email" | "call";

export const CHANNEL_COLOUR: Record<BadgeChannel, string> = {
  whatsapp: "#25a244",
  email: "#3B6D11",
  call: "#4b544c",
};

export function ChannelIcon({ channel, className }: { channel: BadgeChannel; className?: string }) {
  const Icon = channel === "whatsapp" ? MessageCircle : channel === "email" ? Mail : Phone;
  return <Icon className={className} style={{ color: CHANNEL_COLOUR[channel] }} />;
}

export function Avatar({
  name,
  size = 42,
  channel,
  className,
}: {
  name: string | null | undefined;
  size?: number;
  /** Small white badge with the channel's icon at bottom-right. */
  channel?: BadgeChannel | null;
  className?: string;
}) {
  const p = paletteFor(name);
  const badge = Math.round(size * 0.43);
  return (
    <span
      className={cn("relative inline-flex flex-shrink-0 items-center justify-center rounded-full font-bold", className)}
      style={{ width: size, height: size, background: p.bg, color: p.fg, fontSize: Math.max(10, Math.round(size * 0.31)) }}
      aria-hidden
    >
      {initials(name)}
      {channel && (
        <span
          className="absolute flex items-center justify-center rounded-full bg-white"
          style={{ width: badge, height: badge, right: -3, bottom: -3 }}
        >
          <ChannelIcon channel={channel} className="h-[60%] w-[60%]" />
        </span>
      )}
    </span>
  );
}
