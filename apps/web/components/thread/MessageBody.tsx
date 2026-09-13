"use client";

import { useMemo, useState } from "react";
import { ImageOff, Maximize2, Minimize2 } from "lucide-react";
import { Button } from "../ui/button";
import { buildEmailFrameSrcDoc, EMAIL_FRAME_SANDBOX } from "../../lib/emailFrame";

/**
 * An email body, rendered as safely as this application knows how.
 *
 * Client-side because of the two decisions the reader makes here: whether to load
 * remote images, and how much vertical space to give the message. Neither can be
 * made on the server.
 *
 * The frame is deliberately not auto-sized. Measuring content height requires
 * script *inside* the frame, and `allow-scripts` is the one sandbox flag this
 * application will not grant to sender-authored HTML — so the frame scrolls, and
 * the reader can expand it. A worse layout is the right trade for not executing
 * a stranger's code.
 */

export interface MessageBodyProps {
  html: string | null;
  text: string | null;
  blockedRemoteImages: number;
}

export function MessageBody({ html, text, blockedRemoteImages }: MessageBodyProps) {
  const [loadRemoteImages, setLoadRemoteImages] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Rebuilt only when the reader changes something; parsing and serializing the
  // body on every render of a long thread would be wasteful.
  const srcDoc = useMemo(
    () => (html === null ? null : buildEmailFrameSrcDoc({ html, loadRemoteImages })),
    [html, loadRemoteImages],
  );

  if (srcDoc === null) {
    // Plain-text message: React escapes it, so there is nothing to sandbox.
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap break-words px-4 py-3 font-sans text-sm text-ink">
        {text ?? "(no content)"}
      </pre>
    );
  }

  return (
    <div>
      {blockedRemoteImages > 0 && !loadRemoteImages && (
        <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle bg-canvas px-4 py-2.5">
          <ImageOff aria-hidden="true" className="size-4 shrink-0 text-muted" />
          {/*
            One interpolation, not four: adjacent JSX text nodes are separated by
            comment markers in server-rendered HTML, which breaks copy-paste and
            makes a screen reader announce the sentence in pieces.
          */}
          <p className="min-w-0 flex-1 text-xs text-muted">
            {`${blockedRemoteImages} remote image${blockedRemoteImages === 1 ? "" : "s"} blocked. ` +
              "Loading them tells the sender you opened this message."}
          </p>
          <Button size="sm" variant="outline" onClick={() => setLoadRemoteImages(true)}>
            Load images
          </Button>
        </div>
      )}

      {loadRemoteImages && (
        <p className="border-b border-border-subtle bg-canvas px-4 py-2 text-xs text-muted">
          Remote images loaded for this message.
        </p>
      )}

      <iframe
        // Sandboxed, CSP'd, and fed only sanitized HTML — see lib/emailFrame.ts.
        sandbox={EMAIL_FRAME_SANDBOX}
        srcDoc={srcDoc}
        referrerPolicy="no-referrer"
        loading="lazy"
        title="Message content"
        className={expanded ? "h-[75vh] w-full border-0" : "h-80 w-full border-0"}
      />

      <div className="flex justify-end px-4 py-2">
        <Button size="sm" variant="ghost" onClick={() => setExpanded((value) => !value)}>
          {expanded ? (
            <>
              <Minimize2 aria-hidden="true" className="size-3.5" />
              Collapse
            </>
          ) : (
            <>
              <Maximize2 aria-hidden="true" className="size-3.5" />
              Expand
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
