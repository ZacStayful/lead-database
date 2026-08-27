"use client";

import { useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  BRAND_PRESETS,
  STAYFUL_ACCENT,
  derivePalette,
  type PresentationBrand,
} from "@/lib/presentationBrand";

/**
 * The operator's own logo and colour on every presentation (0112).
 *
 * Rendered for ANY subscriber, unlike the terms card beside it: the lead-seeded
 * presentation is management-only because a management fee is not what a GR
 * operator sells, but a GR operator opens the blank tool from Documents and
 * should not be presenting in our green either.
 *
 * ⚠️ THE PREVIEW IS THE FEATURE. An operator finds out that their dark wordmark
 * vanishes on the cover slide either here, on a Tuesday, or in front of a
 * landlord. So the logo is shown on both grounds it will actually appear on,
 * and the palette strip renders the real derived colours rather than swatches
 * of the one they picked.
 */
export function PresentationBrandCard({
  initial,
  initialLogoUrl,
}: {
  initial: PresentationBrand;
  initialLogoUrl: string | null;
}) {
  const [accent, setAccent] = useState(initial.accent);
  const [logoUrl, setLogoUrl] = useState<string | null>(initialLogoUrl);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const palette = derivePalette(accent);
  const dirty = accent !== initial.accent || pendingFile != null || removeLogo;

  function pick(file: File | null) {
    setError(null);
    setSaved(false);
    setPendingFile(file);
    setRemoveLogo(false);
    if (file) {
      // A local preview, so the ground check happens before the upload rather
      // than after it.
      const reader = new FileReader();
      reader.onload = () => setLogoUrl(String(reader.result));
      reader.readAsDataURL(file);
    }
  }

  function clearLogo() {
    setError(null);
    setSaved(false);
    setPendingFile(null);
    setLogoUrl(null);
    setRemoveLogo(true);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("accent", accent);
      if (pendingFile) form.set("logo", pendingFile);
      if (removeLogo) form.set("remove_logo", "1");

      const res = await fetch("/api/customer/settings/presentation/brand", {
        method: "PUT",
        body: form,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Could not save");

      setAccent(body.brand.accent);
      setLogoUrl(body.logoUrl ?? null);
      setPendingFile(null);
      setRemoveLogo(false);
      if (fileRef.current) fileRef.current.value = "";
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  const swatch =
    "h-9 w-9 rounded-full border-2 transition-transform hover:scale-105";

  return (
    <Card id="branding">
      <CardContent className="space-y-6 pt-6">
        <div>
          <h2 className="text-lg font-semibold">Your branding</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Your logo and colour, on every presentation you open — the one built
            from a lead&rsquo;s analysis and the blank one in Documents alike.
            Landlords see your business, not ours.
          </p>
        </div>

        {/* ── Logo ─────────────────────────────────────────── */}
        <div className="space-y-3">
          <div className="text-sm font-medium">Logo</div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
            className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm"
          />
          <p className="text-xs text-muted-foreground">
            PNG, JPEG, WebP or SVG. A transparent PNG or an SVG sits best on the
            dark cover slide.
          </p>

          {logoUrl && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-md border bg-white p-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={logoUrl} alt="Your logo" className="mx-auto max-h-12" />
                  <div className="mt-2 text-center text-xs text-muted-foreground">
                    On white slides
                  </div>
                </div>
                <div
                  className="rounded-md border p-4"
                  style={{ background: palette.ink }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={logoUrl} alt="Your logo" className="mx-auto max-h-12" />
                  <div
                    className="mt-2 text-center text-xs"
                    style={{ color: palette.accentSoft }}
                  >
                    On the cover slide
                  </div>
                </div>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={clearLogo}>
                Remove logo
              </Button>
            </div>
          )}
        </div>

        {/* ── Colour ───────────────────────────────────────── */}
        <div className="space-y-3">
          <div className="text-sm font-medium">Colour</div>
          <div className="flex flex-wrap items-center gap-2">
            {BRAND_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                title={preset.name}
                aria-label={preset.name}
                onClick={() => {
                  setAccent(preset.accent);
                  setSaved(false);
                }}
                className={swatch}
                style={{
                  background: preset.accent,
                  borderColor:
                    accent.toLowerCase() === preset.accent ? "#1a1a19" : "transparent",
                }}
              />
            ))}
            <label className="ml-1 flex items-center gap-2 text-sm">
              <input
                type="color"
                value={accent}
                onChange={(e) => {
                  setAccent(e.target.value.toLowerCase());
                  setSaved(false);
                }}
                className="h-9 w-12 cursor-pointer rounded border border-input bg-background p-1"
              />
              <span className="text-muted-foreground">or your own</span>
            </label>
          </div>

          {/* The derived palette, as the presentation will actually render it. */}
          <div className="overflow-hidden rounded-md border">
            <div className="flex items-center gap-3 p-3" style={{ background: palette.tint }}>
              <span
                className="rounded-md px-3 py-1.5 text-sm font-semibold text-white"
                style={{ background: palette.accent }}
              >
                Present
              </span>
              <span className="text-sm font-semibold" style={{ color: palette.accent }}>
                Income analysis
              </span>
            </div>
            <div className="p-3" style={{ background: palette.ink }}>
              <div
                className="text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: palette.accentSoft }}
              >
                Managed short-let income
              </div>
              <div className="text-lg font-bold" style={{ color: palette.accentBright }}>
                £2,340 <span style={{ color: palette.inkText }}>a month</span>
              </div>
            </div>
          </div>

          {palette.adjusted && (
            <p className="text-xs text-muted-foreground">
              Darkened slightly where it carries text, so white lettering stays
              readable on it. Your logo is untouched.
            </p>
          )}
          {accent.toLowerCase() !== STAYFUL_ACCENT && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline"
              onClick={() => {
                setAccent(STAYFUL_ACCENT);
                setSaved(false);
              }}
            >
              Back to the original green
            </button>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save branding"}
          </Button>
          {saved && !dirty && (
            <span className="text-sm text-muted-foreground">Saved.</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
