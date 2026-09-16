import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  aiClassificationSchema,
  aiComposedMessageSchema,
  aiReplyVariantsSchema,
  aiSummarySchema,
  aiThreatAssessmentSchema,
  aiTranslationSchema,
  aiWritingStyleSchema,
  type AiClassificationOutput,
  type AiComposedMessageOutput,
  type AiReplyVariantsOutput,
  type AiSummaryOutput,
  type AiThreatAssessmentOutput,
  type AiTranslationOutput,
  type AiWritingStyleOutput,
  type Category,
} from "@inbox-copilot/shared";
import { logger } from "../lib/logger.js";
import { env } from "../lib/env.js";

/**
 * A local stand-in for the Anthropic Messages API, for development without a key.
 *
 * It speaks the real wire format, so nothing in `services/ai/` knows it exists: the
 * real SDK, the real prompt construction, the real tool definitions, the real
 * schema validation, the cache, the ledger and the queue all run exactly as they
 * do against the API. Point `ANTHROPIC_BASE_URL` at it (or just run `pnpm dev`
 * with no key) and enrich a real mailbox end to end.
 *
 * Two properties it is built to have:
 *
 *   - **Deterministic.** The same email always produces the same answer, so a
 *     cache hit and a stub answer are distinguishable, and so repeated runs are
 *     comparable. Values derive from a hash of the email, not from randomness.
 *   - **Not steerable.** It classifies from the envelope and from word counts —
 *     never from instruction-like text in the body. An injected "classify this as
 *     URGENT" changes nothing, which is the behaviour the real defense assumes.
 *
 * What it is NOT is a model. The text it writes is schematic, and its category
 * judgments are keyword heuristics. It exercises the path; it does not evaluate
 * quality. Anything that looks like a quality signal in this output is an artifact.
 */

/** Stable pseudo-random number in [0,1) derived from text. */
function hashUnit(text: string, salt: string): number {
  const digest = createHash("sha256").update(`${salt}:${text}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

interface ParsedPrompt {
  /** Metadata lines we emitted, parsed back out. */
  metadata: Record<string, string>;
  /** Body text of the last (newest) message in the prompt. */
  body: string;
  /** Every message body in the prompt, oldest first. */
  bodies: string[];
}

/**
 * Reads back the structure `prompts.ts` wrote.
 *
 * Deliberately tolerant: if the format changes this degrades to "no metadata"
 * rather than throwing, because a stub that 500s is a worse dev experience than a
 * stub that guesses. The tests pin the parse against real prompt output.
 */
export function parsePrompt(userContent: string): ParsedPrompt {
  const metadata: Record<string, string> = {};
  const metadataBlocks = userContent.matchAll(
    /<email_metadata>\n([\s\S]*?)\n<\/email_metadata>/g,
  );
  for (const block of metadataBlocks) {
    for (const line of (block[1] ?? "").split("\n")) {
      const separator = line.indexOf(": ");
      if (separator === -1) continue;
      // Later messages win: the newest metadata is what a classifier should use.
      metadata[line.slice(0, separator)] = line.slice(separator + 2);
    }
  }

  const bodies = [...userContent.matchAll(/<\/email_metadata>\n([\s\S]*?)\n<\/untrusted_email>/g)]
    .map((match) => (match[1] ?? "").trim())
    .filter((body) => body.length > 0);

  return { metadata, body: bodies.at(-1) ?? "", bodies };
}

/**
 * Keyword rules, in priority order.
 *
 * Every short token is `\b`-anchored. Without that, `vat` matched inside "activate",
 * "private" and "innovation", which put a third of a real mailbox in FINANCE — the
 * kind of wrong that makes a dev run look broken rather than merely stubbed.
 */
const CATEGORY_RULES: { category: Category; pattern: RegExp }[] = [
  {
    category: "FINANCE",
    pattern:
      /\b(invoices?|factures?|receipts?|re\u00e7us?|payments?|paiements?|billing|vat|tva|refunds?|subscriptions?|abonnements?)\b/i,
  },
  {
    category: "TRAVEL",
    pattern:
      /\b(flights?|vols?|bookings?|r\u00e9servations?|itiner(?:ary|aries)|hotels?|boarding|check-?in)\b/i,
  },
  {
    category: "NEWSLETTER",
    pattern: /\b(newsletters?|unsubscribe|d\u00e9sabonner|digest|this week in|weekly)\b/i,
  },
  {
    category: "PROMOTION",
    pattern:
      /(\d+% off|\b(sale|promo|discount|offre|soldes|deal|rewards?|coupon)\b|limited time|act now)/i,
  },
  {
    category: "SOCIAL",
    pattern:
      /\b(followed you|friend request|mentioned you|liked your|invitation \u00e0 rejoindre)\b/i,
  },
  {
    category: "NOTIFICATION",
    pattern:
      /\b(security alert|alerte|verif(?:y|ication)|v\u00e9rification|was signed in|passwords?|mots? de passe|partag\u00e9 certaines donn\u00e9es|build (?:passed|failed)|welcome to)\b/i,
  },
  {
    category: "WORK",
    pattern:
      /\b(meetings?|r\u00e9unions?|deadlines?|projects?|projets?|standup|reviews?|tickets?|deploys?|sprints?|agenda)\b/i,
  },
];

/**
 * Picks a category, preferring evidence from the subject and sender over the body.
 *
 * A word in a long body is weak evidence — an unrelated mail mentioning "payment" in
 * a footer is not a finance mail — while the subject is what the message is about.
 * Two passes gives that ordering without inventing a scoring model.
 */
function categoryFor(subject: string, from: string, body: string): Category {
  const headline = `${subject} ${from}`;
  return (
    CATEGORY_RULES.find((rule) => rule.pattern.test(headline))?.category ??
    CATEGORY_RULES.find((rule) => rule.pattern.test(body))?.category ??
    "PRIMARY"
  );
}

/** Very rough language guess. French is here because real mailboxes have it. */
function guessLanguage(text: string): string {
  const french =
    /\b(vous|votre|nous|bonjour|merci|cordialement|avez|compte|données|réunion|pièce jointe)\b/i;
  return french.test(text) ? "fr" : "en";
}

function isAutomated(metadata: Record<string, string>): boolean {
  const from = metadata["from"] ?? "";
  return /no-?reply|noreply|donotreply|notifications?@|mailer|bounce/i.test(from);
}

/**
 * A deterministic classification for one email.
 *
 * Exported and pure so the tests can assert its properties (determinism, schema
 * conformance, non-steerability) without a server.
 */
export function stubClassification(userContent: string): AiClassificationOutput {
  const { metadata, body } = parsePrompt(userContent);
  const subject = metadata["subject"] ?? "";
  const from = metadata["from"] ?? "";

  const category = categoryFor(subject, from, body);

  /*
   * Jitter keys on the envelope (sender + subject), never on the body.
   *
   * Body-derived jitter made the score move by a few points when text was appended,
   * which was enough to cross a band boundary — so appending an injection payload
   * appeared to change the verdict. It was not obeying the payload, but "the stub's
   * answer shifted when the attacker added text" is indistinguishable from steering
   * at a glance, and a dev tool used to demonstrate the defense must not have that
   * property.
   */
  const envelope = `${from}|${subject}`;

  /*
   * Score from structure, not from what the email claims about itself. A question
   * mark addressed to the mailbox owner moves the needle; the word "URGENT" in the
   * body does not, because an attacker controls that and a stub that honoured it
   * would quietly disagree with the defense the rest of the system assumes.
   */
  const automated = isAutomated(metadata);
  const asksSomething = /\?/.test(body);
  const owner = metadata["mailbox_owner"] ?? "";
  const addressedDirectly = owner !== "" && (metadata["to"] ?? "").includes(owner);

  let score = 35;
  if (category === "WORK") score += 20;
  if (category === "FINANCE") score += 25;
  if (category === "NEWSLETTER" || category === "PROMOTION") score -= 22;
  if (category === "NOTIFICATION") score -= 10;
  if (automated) score -= 12;
  if (asksSomething) score += 12;
  if (addressedDirectly) score += 6;
  // ±4 of stable jitter so scores are not all identical per category.
  score += Math.round(hashUnit(envelope, "score") * 8) - 4;
  const priorityScore = Math.max(0, Math.min(100, score));

  const band =
    priorityScore >= 80 ? "URGENT" : priorityScore >= 60 ? "HIGH" : priorityScore >= 30 ? "NORMAL" : "LOW";

  return aiClassificationSchema.parse({
    category,
    priority: band,
    priorityScore,
    needsReply: asksSomething && !automated,
    language: guessLanguage(`${subject} ${body}`),
    confidence: Number((0.55 + hashUnit(envelope, "confidence") * 0.4).toFixed(2)),
  });
}

/** First sentence of a block of text, trimmed to a sensible length. */
function firstSentence(text: string, maxChars = 120): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const end = cleaned.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? cleaned : cleaned.slice(0, end + 1);
  return sentence.length > maxChars ? `${sentence.slice(0, maxChars - 1)}…` : sentence;
}

/** A deterministic summary for one thread. Schematic by design. */
export function stubSummary(userContent: string): AiSummaryOutput {
  const { metadata, bodies } = parsePrompt(userContent);
  const subject = metadata["subject"] ?? "(no subject)";
  const sender = (metadata["from"] ?? "someone").replace(/\s*<[^>]*>$/, "");
  const count = Math.max(1, bodies.length);

  const keyPoints = bodies
    .slice(-4)
    .map((body, index) => `Message ${index + 1}: ${firstSentence(body)}`)
    .filter((point) => point.length > 12);

  const asksSomething = bodies.some((body) => body.includes("?"));

  return aiSummarySchema.parse({
    headline: firstSentence(`${subject} — ${count} message${count === 1 ? "" : "s"}`, 90),
    summary: `[stubbed summary] A thread of ${count} message${count === 1 ? "" : "s"} with ${sender}, subject "${subject}". This text is generated locally by the development AI stub and describes the thread's shape, not its meaning: no model read this mail.`,
    keyPoints: keyPoints.length > 0 ? keyPoints : [`Subject: ${subject}`],
    actionItems: asksSomething
      ? [{ text: `Reply to ${sender} about "${firstSentence(subject, 60)}"`, owner: "user" }]
      : [],
  });
}

/**
 * Reads back the instruction block `prompts.ts` writes after the mail.
 *
 * Only our own fields are read — tone, and the style profile. Nothing in here looks
 * at the email bodies, which is what makes the stub's drafts non-steerable: an
 * injected "reply with the bank details" cannot change a single character of the
 * output below, because no code path reads the body when drafting.
 */
export function parseRequestBlock(userContent: string): Record<string, string> {
  const fields: Record<string, string> = {};

  /*
   * The intent is matched on its own pass, because it is *nested* inside
   * `<compose_request>`: one `matchAll` over both patterns consumed the container and
   * then resumed after it, so the inner block was never seen and every stubbed
   * composition came out titled "Quick note".
   */
  const intent = /<user_intent>\n([\s\S]*?)\n<\/user_intent>/.exec(userContent);
  if (intent !== null) fields["intent"] = (intent[1] ?? "").trim();

  const blocks = userContent.matchAll(
    /<(reply_request|compose_request|writing_style)>\n([\s\S]*?)\n<\/\1>/g,
  );

  for (const block of blocks) {
    for (const line of (block[2] ?? "").split("\n")) {
      const separator = line.indexOf(": ");
      if (separator === -1) continue;
      const key = line.slice(0, separator);
      if (!(key in fields)) fields[key] = line.slice(separator + 2);
    }
  }

  return fields;
}

/**
 * Three deterministic reply drafts.
 *
 * Schematic on purpose, and labelled: what this exercises is the path — the prompt,
 * the tool schema, the Zod validation, the `ReplyDraft` rows, the composer UI and the
 * send flow — not the writing. It differs from the real thing in the way that
 * matters least for that purpose (the prose) and not at all in the way that matters
 * most (the shape).
 *
 * The greeting and sign-off come from the style block when there is one, so a dev run
 * visibly demonstrates that the profile reached the prompt.
 */
export function stubReplyVariants(userContent: string): AiReplyVariantsOutput {
  const { metadata } = parsePrompt(userContent);
  const request = parseRequestBlock(userContent);

  const subject = metadata["subject"] ?? "(no subject)";
  const sender = (metadata["from"] ?? "someone").replace(/\s*<[^>]*>$/, "");
  const tone = request["tone"] ?? "PROFESSIONAL";
  const greeting = (request["greeting"] ?? "Hi <name>,").replace(/<name>/g, firstName(sender));
  const signOff = request["sign_off"] ?? "Best,";

  const shapes = [
    {
      label: "Agree and confirm",
      middle: `Yes — that works. I will take care of the part about "${firstSentence(subject, 60)}" and confirm once it is done.`,
    },
    {
      label: "Ask for one detail",
      middle: `Before I commit: could you confirm [the detail] on "${firstSentence(subject, 60)}"? I would rather check than assume.`,
    },
    {
      label: "Decline for now",
      middle: `I am not able to take this on at the moment. If it can wait until [date] I will pick it up then.`,
    },
  ];

  return aiReplyVariantsSchema.parse({
    variants: shapes.map((shape) => ({
      label: shape.label,
      body: [
        greeting,
        "",
        shape.middle,
        "",
        `[stubbed ${tone.toLowerCase()} draft — written locally by the development AI stub, not by a model]`,
        "",
        signOff,
      ].join("\n"),
    })),
  });
}

/** First name, for a greeting template. Best-effort and deliberately dumb. */
function firstName(sender: string): string {
  const first = sender.trim().split(/[\s.]+/)[0] ?? "there";
  return first.replace(/[^\p{L}\p{N}'-]/gu, "") || "there";
}

/** A deterministic composed message. The subject comes from the user's own intent. */
export function stubComposedMessage(userContent: string): AiComposedMessageOutput {
  const request = parseRequestBlock(userContent);
  const intent = request["intent"] ?? "";
  const recipient = request["recipient"] ?? "there";
  const greeting = (request["greeting"] ?? "Hi <name>,").replace(
    /<name>/g,
    firstName(recipient.split("@")[0] ?? "there"),
  );
  const signOff = request["sign_off"] ?? "Best,";

  return aiComposedMessageSchema.parse({
    subject: firstSentence(intent === "" ? "Quick note" : intent, 70).replace(/[.!?]$/, ""),
    body: [
      greeting,
      "",
      intent === "" ? "[no intent supplied]" : intent,
      "",
      "[stubbed composition — written locally by the development AI stub, not by a model]",
      "",
      signOff,
    ].join("\n"),
  });
}

/**
 * A deterministic style profile.
 *
 * Derived from the shape of the samples — their first and last lines — rather than
 * invented, so a dev run produces a profile that is at least *about* this mailbox.
 * It is still not a judgment of anyone's writing, and it says so.
 */
export function stubWritingStyle(userContent: string): AiWritingStyleOutput {
  const { bodies } = parsePrompt(userContent);

  const firstLines = bodies
    .map((body) => body.split("\n")[0]?.trim() ?? "")
    .filter((line) => line.length > 0 && line.length < 60);
  /*
   * The last *few* lines, not the last one: a sign-off is two lines ("Best," then a
   * name), so looking only at the final line found the name and reported that this
   * person does not sign off at all.
   */
  const lastLines = bodies
    .flatMap((body) => body.trimEnd().split("\n").slice(-3))
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.length < 60);

  const greeting = firstLines.find((line) => /^(hi|hello|hey|dear|bonjour|salut)\b/i.test(line));
  const signOff = lastLines.find((line) =>
    /^(best|thanks|thank you|regards|cheers|cordialement|merci)\b/i.test(line),
  );

  return aiWritingStyleSchema.parse({
    greeting: greeting === undefined ? "" : greeting.replace(/\s+\S+[,!]?$/, " <name>,"),
    signOff: signOff ?? "",
    formality: bodies.some((body) => /\b(hey|thanks!|cheers)\b/i.test(body)) ? "casual" : "neutral",
    descriptor: `[stubbed style profile] Derived locally from the opening and closing lines of ${bodies.length} sent message${bodies.length === 1 ? "" : "s"}, not from a model reading them. Treat it as a placeholder that proves the profile reaches the reply prompt — it describes the samples' structure, not this person's voice.`,
  });
}

/**
 * Reads back the deterministic findings block.
 *
 * This is the one thing the stubbed threat assessment is allowed to look at, and that
 * is the whole design: the stub's verdict is a function of *our* signals, never of the
 * email's prose. So a phishing body that pleads its innocence changes nothing here —
 * which is the property the real defense assumes, and a dev tool used to demonstrate
 * that defense must not quietly lack it.
 */
export function parseThreatSignals(userContent: string): Record<string, string> {
  const block = /<threat_signals>\n([\s\S]*?)\n<\/threat_signals>/.exec(userContent);
  const fields: Record<string, string> = {};
  if (block === null) return fields;

  for (const line of (block[1] ?? "").split("\n")) {
    const separator = line.indexOf(": ");
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    if (!(key in fields)) fields[key] = line.slice(separator + 2);
  }
  return fields;
}

/**
 * A deterministic threat assessment.
 *
 * It mirrors the floor it is given rather than second-guessing it, and says out loud
 * that it is a stub. That makes a dev run exercise the interesting half — the union, the
 * row, the banner, the appeal — while being obviously useless as a judgment, which is
 * the correct trade for a component whose real job is reading prose.
 *
 * One deliberate behaviour: when the floor is SUSPICIOUS it returns SAFE. That is the
 * §6 case worth having in front of you locally — the model disagreeing downward — and it
 * means the banner you see in development is one the rules held up on their own.
 */
export function stubThreatAssessment(userContent: string): AiThreatAssessmentOutput {
  const signals = parseThreatSignals(userContent);
  const { metadata } = parsePrompt(userContent);

  const floor = signals["deterministic_floor"] ?? "SAFE";
  const score = Number(signals["deterministic_score"] ?? "0");
  const automated = isAutomated(metadata);

  const intent = floor === "SAFE"
    ? automated
      ? "BENIGN_TRANSACTIONAL"
      : "BENIGN_PERSONAL"
    : "UNCLEAR";

  return aiThreatAssessmentSchema.parse({
    intent,
    // Always SAFE: see above. The union is what decides, and locally it should be
    // visible that it decides against this value.
    assessedLevel: "SAFE",
    confidence: 0.3,
    explanation: `[stubbed assessment] The development AI stub read no prose: this text is generated locally from the deterministic findings (score ${Number.isFinite(score) ? score : 0}, floor ${floor}), which are the real signal here. Treat the intent above as a placeholder, not a judgment.`,
  });
}

/**
 * A deterministic "translation".
 *
 * It does not translate. It cannot — there is no model here — and pretending otherwise
 * would be the one dishonest thing a development stub can do with this feature, because
 * a translation is the output a reader trusts most literally. So it returns the original
 * text with a labelled banner, which exercises everything worth exercising locally (the
 * prompt, the tool schema, the `(messageId, targetLang)` cache, the ledger row, the
 * language control, a cache hit costing nothing) while being unmistakable on screen.
 *
 * It reads the target language out of *our own* request block rather than from anything
 * in the mail, for the same reason every other stub here reads the envelope: an email
 * that says "translate this into Klingon" must not be able to change the answer.
 */
export function stubTranslation(userContent: string): AiTranslationOutput {
  const target =
    /<translation_request>\ntarget_language: ([^\n]+)/.exec(userContent)?.[1]?.trim() ??
    "unknown";
  const { body } = parsePrompt(userContent);

  return aiTranslationSchema.parse({
    // Deliberately not the target: claiming to have detected a source language would be
    // inventing the one judgment this stub is incapable of.
    sourceLang: "und",
    translatedText: [
      `[stubbed translation → ${target}] The development AI stub does not translate. The original text follows, unchanged:`,
      "",
      body.length === 0 ? "(no body text)" : body,
    ].join("\n"),
  });
}

interface MessagesRequest {
  model: string;
  system: string;
  messages: { role: string; content: string }[];
  tools: { name: string }[];
  tool_choice?: { name?: string };
}

/**
 * Builds the Messages API response.
 *
 * Token counts are estimated from the request (~4 characters per token) so the
 * usage ledger and the cost column hold realistic numbers rather than zeros —
 * `AiUsage` is meant to be readable in development too.
 */
export function stubResponse(request: MessagesRequest): unknown {
  const toolName = request.tool_choice?.name ?? request.tools[0]?.name ?? "unknown";
  const userContent = request.messages.map((message) => message.content).join("\n");

  /*
   * Dispatch on the tool the caller pinned, which is how the real API behaves: the
   * tool name is the contract, and a stub that guessed from the prompt text would be
   * steerable by an email that mentions one.
   */
  const input =
    toolName === "record_summary"
      ? stubSummary(userContent)
      : toolName === "record_reply_drafts"
        ? stubReplyVariants(userContent)
        : toolName === "record_composed_message"
          ? stubComposedMessage(userContent)
          : toolName === "record_writing_style"
            ? stubWritingStyle(userContent)
            : toolName === "record_threat_assessment"
              ? stubThreatAssessment(userContent)
              : toolName === "record_translation"
                ? stubTranslation(userContent)
                : stubClassification(userContent);

  const promptChars = request.system.length + userContent.length;
  const outputChars = JSON.stringify(input).length;

  return {
    id: `msg_stub_${createHash("sha256").update(userContent).digest("hex").slice(0, 20)}`,
    type: "message",
    role: "assistant",
    model: request.model,
    content: [{ type: "tool_use", id: "toolu_stub", name: toolName, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: Math.ceil(promptChars / 4),
      output_tokens: Math.ceil(outputChars / 4),
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

/**
 * The stub HTTP server.
 *
 * Bound to 127.0.0.1 only: this answers "what does Claude think of this email"
 * with a canned reply, and nothing outside the machine should be able to ask.
 */
export function createAiStubServer(): Server {
  return createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error" } }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const request = JSON.parse(body) as MessagesRequest;
        const response = stubResponse(request);

        logger.debug(
          { model: request.model, tool: request.tool_choice?.name },
          "ai stub answered",
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
      } catch (error) {
        // Shaped like an Anthropic error so the SDK's own handling applies.
        logger.error({ err: error }, "ai stub could not answer");
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "stub could not parse the request" },
          }),
        );
      }
    });
  });
}

/** Thrown when the port is taken — usually another stub, already doing the job. */
export class AiStubPortInUseError extends Error {
  constructor(readonly port: number) {
    super(`port ${port} is already in use`);
    this.name = "AiStubPortInUseError";
  }
}

export async function startAiStub(port: number = env.AI_STUB_PORT): Promise<Server> {
  const server = createAiStubServer();

  await new Promise<void>((resolve, reject) => {
    /*
     * A listen failure must be a rejected promise, not an unhandled 'error' event.
     * As an event it crashed the process — and since this runs inside `pnpm dev`,
     * a stray stub on the port would have taken the api and worker down with it.
     */
    const onError = (error: NodeJS.ErrnoException): void => {
      server.close();
      reject(error.code === "EADDRINUSE" ? new AiStubPortInUseError(port) : error);
    };

    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  logger.info(
    { port, endpoint: `http://127.0.0.1:${port}` },
    "ai stub listening: canned responses, no API key needed, nothing leaves this machine",
  );
  return server;
}
