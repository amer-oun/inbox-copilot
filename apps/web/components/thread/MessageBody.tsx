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
 *
 * ── The frame stays light in dark mode ──────────────────────────────────────────
 *
 * Senders build HTML for a white background — black text in an inline style, a
 * logo on a transparent PNG, a table with `bgcolor="#ffffff"` on half its cells.
 * Rendering that on a dark ground does not produce a dark email; it produces black
 * text on black, white boxes floating in the middle of a dark page, and a layout
 * whose broken parts look like *our* bug. So the frame keeps a white ground in both
 * themes (`.email-paper`), and the app around it is what changes. The seam between
 * the two is stated with a border rather than hidden, so the reader can see where
 * our interface stops and the sender's begins — which is also a security property.
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
    /*
     * Plain-text message: React escapes it, so there is nothing to sandbox — and
     * because it is text rather than markup, it is *our* typography and follows
     * the theme. `max-w-[74ch]` is the one place a measure applies to mail.
     */
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap break-words px-4 py-3.5 font-sans text-sm leading-relaxed text-ink">
        <span className="block max-w-[74ch]">{text ?? "(no content)"}</span>
      </pre>
    );
  }

  return (
    <div>
      {blockedRemoteImages > 0 && !loadRemoteImages && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-panel px-4 py-2.5">
          <ImageOff aria-hidden="true" className="size-4 shrink-0 text-muted" />
          {/*
            One interpolation, not four: adjacent JSX text nodes are separated by
            comment markers in server-rendered HTML, which breaks copy-paste and
            makes a screen reader announce the sentence in pieces.
          */}
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted">
            {`${blockedRemoteImages} remote image${blockedRemoteImages === 1 ? "" : "s"} blocked. ` +
              "Loading them tells the sender you opened this message."}
          </p>
          <Button size="sm" variant="outline" onClick={() => setLoadRemoteImages(true)}>
            Load images
          </Button>
        </div>
      )}

      {loadRemoteImages && (
        <p className="border-b border-line bg-panel px-4 py-2 text-xs text-muted">
          Remote images loaded for this message.
        </p>
      )}

      {/*
        The white ground is on the wrapper as well as inside the frame, so the
        rounded corner and the couple of pixels the iframe does not paint are
        white too rather than showing the dark app through the gap.
      */}
      <div className="email-paper">
        <iframe
          // Sandboxed, CSP'd, and fed only sanitized HTML — see lib/emailFrame.ts.
          sandbox={EMAIL_FRAME_SANDBOX}
          srcDoc={srcDoc}
          referrerPolicy="no-referrer"
          loading="lazy"
          title="Message content"
          className={expanded ? "h-[75vh] w-full border-0" : "h-80 w-full border-0"}
        />
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-1.5">
        <p className="text-[0.6875rem] text-muted">
          The sender&rsquo;s own HTML, shown on white and unable to run scripts.
        </p>
        <Button size="sm" variant="ghost" onClick={() => setExpanded((value) => !value)}>
          {expanded ? (
            <>
              <Minimize2 aria-hidden="true" />
              Collapse
            </>
          ) : (
            <>
              <Maximize2 aria-hidden="true" />
              Expand
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
