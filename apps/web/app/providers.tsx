"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * TanStack Query's client, created per browser session.
 *
 * In `useState` rather than a module constant: a module-level client is shared
 * across requests on the server, which would mean one user's mail sitting in a
 * cache another user's render can read. This is the standard App Router shape for
 * exactly that reason.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            /*
             * Mail is server state that changes without us: the sync worker writes
             * new threads and the enrichment worker rewrites priority scores. Short
             * staleness plus refetch-on-focus is the honest default — but no
             * automatic polling, which would turn an idle tab into load.
             */
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: true,
            refetchOnMount: false,
            retry: 1,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
