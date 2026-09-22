"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCw } from "lucide-react";
import { Button } from "../ui/button";

/**
 * What a page shows instead of an error while the API is waking up.
 *
 * The API's free host sleeps when idle and takes about half a minute to start, and the
 * first visitor after a quiet spell always meets it. Without this, they meet it as a
 * server error — which reads as "this project is broken" to exactly the person the
 * demo is for. So the page says what is happening and how long it takes, polls
 * `/api/wake`, and reloads itself the moment the API answers.
 *
 * The shell around it is already rendered (it needs no API call), so the visitor sees
 * the app they are about to use rather than a blank page.
 */

const POLL_MS = 3_000;
/** Past this, "about 30 seconds" is no longer true and the page should say so. */
const SLOW_AFTER_S = 75;

export function StartingUp() {
  const router = useRouter();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    let cancelled = false;

    const tick = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - started) / 1000));
    }, 1000);

    async function poll(): Promise<void> {
      while (!cancelled) {
        try {
          const response = await fetch("/api/wake", { cache: "no-store" });
          const body = (await response.json()) as { up?: unknown };
          if (body.up === true) {
            if (!cancelled) router.refresh();
            return;
          }
        } catch {
          // The web app itself is reachable (this page loaded), so keep polling.
        }
        await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
      }
    }
    void poll();

    return () => {
      cancelled = true;
      window.clearInterval(tick);
    };
  }, [router]);

  const slow = elapsed >= SLOW_AFTER_S;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-6 py-20 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-accent-soft text-accent">
        <Loader2
          aria-hidden="true"
          className="size-5 animate-spin motion-reduce:animate-none"
        />
      </span>
      <h1 className="mt-5 text-lg font-semibold tracking-tight text-ink">Starting up</h1>
      <p role="status" className="mt-2 text-sm leading-relaxed text-muted">
        {slow
          ? "This is taking longer than usual. The page will still load by itself when the server answers, or you can try again."
          : "Starting up, this takes about 30 seconds on the free server. The page will load by itself."}
      </p>
      <p className="mt-4 text-xs tabular-nums text-faint" aria-hidden="true">
        {`${elapsed}s`}
      </p>
      {slow ? (
        <Button
          className="mt-5"
          variant="outline"
          size="sm"
          onClick={() => router.refresh()}
        >
          <RotateCw aria-hidden="true" />
          Try again
        </Button>
      ) : null}
    </div>
  );
}
