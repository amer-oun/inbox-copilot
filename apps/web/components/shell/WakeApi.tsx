"use client";

import { useEffect } from "react";

/**
 * Starts waking the API as soon as the sign-in page loads.
 *
 * Renders nothing. A visitor usually spends several seconds reading the sign-in page
 * before clicking, and the API's free host needs about thirty to start — so beginning
 * now, rather than at the click, often hides most of the wait.
 */
export function WakeApi() {
  useEffect(() => {
    void fetch("/api/wake", { cache: "no-store" }).catch(() => undefined);
  }, []);
  return null;
}
