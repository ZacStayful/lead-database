import Image from "next/image";

// Intrinsic dimensions of public/logo.png (the dark green wordmark).
const LOGO_RATIO = 1500 / 867;

/**
 * Stayful dark-green wordmark. Height-driven so callers just pass the target
 * height (36px in nav, 48px on the landing hero); width is derived from the
 * intrinsic aspect ratio.
 */
export function Logo({
  height = 36,
  priority = false,
  className,
}: {
  height?: number;
  priority?: boolean;
  className?: string;
}) {
  return (
    <Image
      src="/logo.png"
      alt="Stayful"
      width={Math.round(height * LOGO_RATIO)}
      height={height}
      priority={priority}
      className={className}
    />
  );
}
