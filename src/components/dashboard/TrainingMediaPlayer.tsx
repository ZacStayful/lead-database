"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Player for an uploaded training recording.
 *
 * Native <audio>/<video> on a signed Storage URL, rather than a player library
 * or a streaming route of our own: signed URLs serve HTTP Range requests, so
 * the browser streams and seeks a 40-minute meeting without downloading it
 * first, and gets AirPlay, PiP, playback speed and captions for free.
 *
 * `preload="metadata"` matters on the video branch. The browser default would
 * begin buffering on render, and on a long meeting that is a lot of egress for
 * a page the customer may only be scrolling past. Metadata alone is a few
 * kilobytes and still gives the scrub bar its duration.
 *
 * This is a client component only because of the expiry recovery below; the
 * URL itself is minted on the server during the page render.
 */
export function TrainingMediaPlayer({
  moduleId,
  isVideo,
  initialUrl,
}: {
  moduleId: string;
  isVideo: boolean;
  initialUrl: string;
}) {
  const [src, setSrc] = useState(initialUrl);
  const [error, setError] = useState<string | null>(null);
  // One refresh per element. A URL that fails twice is a real fault rather
  // than an expiry, and looping would hammer the route against a dead object.
  const refreshed = useRef(false);

  /**
   * Playback URLs are minted when the page renders and expire after a few
   * hours. A tab left open past that would otherwise fail on play with nothing
   * to explain it, so the first media error asks for a fresh URL and retries.
   */
  const handleError = useCallback(async () => {
    if (refreshed.current) {
      setError("This recording could not be played. Try reloading the page.");
      return;
    }
    refreshed.current = true;
    try {
      const res = await fetch(`/api/customer/training/${moduleId}/play-url`);
      const data = await res.json();
      if (res.ok && data.url) {
        setSrc(data.url as string);
        setError(null);
        return;
      }
    } catch {
      /* fall through to the message below */
    }
    setError("This recording could not be played. Try reloading the page.");
  }, [moduleId]);

  return (
    <>
      {isVideo ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          key={src}
          controls
          preload="metadata"
          src={src}
          onError={handleError}
          className="w-full rounded-lg bg-black"
        >
          Your browser cannot play this recording.
        </video>
      ) : (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio
          key={src}
          controls
          preload="metadata"
          src={src}
          onError={handleError}
          className="w-full"
        >
          Your browser cannot play this recording.
        </audio>
      )}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </>
  );
}
