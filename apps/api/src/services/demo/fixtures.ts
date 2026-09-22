import type {
  AiActionItem,
  AiThreatAssessmentOutput,
  Category,
  Priority,
  ReplyTone,
} from "@inbox-copilot/shared";
import { DEMO_MAILBOX_ADDRESS, DEMO_MAILBOX_NAME } from "@inbox-copilot/shared";

/**
 * The demo mailbox: every person, company, domain and sentence in this file is
 * invented. It extends the cast of the README screenshots — Sam Whitfield at the
 * fictional Northwind Freight — and nothing in it comes from a real mailbox.
 * Most correspondents are on reserved `.example` domains; the handful that are not
 * are the README's own names, kept so the screenshots and the demo agree.
 *
 * This file is data only. `seed.ts` turns it into rows, and it computes the parts a
 * real mailbox would compute: snippets, content hashes, the known-domain set, and the
 * layer 1 and 2 phishing verdicts, which come from the real rule functions rather
 * than being written here. What *is* written here is what a model would have said —
 * summaries, the layer 3 reading of each message, translations, reply drafts — and
 * `seed.ts` stores all of it under `DEMO_SAMPLE_MODEL`, so the UI can say it was
 * written in advance instead of naming a model that never saw it.
 *
 * Times are minutes before the reset, so the mailbox always reads as "this morning"
 * however long ago it was seeded.
 */

export interface DemoPerson {
  name: string;
  email: string;
}

export interface DemoAttachment {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  riskFlag?: "executable" | "macro" | "archive";
}

/** The receiving server's verdicts, as the sync engine would have stored them. */
export interface DemoAuth {
  spf: "pass" | "fail" | "softfail" | "none";
  dkim: "pass" | "fail" | "none";
  dmarc: "pass" | "fail" | "none";
  returnPath: string;
}

/** Layer 3's reading of one inbound message. Unioned with the real rules in seed.ts. */
export type DemoThreatReading = Omit<AiThreatAssessmentOutput, "confidence"> & {
  confidence?: number;
};

export interface DemoMessage {
  from: DemoPerson;
  to: DemoPerson[];
  cc?: DemoPerson[];
  minutesAgo: number;
  /** Exactly one of `html` or `text`. */
  html?: string;
  text?: string;
  attachments?: DemoAttachment[];
  replyTo?: string;
  /** Defaults to pass/pass/pass with an aligned Return-Path. */
  auth?: DemoAuth;
  isRead?: boolean;
  /** Inbound only. Defaults to a SAFE reading with the thread's benign intent. */
  threat?: DemoThreatReading;
  /** Inbound only: a pre-written translation into English. */
  translationEn?: { sourceLang: string; text: string };
}

export interface DemoDraft {
  label: string;
  body: string;
}

export interface DemoThread {
  /** Stable number; ids are derived from it, so never renumber a thread. */
  n: number;
  subject: string;
  category: Category;
  priority: Priority;
  priorityScore: number;
  needsReply: boolean;
  language: string;
  isStarred?: boolean;
  /** The benign intent layer 3 assigns to this thread's ordinary messages. */
  intent: "BENIGN_PERSONAL" | "BENIGN_TRANSACTIONAL" | "BENIGN_MARKETING";
  messages: DemoMessage[];
  summary?: {
    headline: string;
    summary: string;
    keyPoints: string[];
    actionItems: AiActionItem[];
  };
  /** Pre-written reply drafts, served before any live model call (see ai.ts). */
  drafts?: Partial<Record<ReplyTone, [DemoDraft, DemoDraft, DemoDraft]>>;
}

/**
 * How many messages each sender had written *before* the threads shown here.
 *
 * A real mailbox has history, and the sender rules read it: without this, every
 * newsletter the reader has taken for years would be flagged as a first-time sender.
 * Senders not listed have no history, which is the honest default and exactly what
 * the phishing sender gets.
 */
export const SENDER_HISTORY: Readonly<Record<string, number>> = {
  "dana@brightpath-logistics.com": 42,
  "priya.raman@meridian-legal.co.uk": 18,
  "billing@larkspur-invoicing.com": 11,
  "j.whitfield@fastmail-demo.net": 240,
  "noreply@meridian-crossings.com": 6,
  "tomas@vetrov-studio.example": 4,
  "weekly@theloadingdock-news.com": 96,
  "hello@harbourcoffee.example": 31,
  "notifications@fleetwatch.example": 58,
  "ines.duarte@northwind-freight.com": 310,
  "ravi.menon@northwind-freight.com": 190,
  "c.laurent@transports-laurent.fr": 23,
  "lucia.marquez@correo-demo.es": 37,
  "owen@harbourline-customs.co.uk": 14,
  "beth.ansell@harrow-estates.example": 9,
  "brief@supplychainbrief.example": 44,
  "offers@skylark-air.example": 27,
  "payslips@pennant-payroll.example": 20,
  "statements@allderbank.example": 20,
  "noreply@tallyho-expenses.example": 35,
  "notifications@linkline.example": 70,
  "appointments@castlestreetdental.example": 5,
  "hannah.cole@fastmail-demo.net": 48,
};

/* ── The cast ──────────────────────────────────────────────────────────────────── */

export const SAM: DemoPerson = { name: DEMO_MAILBOX_NAME, email: DEMO_MAILBOX_ADDRESS };

const DANA: DemoPerson = { name: "Dana Okonkwo", email: "dana@brightpath-logistics.com" };
const BRIGHTPATH_CONTRACTS: DemoPerson = {
  name: "Brightpath Contracts",
  email: "contracts@brightpath-logistics.com",
};
const PHISHER: DemoPerson = {
  name: "Microsoft account team",
  email: "security@rnicrosoft-verify.com",
};
const PRIYA: DemoPerson = {
  name: "Priya Raman",
  email: "priya.raman@meridian-legal.co.uk",
};
const OWEN: DemoPerson = { name: "Owen Pryce", email: "owen@harbourline-customs.co.uk" };
const CAMILLE: DemoPerson = {
  name: "Camille Laurent",
  email: "c.laurent@transports-laurent.fr",
};
const LARKSPUR: DemoPerson = {
  name: "Larkspur Invoicing",
  email: "billing@larkspur-invoicing.com",
};
const MUM: DemoPerson = { name: "Mum", email: "j.whitfield@fastmail-demo.net" };
const INES: DemoPerson = {
  name: "Inês Duarte",
  email: "ines.duarte@northwind-freight.com",
};
const FERRY: DemoPerson = {
  name: "Ferry & Rail Booking",
  email: "noreply@meridian-crossings.com",
};
const HOTEL: DemoPerson = {
  name: "Hôtel du Port, Calais",
  email: "reservations@hotelduport-calais.example",
};
const TOMAS: DemoPerson = { name: "Tomas Vetrov", email: "tomas@vetrov-studio.example" };
const LUCIA: DemoPerson = {
  name: "Lucía Márquez",
  email: "lucia.marquez@correo-demo.es",
};
const MARCUS: DemoPerson = { name: "Marcus Hale", email: "m.hale@kestrel-foods.example" };
const BETH: DemoPerson = {
  name: "Beth Ansell",
  email: "beth.ansell@harrow-estates.example",
};
const RAVI: DemoPerson = {
  name: "Ravi Menon",
  email: "ravi.menon@northwind-freight.com",
};
const OPS_TEAM: DemoPerson = {
  name: "Northwind Ops",
  email: "ops@northwind-freight.com",
};
const LOADING_DOCK: DemoPerson = {
  name: "The Loading Dock",
  email: "weekly@theloadingdock-news.com",
};
const BRIEF: DemoPerson = {
  name: "Supply Chain Brief",
  email: "brief@supplychainbrief.example",
};
const COFFEE: DemoPerson = {
  name: "Harbour Coffee Co.",
  email: "hello@harbourcoffee.example",
};
const SKYLARK: DemoPerson = { name: "Skylark Air", email: "offers@skylark-air.example" };
const FLEETWATCH: DemoPerson = {
  name: "Fleetwatch",
  email: "notifications@fleetwatch.example",
};
const PAYROLL: DemoPerson = {
  name: "Pennant Payroll",
  email: "payslips@pennant-payroll.example",
};
const BANK: DemoPerson = { name: "Allder Bank", email: "statements@allderbank.example" };
const TALLYHO: DemoPerson = {
  name: "Tallyho Expenses",
  email: "noreply@tallyho-expenses.example",
};
const LINKLINE: DemoPerson = {
  name: "Linkline",
  email: "notifications@linkline.example",
};
const DENTIST: DemoPerson = {
  name: "Castle Street Dental",
  email: "appointments@castlestreetdental.example",
};
const HANNAH: DemoPerson = {
  name: "Hannah Cole",
  email: "hannah.cole@fastmail-demo.net",
};

/** Inline styles a sender would write for a white page — the frame keeps it white. */
const WRAP =
  '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;color:#222;line-height:1.5">';

function html(...parts: string[]): string {
  return [WRAP, ...parts, "</div>"].join("");
}

const HOUR = 60;
const DAY = 24 * HOUR;

/* ── The threads ───────────────────────────────────────────────────────────────── */

export const DEMO_THREADS: readonly DemoThread[] = [
  {
    n: 1,
    subject: "Re: Q4 freight rates — we need the signed contract today",
    category: "WORK",
    priority: "URGENT",
    priorityScore: 94,
    needsReply: true,
    language: "en",
    intent: "BENIGN_PERSONAL",
    messages: [
      {
        from: DANA,
        to: [SAM],
        cc: [BRIGHTPATH_CONTRACTS],
        minutesAgo: 310,
        isRead: true,
        html: html(
          "<p>Hi Sam,</p>",
          "<p>Good news — the board signed off on the volume discount this morning. 7.5% on anything over 400 pallets a quarter, which is where we landed last week.</p>",
          "<p>The one thing I need from you today is the countersigned contract. Legal will not open the Q4 lane allocations until it is on file, and the cut-off is 5pm.</p>",
          "<p>Revised terms are attached. The only change from the draft you saw is clause 4.2, which now says the discount reviews annually rather than quarterly.</p>",
          '<p><img src="https://cdn.brightpath-logistics.com/email/signature-logo.png" alt="Brightpath Logistics" width="140"></p>',
          "<p>Dana</p>",
        ),
        attachments: [
          {
            filename: "Northwind-Brightpath-Q4-2026-revised.pdf",
            mimeType: "application/pdf",
            sizeBytes: 284_160,
          },
        ],
      },
      {
        from: DANA,
        to: [SAM],
        minutesAgo: 22,
        html: html(
          "<p>Sam — sorry to chase. Legal has flagged that if this misses 5pm we lose the October lane slots, and the next allocation window is the 6th.</p>",
          "<p>Nothing needs renegotiating. The rates are the ones we agreed on Tuesday and the attachment is the same document, it just needs a signature on page 11.</p>",
          "<p>If it is easier, send it back scanned and we will take the original in the post.</p>",
          "<p>Dana</p>",
        ),
      },
    ],
    summary: {
      headline: "Dana needs the countersigned Q4 contract before 5pm today",
      summary:
        "Brightpath's board approved the 7.5% volume discount above 400 pallets a quarter. The only outstanding item is your signature on the revised contract, which Dana has attached. Their legal team will not release the Q4 lane allocations until it is filed, and the deadline is 5pm today.",
      keyPoints: [
        "The discount is agreed at 7.5% over 400 pallets per quarter.",
        "Clause 4.2 changed: the discount now reviews annually, not quarterly.",
        "Missing 5pm pushes the lane allocation to the next window on 6 October.",
      ],
      actionItems: [
        { owner: "user", text: "Countersign the attached contract and return it." },
        {
          owner: "user",
          text: "Check clause 4.2 before signing — the review period changed.",
        },
        { owner: "Dana Okonkwo", text: "File the signed copy with Brightpath legal." },
      ],
    },
    drafts: {
      PROFESSIONAL: [
        {
          label: "Sign today",
          body: "Hi Dana,\n\nGreat news on the board approval. I have the revised contract open now — I will countersign and send it back before 5pm.\n\nOne thing I want to confirm before I do: clause 4.2 moving to an annual review was not in the version we discussed on Tuesday. Happy to proceed on that basis, I just want it on record that we noticed it.\n\nSam",
        },
        {
          label: "Query clause 4.2 first",
          body: "Hi Dana,\n\nThanks for pushing this through. Before I sign, can you confirm why clause 4.2 changed from a quarterly to an annual review? That was not in the draft we agreed on Tuesday and it changes how quickly we can renegotiate if volumes move.\n\nIf you can confirm it was intentional I will have it back to you well before 5pm.\n\nSam",
        },
        {
          label: "Short acknowledgement",
          body: "Dana — understood, signing it this afternoon. It will be with you before the 5pm cut-off.\n\nSam",
        },
      ],
      CONCISE: [
        {
          label: "Will sign by 5pm",
          body: "Dana — signing it now, you will have it before 5pm.\n\nSam",
        },
        {
          label: "Sign, note 4.2",
          body: "Dana — will sign today. Noting that 4.2 moved to an annual review; fine by us.\n\nSam",
        },
        {
          label: "Ask about 4.2",
          body: "Dana — quick one before I sign: was the change to annual review in 4.2 intentional?\n\nSam",
        },
      ],
    },
  },

  {
    n: 2,
    subject: "Unusual sign-in activity — verify within 24 hours",
    category: "OTHER",
    priority: "HIGH",
    priorityScore: 70,
    needsReply: false,
    language: "en",
    intent: "BENIGN_TRANSACTIONAL",
    messages: [
      {
        from: PHISHER,
        to: [SAM],
        minutesAgo: 51,
        auth: {
          spf: "softfail",
          dkim: "none",
          dmarc: "fail",
          returnPath: "bounce@mailer-relay.top",
        },
        html: html(
          '<p style="font-size:20px;font-weight:600;margin:0 0 12px">Unusual sign-in activity</p>',
          '<p style="margin:0 0 12px">We detected a sign-in to your account from a device we do not recognise:</p>',
          '<table style="border-collapse:collapse;margin:0 0 16px;font-size:14px">',
          '<tr><td style="padding:4px 16px 4px 0;color:#666">Location</td><td>Lagos, Nigeria</td></tr>',
          '<tr><td style="padding:4px 16px 4px 0;color:#666">Time</td><td>03:14 GMT</td></tr>',
          '<tr><td style="padding:4px 16px 4px 0;color:#666">Device</td><td>Windows PC</td></tr>',
          "</table>",
          '<p style="margin:0 0 16px">If this was not you, verify your account within 24 hours or access will be suspended.</p>',
          '<p style="margin:0 0 16px"><a href="https://verify-mscdn.top/session" style="background:#0067b8;color:#fff;padding:10px 20px;text-decoration:none;display:inline-block;border-radius:2px">Verify account</a></p>',
          '<p style="margin:0;font-size:13px;color:#666">Or sign in at <a href="https://verify-mscdn.top/session?r=2">account.microsoft.com</a>.</p>',
          '<p><img src="https://verify-mscdn.top/px.gif?u=sam" width="1" height="1" alt=""><img src="https://verify-mscdn.top/logo.png" alt="Microsoft" width="108"></p>',
        ),
        threat: {
          intent: "CREDENTIAL_HARVEST",
          assessedLevel: "PHISHING",
          confidence: 0.96,
          explanation:
            "This copies Microsoft's sign-in warning to get you onto a page that asks for your password. Both links go to verify-mscdn.top, not Microsoft, and the sender's domain, rnicrosoft-verify.com, uses “rn” to look like an “m”. If you are worried about the account, open microsoft.com yourself rather than following anything here.",
        },
      },
    ],
  },

  {
    n: 3,
    subject: "Lease amendment — one clause left to confirm",
    category: "WORK",
    priority: "HIGH",
    priorityScore: 76,
    needsReply: true,
    language: "en",
    intent: "BENIGN_PERSONAL",
    messages: [
      {
        from: PRIYA,
        to: [SAM],
        minutesAgo: 3 * DAY + 5 * HOUR,
        isRead: true,
        text: "Hi Sam,\n\nAttached is the first draft of the amendment to the Felixstowe warehouse lease. It covers the extra bay, the new service charge cap and the break clause we discussed.\n\nCould you read clauses 6 to 9 in particular? Those are the ones the landlord's side rewrote.\n\nBest,\nPriya",
        attachments: [
          {
            filename: "Felixstowe-lease-amendment-draft-1.docx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            sizeBytes: 96_512,
          },
        ],
      },
      {
        from: SAM,
        to: [PRIYA],
        minutesAgo: 2 * DAY + 3 * HOUR,
        text: 'Thanks Priya. 6, 7 and 9 look fine. On 8 I am not sure what the landlord means by "reasonable notice" for the break — can we pin it to a number?\n\nSam',
      },
      {
        from: PRIYA,
        to: [SAM],
        minutesAgo: 1 * DAY + 2 * HOUR,
        isRead: true,
        text: "Good catch. They have come back with six months, which is standard. I have put that into 8a.\n\nThey have also added 8b, which says the break can only be exercised if the rent is fully paid up at the break date. That one is worth a proper look before I agree it.\n\nPriya",
      },
      {
        from: PRIYA,
        to: [SAM],
        minutesAgo: 96,
        text: "Sam — I need your answer on 8b before I file on Tuesday. If you are happy with it as drafted I will accept it; if not, my suggestion is to limit it to rent that is more than 30 days overdue, so a disputed invoice cannot block the break.\n\nRevised draft attached with both options marked.\n\nPriya",
        attachments: [
          {
            filename: "Felixstowe-lease-amendment-draft-3.docx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            sizeBytes: 101_376,
          },
        ],
      },
    ],
    summary: {
      headline: "Priya needs your decision on clause 8b before she files on Tuesday",
      summary:
        "The Felixstowe lease amendment is agreed except for one clause. The landlord added 8b, which lets you use the break only if rent is fully paid at the break date. Priya can accept it as drafted or propose limiting it to rent more than 30 days overdue, so a disputed invoice cannot block the break. She files on Tuesday.",
      keyPoints: [
        "Clauses 6, 7 and 9 are agreed.",
        "Clause 8a now fixes the break notice at six months.",
        "Clause 8b is new: the break needs rent fully paid at the break date.",
        "Priya's suggestion is to limit 8b to rent more than 30 days overdue.",
      ],
      actionItems: [
        {
          owner: "user",
          text: "Tell Priya whether to accept 8b or propose the 30-day version.",
        },
        { owner: "Priya Raman", text: "File the amendment on Tuesday." },
      ],
    },
    drafts: {
      PROFESSIONAL: [
        {
          label: "Take the 30-day version",
          body: "Hi Priya,\n\nThanks for flagging 8b. Please go with your suggestion and limit it to rent more than 30 days overdue — I would not want a disputed invoice to be what stops us using the break.\n\nEverything else is fine as drafted, so you are clear to file on Tuesday.\n\nSam",
        },
        {
          label: "Accept as drafted",
          body: "Hi Priya,\n\nI have read 8b. We have never been behind on rent and I do not want to hold up the filing over it, so please accept it as drafted.\n\nThanks for turning this round so quickly.\n\nSam",
        },
        {
          label: "Ask for a call",
          body: "Hi Priya,\n\nI am leaning towards the 30-day version of 8b, but I would like ten minutes to understand how the landlord is likely to react before we propose it. Are you free for a quick call tomorrow morning?\n\nSam",
        },
      ],
    },
  },

  {
    n: 4,
    subject: "Customs hold on NW-4471 — commercial invoice needed by Thursday",
    category: "WORK",
    priority: "HIGH",
    priorityScore: 81,
    needsReply: true,
    language: "en",
    intent: "BENIGN_PERSONAL",
    messages: [
      {
        from: OWEN,
        to: [SAM],
        cc: [OPS_TEAM],
        minutesAgo: 6 * HOUR,
        isRead: true,
        text: "Hi Sam,\n\nHMRC have put shipment NW-4471 (40ft, Felixstowe, 18 pallets of machine parts) on a documentary hold. The commercial invoice we filed shows a total value that does not match the packing list — £48,200 against £46,850.\n\nI need a corrected commercial invoice, or a short letter from the shipper explaining the difference, by Thursday midday. After that the container starts accruing port storage at £85 a day.\n\nOwen Pryce\nHarbourline Customs",
      },
      {
        from: OWEN,
        to: [SAM],
        cc: [OPS_TEAM],
        minutesAgo: 70,
        text: "Quick update — I have spoken to the officer and a letter from the shipper is enough, as long as it is on their letterhead and signed. It does not need to be a new invoice.\n\nIf you can get it to me by Thursday 12:00 I will lodge it the same afternoon.\n\nOwen",
      },
    ],
    summary: {
      headline:
        "NW-4471 is held by customs until the shipper explains a £1,350 value gap",
      summary:
        "HMRC have held container NW-4471 at Felixstowe because the commercial invoice (£48,200) does not match the packing list (£46,850). Owen has confirmed a signed letter on the shipper's letterhead explaining the difference is enough. He needs it by Thursday 12:00; after that storage costs £85 a day.",
      keyPoints: [
        "The hold is documentary, not a physical inspection.",
        "Invoice and packing list differ by £1,350.",
        "A signed letter from the shipper is enough — no new invoice needed.",
        "Port storage starts at £85 a day after Thursday midday.",
      ],
      actionItems: [
        {
          owner: "user",
          text: "Ask the shipper for a signed letter explaining the value difference.",
        },
        { owner: "user", text: "Send the letter to Owen by Thursday 12:00." },
        { owner: "Owen Pryce", text: "Lodge the letter with HMRC the same afternoon." },
      ],
    },
    drafts: {
      PROFESSIONAL: [
        {
          label: "On it",
          body: "Hi Owen,\n\nThanks for clearing up what the officer needs. I am asking the shipper for a signed letter on their letterhead today and will forward it as soon as it arrives — well before Thursday 12:00.\n\nSam",
        },
        {
          label: "Ask what caused the gap",
          body: "Hi Owen,\n\nThanks. Before I go to the shipper, do you know which lines account for the £1,350? If it is the freight charge being included on one document and not the other, I can tell them exactly what the letter needs to say.\n\nSam",
        },
        {
          label: "Loop in ops",
          body: "Hi Owen,\n\nThanks for the update. I have copied the ops team, who hold the shipper contact for this one — they will get the letter to you by Thursday morning. I will make sure it is on letterhead and signed.\n\nSam",
        },
      ],
    },
  },

  {
    n: 5,
    subject: "Retard de livraison — conteneur MSKU 482913-6",
    category: "WORK",
    priority: "HIGH",
    priorityScore: 72,
    needsReply: true,
    language: "fr",
    intent: "BENIGN_PERSONAL",
    messages: [
      {
        from: CAMILLE,
        to: [SAM],
        minutesAgo: 3 * HOUR + 40,
        text: "Bonjour Sam,\n\nJe vous écris au sujet du conteneur MSKU 482913-6, prévu à Calais jeudi. Le navire a été retardé à Anvers par une grève des dockers et l'arrivée est maintenant estimée à samedi matin.\n\nNous pouvons soit livrer samedi après-midi, avec un supplément week-end de 180 €, soit livrer lundi à 8 h sans frais supplémentaires.\n\nPourriez-vous me dire avant demain 16 h quelle option vous préférez ? Sans réponse de votre part, nous livrerons lundi.\n\nCordialement,\nCamille Laurent\nTransports Laurent",
        translationEn: {
          sourceLang: "fr",
          text: "Hello Sam,\n\nI am writing about container MSKU 482913-6, due in Calais on Thursday. The ship has been delayed in Antwerp by a dockworkers' strike and arrival is now estimated for Saturday morning.\n\nWe can either deliver on Saturday afternoon, with a weekend surcharge of €180, or deliver on Monday at 8am at no extra cost.\n\nCould you tell me before 4pm tomorrow which option you prefer? If we do not hear from you, we will deliver on Monday.\n\nKind regards,\nCamille Laurent\nTransports Laurent",
        },
      },
    ],
    summary: {
      headline: "Container MSKU 482913-6 is late: choose Saturday (+€180) or Monday",
      summary:
        "Camille writes in French that the ship carrying container MSKU 482913-6 is held in Antwerp by a dockworkers' strike, so it will reach Calais on Saturday morning instead of Thursday. Transports Laurent can deliver on Saturday afternoon for a €180 weekend surcharge, or on Monday at 8am at no extra cost. They need your choice by 4pm tomorrow, and will deliver on Monday if you do not reply.",
      keyPoints: [
        "New arrival estimate: Saturday morning, not Thursday.",
        "Saturday afternoon delivery costs an extra €180.",
        "Monday 8am delivery costs nothing extra.",
        "No answer by 4pm tomorrow means Monday.",
      ],
      actionItems: [
        {
          owner: "user",
          text: "Tell Camille whether you want Saturday or Monday delivery.",
        },
      ],
    },
    drafts: {
      PROFESSIONAL: [
        {
          label: "Monday is fine",
          body: "Bonjour Camille,\n\nMerci pour l'information. La livraison lundi à 8 h nous convient très bien, inutile de payer le supplément.\n\nBien cordialement,\nSam",
        },
        {
          label: "Saturday, please",
          body: "Bonjour Camille,\n\nMerci de nous avoir prévenus. Nous préférons la livraison samedi après-midi et acceptons le supplément de 180 €. Pouvez-vous me confirmer le créneau horaire ?\n\nBien cordialement,\nSam",
        },
        {
          label: "Ask about the strike",
          body: "Bonjour Camille,\n\nMerci. Avant de choisir, savez-vous si la grève risque de retarder encore le navire ? Si l'arrivée de samedi est incertaine, nous partirons sur lundi.\n\nBien cordialement,\nSam",
        },
      ],
    },
  },

  {
    n: 6,
    subject: "Invoice LK-20418 is due on 5 October",
    category: "FINANCE",
    priority: "NORMAL",
    priorityScore: 52,
    needsReply: false,
    language: "en",
    intent: "BENIGN_TRANSACTIONAL",
    messages: [
      {
        from: LARKSPUR,
        to: [SAM],
        minutesAgo: 3 * HOUR,
        html: html(
          '<p style="font-size:18px;font-weight:600;margin:0 0 8px">Invoice LK-20418</p>',
          "<p>A new invoice of <strong>$4,280.00</strong> has been issued to Northwind Freight Ltd for September pallet racking maintenance.</p>",
          '<table style="border-collapse:collapse;font-size:14px;margin:0 0 12px">',
          '<tr><td style="padding:3px 16px 3px 0;color:#666">Due date</td><td>5 October</td></tr>',
          '<tr><td style="padding:3px 16px 3px 0;color:#666">Payment terms</td><td>30 days</td></tr>',
          "</table>",
          "<p>No action is needed if payment is already scheduled. You can view and download the invoice from your Larkspur account.</p>",
        ),
        attachments: [
          { filename: "LK-20418.pdf", mimeType: "application/pdf", sizeBytes: 64_220 },
        ],
      },
    ],
  },

  {
    n: 7,
    subject: "Sunday lunch — are you bringing anyone?",
    category: "PERSONAL",
    priority: "NORMAL",
    priorityScore: 48,
    needsReply: true,
    language: "en",
    intent: "BENIGN_PERSONAL",
    messages: [
      {
        from: MUM,
        to: [SAM],
        minutesAgo: 2 * DAY,
        isRead: true,
        text: "Hello love,\n\nAre you still coming on Sunday? Dad is doing the lamb.\n\nMum x",
      },
      {
        from: SAM,
        to: [MUM],
        minutesAgo: 2 * DAY - 3 * HOUR,
        text: "Wouldn't miss it. What time do you want me?\n\nS x",
      },
      {
        from: MUM,
        to: [SAM],
        minutesAgo: 4 * HOUR,
        text: "About 1 o'clock. Your sister is coming down with the girls so I am doing the big table. Let me know numbers by Friday — are you bringing anyone?\n\nAnd can you bring the folding chairs back if you still have them.\n\nMum x",
      },
    ],
    drafts: {
      PROFESSIONAL: [
        {
          label: "Just me",
          body: "Hi Mum,\n\nJust me this time — I will be there for 1. I still have the folding chairs, so I will bring them with me.\n\nSee you Sunday,\nS x",
        },
        {
          label: "Bringing someone",
          body: "Hi Mum,\n\nI will be there for 1, and I would like to bring Alex if there is room at the big table. I will bring the chairs back too.\n\nS x",
        },
        {
          label: "Not sure yet",
          body: "Hi Mum,\n\nI will definitely be there for 1. I will confirm numbers by Friday — just waiting to hear back from someone. Chairs are in the car already.\n\nS x",
        },
      ],
      FRIENDLY: [
        {
          label: "Just me",
          body: "Hi Mum!\n\nJust me — can't wait, it's been ages since the whole lot of us were round the table. I'll be there for 1 with the folding chairs.\n\nLove to Dad,\nS x",
        },
        {
          label: "Plus one",
          body: "Hi Mum!\n\nCount me in for 1. Would it be OK if I brought Alex? And yes, the chairs are coming home at last.\n\nS x",
        },
        {
          label: "Offer to help",
          body: "Hi Mum!\n\nI'll be there for 1 — just me. Shall I come a bit early and help with the big table? I'll bring the chairs.\n\nS x",
        },
      ],
    },
  },

  {
    n: 8,
    subject: "Team offsite — venue shortlist",
    category: "WORK",
    priority: "NORMAL",
    priorityScore: 58,
    needsReply: true,
    language: "en",
    intent: "BENIGN_PERSONAL",
    messages: [
      {
        from: INES,
        to: [SAM, RAVI],
        minutesAgo: 1 * DAY + 6 * HOUR,
        isRead: true,
        text: "Hi both,\n\nI have narrowed the November offsite down to three venues:\n\n1. Hartwell Barn, near Canterbury — £2,900 for the day, sleeps 12, 40 minutes from the depot.\n2. The Custom House, Dover — £2,150, no rooms, but a 10-minute walk from the office.\n3. Longmere Hall, Ashford — £3,400, sleeps 20, has the big meeting room with screens.\n\nAll three can do 13 or 14 November. Which do you prefer?\n\nInês",
      },
      {
        from: SAM,
        to: [INES, RAVI],
        minutesAgo: 1 * DAY + 2 * HOUR,
        text: "Thanks Inês. Do any of them do a proper lunch included? That swung it last year.\n\nSam",
      },
      {
        from: INES,
        to: [SAM, RAVI],
        minutesAgo: 5 * HOUR,
        text: "Hartwell and Longmere both include lunch; the Custom House would be sandwiches brought in. Ravi has voted for Hartwell. Could you let me know yours by Friday so I can put down the deposit?\n\nInês",
      },
    ],
    summary: {
      headline: "Inês needs your venue vote by Friday; Ravi chose Hartwell Barn",
      summary:
        "Inês has shortlisted three venues for the November offsite, all free on 13 or 14 November. Hartwell Barn (£2,900, sleeps 12) and Longmere Hall (£3,400, sleeps 20) include lunch; the Custom House in Dover (£2,150) does not. Ravi has voted for Hartwell. Inês needs your choice by Friday to pay the deposit.",
      keyPoints: [
        "Hartwell Barn: £2,900, sleeps 12, lunch included, 40 minutes away.",
        "The Custom House: £2,150, no rooms, sandwiches only, 10 minutes' walk.",
        "Longmere Hall: £3,400, sleeps 20, lunch included, big meeting room.",
        "Ravi has voted for Hartwell Barn.",
      ],
      actionItems: [
        { owner: "user", text: "Send Inês your venue choice by Friday." },
        { owner: "Inês Duarte", text: "Pay the deposit once the venue is chosen." },
      ],
    },
    drafts: {
      PROFESSIONAL: [
        {
          label: "Hartwell",
          body: "Hi Inês,\n\nHartwell Barn gets my vote too — lunch included and room for everyone who wants to stay. Either date works for me.\n\nThanks for pulling this together,\nSam",
        },
        {
          label: "Longmere",
          body: "Hi Inês,\n\nI would go for Longmere Hall. It is the most expensive, but if we want the whole team to stay over it is the only one with enough rooms, and the meeting room saves us hiring screens.\n\nSam",
        },
        {
          label: "Hartwell, 13th",
          body: "Hi Inês,\n\nHartwell for me, and the 13th if we have the choice — the 14th clashes with month-end.\n\nSam",
        },
      ],
    },
  },

  {
    n: 9,
    subject: "Booking confirmed: Dover to Calais, 14 October",
    category: "TRAVEL",
    priority: "NORMAL",
    priorityScore: 41,
    needsReply: false,
    language: "en",
    intent: "BENIGN_TRANSACTIONAL",
    messages: [
      {
        from: FERRY,
        to: [SAM],
        minutesAgo: 7 * HOUR,
        html: html(
          '<p style="font-size:18px;font-weight:600;margin:0 0 8px">You are booked</p>',
          "<p>Your reference is <strong>7QK2PM</strong>.</p>",
          '<table style="border-collapse:collapse;font-size:14px;margin:0 0 12px">',
          '<tr><td style="padding:3px 16px 3px 0;color:#666">Sailing</td><td>Dover → Calais, 14 October, 07:40</td></tr>',
          '<tr><td style="padding:3px 16px 3px 0;color:#666">Vehicle</td><td>Car, up to 1.85m high</td></tr>',
          '<tr><td style="padding:3px 16px 3px 0;color:#666">Passengers</td><td>1 adult</td></tr>',
          "</table>",
          "<p>Check-in opens 90 minutes before the sailing and closes 45 minutes before. Have your passport ready at the border control booths.</p>",
        ),
      },
    ],
  },

  {
    n: 10,
    subject: "Your reservation at Hôtel du Port — 14 October",
    category: "TRAVEL",
    priority: "NORMAL",
    priorityScore: 38,
    needsReply: false,
    language: "en",
    intent: "BENIGN_TRANSACTIONAL",
    messages: [
      {
        from: HOTEL,
        to: [SAM],
        minutesAgo: 6 * HOUR + 50,
        text: "Dear Mr Whitfield,\n\nThank you for your reservation.\n\nArrival: 14 October\nDeparture: 15 October\nRoom: Double, harbour view\nRate: €128 including breakfast\n\nParking is available in the courtyard. Reception is open until 23:00; please let us know if you expect to arrive later.\n\nWe look forward to welcoming you.\n\nHôtel du Port, Calais",
      },
    ],
  },

  {
    n: 11,
    subject: "Thanks for the introduction",
    category: "PERSONAL",
    priority: "NORMAL",
    priorityScore: 36,
    needsReply: false,
    language: "en",
    intent: "BENIGN_PERSONAL",
    messages: [
      {
        from: SAM,
        to: [TOMAS],
        minutesAgo: 3 * DAY,
        text: "Tomas — meet Inês Duarte, who runs events for us and is looking for a designer for the new depot signage. I think you two will get on. I will let you take it from here.\n\nSam",
      },
      {
        from: TOMAS,
        to: [SAM],
        minutesAgo: 1 * DAY - 1 * HOUR,
        isRead: true,
        text: "Really appreciated you putting us in touch — the call went well and we are picking it back up in October once her budget is signed off.\n\nI owe you a coffee.\n\nTomas",
      },
    ],
  },

  {
    n: 12,
    subject: "¿Nos vemos en Lisboa en noviembre?",
    category: "PERSONAL",
    priority: "NORMAL",
    priorityScore: 45,
    needsReply: true,
    language: "es",
    intent: "BENIGN_PERSONAL",
    messages: [
      {
        from: LUCIA,
        to: [SAM],
        minutesAgo: 9 * HOUR,
        text: "¡Hola Sam!\n\n¿Qué tal todo? Te escribo porque voy a estar en Lisboa del 20 al 24 de noviembre por un congreso, y me acordé de que dijiste que querías volver.\n\nSi te animas, podríamos cenar el viernes 22 en aquel sitio de Alfama que nos gustó tanto. Yo me encargo de reservar.\n\nDime algo cuando puedas.\n\nUn abrazo,\nLucía",
        translationEn: {
          sourceLang: "es",
          text: "Hi Sam!\n\nHow is everything? I am writing because I will be in Lisbon from 20 to 24 November for a conference, and I remembered you said you wanted to go back.\n\nIf you are up for it, we could have dinner on Friday the 22nd at that place in Alfama we liked so much. I will take care of the booking.\n\nLet me know when you can.\n\nA big hug,\nLucía",
        },
      },
    ],
    drafts: {
      PROFESSIONAL: [
        {
          label: "Yes to dinner",
          body: "Hola Lucía,\n\nWhat a lovely idea — yes, count me in for dinner on Friday the 22nd. I will look at flights this week and let you know when I land.\n\nUn abrazo,\nSam",
        },
        {
          label: "Maybe",
          body: "Hola Lucía,\n\nI would love to. I need to check whether I can get away that week — I will know by the end of next week and will tell you straight away.\n\nUn abrazo,\nSam",
        },
        {
          label: "Can't make it",
          body: "Hola Lucía,\n\nThank you for thinking of me. Sadly November is our busiest month and I cannot get away, but let's plan Lisbon properly for the spring.\n\nUn abrazo,\nSam",
        },
      ],
    },
  },

  {
    n: 13,
    subject: "Quote: chilled freight, Dover to Birmingham, weekly",
    category: "WORK",
    priority: "NORMAL",
    priorityScore: 44,
    needsReply: false,
    language: "en",
    intent: "BENIGN_PERSONAL",
    messages: [
      {
        from: SAM,
        to: [MARCUS],
        minutesAgo: 4 * DAY + 2 * HOUR,
        text: "Hi Marcus,\n\nAs promised, here is our quote for the weekly chilled run from Dover to your Birmingham DC.\n\n- 26 pallets per week, temperature-logged at 2–5°C\n- £1,140 per run, fuel surcharge included\n- 12-month term, with a review after 6 months\n\nThe rate holds until 15 October. Happy to walk you through it on a call.\n\nBest,\nSam",
        attachments: [
          {
            filename: "Northwind-Kestrel-chilled-quote.pdf",
            mimeType: "application/pdf",
            sizeBytes: 142_880,
          },
        ],
      },
    ],
  },

  {
    n: 14,
    subject: "Unit 7 renewal — heads of terms",
    category: "WORK",
    priority: "NORMAL",
    priorityScore: 40,
    needsReply: false,
    language: "en",
    intent: "BENIGN_PERSONAL",
    messages: [
      {
        from: BETH,
        to: [SAM],
        minutesAgo: 6 * DAY,
        isRead: true,
        text: "Hi Sam,\n\nThe landlord is happy to renew Unit 7 for another five years. Heads of terms attached: rent goes up 4% in year one and is then fixed, and they want a new schedule of condition.\n\nLet me know if you have questions.\n\nBeth Ansell\nHarrow Estates",
        attachments: [
          { filename: "Unit7-HoTs.pdf", mimeType: "application/pdf", sizeBytes: 58_400 },
        ],
      },
      {
        from: SAM,
        to: [BETH],
        minutesAgo: 5 * DAY,
        text: "Thanks Beth. Before we agree, can the landlord confirm who pays for the roof repairs flagged in last year's survey? If that falls on us under the new schedule of condition, the 4% looks different.\n\nSam",
      },
    ],
  },

  {
    n: 15,
    subject: "Warehouse rota for October",
    category: "WORK",
    priority: "NORMAL",
    priorityScore: 46,
    needsReply: false,
    language: "en",
    intent: "BENIGN_PERSONAL",
    messages: [
      {
        from: RAVI,
        to: [SAM, INES],
        minutesAgo: 8 * HOUR,
        text: "Morning both,\n\nOctober rota is in the shared drive. Two changes from September: Kim moves to nights from the 7th, and we are one short on the Saturday early shift for the last two weekends. I have asked the agency for cover.\n\nShout if anything looks wrong.\n\nRavi",
      },
    ],
  },

  {
    n: 16,
    subject: "Weekly: port congestion eases, and what it costs to wait",
    category: "NEWSLETTER",
    priority: "LOW",
    priorityScore: 22,
    needsReply: false,
    language: "en",
    intent: "BENIGN_MARKETING",
    messages: [
      {
        from: LOADING_DOCK,
        to: [SAM],
        minutesAgo: 1 * DAY + 3 * HOUR,
        html: html(
          '<p style="font-size:12px;color:#888;margin:0">THE LOADING DOCK · WEEKLY</p>',
          '<p style="font-size:22px;font-weight:700;margin:6px 0 12px">Port congestion eases — but waiting is still mispriced</p>',
          "<p>Queues at Rotterdam and Felixstowe fell for the fourth week running, with average vessel waiting time down to 1.8 days from a summer peak of 4.1.</p>",
          "<p>That is good news for schedules, but our analysis argues that demurrage and detention charges have not followed. Carriers are still billing at peak-season rates, and shippers who do not audit their invoices are overpaying by an estimated 6 to 9 per cent.</p>",
          '<p style="font-weight:600;margin:16px 0 4px">Also this week</p>',
          "<ul><li>Rail freight volumes through the Channel Tunnel are up 12% year on year.</li><li>Three things to check before signing a Q4 rate.</li><li>Reader question: is a 7.5% volume discount good?</li></ul>",
          '<p><a href="https://theloadingdock-news.com/weekly/port-congestion">Read the full issue</a> · <a href="https://theloadingdock-news.com/unsubscribe">Unsubscribe</a></p>',
          '<p><img src="https://theloadingdock-news.com/img/chart-waiting-times.png" alt="Chart of vessel waiting times" width="520"></p>',
        ),
      },
    ],
    summary: {
      headline: "Port queues are down, but demurrage charges are still at peak rates",
      summary:
        "Vessel waiting times at Rotterdam and Felixstowe have fallen for four weeks, to 1.8 days from a summer peak of 4.1. The newsletter argues that demurrage and detention charges have not come down with them, and estimates shippers who do not audit invoices are overpaying by 6 to 9 per cent.",
      keyPoints: [
        "Average waiting time is 1.8 days, down from 4.1 in summer.",
        "Carriers are still charging peak-season demurrage.",
        "Channel Tunnel rail freight is up 12% on last year.",
      ],
      actionItems: [],
    },
  },

  {
    n: 17,
    subject: "The Brief: why Q4 rates are softer than they look",
    category: "NEWSLETTER",
    priority: "LOW",
    priorityScore: 20,
    needsReply: false,
    language: "en",
    intent: "BENIGN_MARKETING",
    messages: [
      {
        from: BRIEF,
        to: [SAM],
        minutesAgo: 2 * DAY + 5 * HOUR,
        html: html(
          '<p style="font-size:20px;font-weight:700;margin:0 0 10px">Why Q4 rates are softer than they look</p>',
          "<p>Headline road-freight rates for Q4 are flat on last year, but once fuel surcharges are separated out, the underlying rate is down about 3%. Hauliers with spare capacity are competing on volume discounts rather than on list price.</p>",
          "<p>If you are renewing a contract this quarter, ask for the fuel surcharge to be quoted separately, and compare volume thresholds rather than headline rates.</p>",
          '<p><a href="https://supplychainbrief.example/q4-rates">Read more</a> · <a href="https://supplychainbrief.example/preferences">Email preferences</a></p>',
        ),
      },
    ],
    summary: {
      headline: "Q4 road rates look flat but are about 3% lower without fuel",
      summary:
        "The Brief says Q4 road-freight rates look flat on last year, but the underlying rate is roughly 3% lower once fuel surcharges are separated. Hauliers are competing on volume discounts, so when renewing, ask for fuel to be quoted separately and compare volume thresholds.",
      keyPoints: [
        "Underlying Q4 rates are about 3% lower than last year.",
        "Hauliers are competing through volume discounts.",
        "Ask for the fuel surcharge to be quoted separately.",
      ],
      actionItems: [],
    },
  },

  {
    n: 18,
    subject: "30% off everything this week only ☕",
    category: "PROMOTION",
    priority: "LOW",
    priorityScore: 11,
    needsReply: false,
    language: "en",
    intent: "BENIGN_MARKETING",
    messages: [
      {
        from: COFFEE,
        to: [SAM],
        minutesAgo: 1 * DAY + 11 * HOUR,
        html: html(
          '<p style="font-size:22px;font-weight:700;margin:0 0 8px;color:#5b3a1e">The autumn blends are back</p>',
          "<p>Restocking the Harvest and Ember roasts. Use <strong>HARVEST30</strong> at checkout for 30% off everything — ends Sunday at midnight.</p>",
          '<p><a href="https://harbourcoffee.example/shop" style="background:#5b3a1e;color:#fff;padding:9px 18px;text-decoration:none;display:inline-block;border-radius:3px">Shop the sale</a></p>',
          '<p><img src="https://harbourcoffee.example/img/autumn-blends.jpg" alt="Autumn coffee blends" width="520"></p>',
          '<p style="font-size:12px;color:#888"><a href="https://harbourcoffee.example/unsubscribe">Unsubscribe</a></p>',
        ),
      },
    ],
  },

  {
    n: 19,
    subject: "Autumn sale: return flights to Lisbon from £89",
    category: "PROMOTION",
    priority: "LOW",
    priorityScore: 9,
    needsReply: false,
    language: "en",
    intent: "BENIGN_MARKETING",
    messages: [
      {
        from: SKYLARK,
        to: [SAM],
        minutesAgo: 2 * DAY + 8 * HOUR,
        html: html(
          '<p style="font-size:22px;font-weight:700;margin:0 0 8px">Autumn sale</p>',
          "<p>Return flights from Gatwick to Lisbon from £89, Porto from £79 and Seville from £95, for travel between 1 November and 12 December.</p>",
          "<p>Book by Monday. Fares include a 10kg cabin bag.</p>",
          '<p><a href="https://skylark-air.example/sale">See all fares</a></p>',
          '<p style="font-size:12px;color:#888"><a href="https://skylark-air.example/unsubscribe">Unsubscribe</a></p>',
        ),
      },
    ],
  },

  {
    n: 20,
    subject: "2 vehicles are due for inspection this month",
    category: "NOTIFICATION",
    priority: "LOW",
    priorityScore: 27,
    needsReply: false,
    language: "en",
    intent: "BENIGN_TRANSACTIONAL",
    messages: [
      {
        from: FLEETWATCH,
        to: [SAM],
        minutesAgo: 3 * DAY + 1 * HOUR,
        isRead: true,
        text: "NW-14 has an MOT certificate expiring on 24 October.\n\nBook an inspection slot from your Fleetwatch dashboard.",
      },
      {
        from: FLEETWATCH,
        to: [SAM],
        minutesAgo: 1 * DAY + 20 * HOUR,
        text: "NW-14 and NW-22 have certificates expiring before 31 October. Book a slot from the dashboard.\n\nThis is an automated reminder. Replies to this address are not read.",
      },
    ],
  },

  {
    n: 21,
    subject: "Your September payslip is ready",
    category: "FINANCE",
    priority: "NORMAL",
    priorityScore: 34,
    needsReply: false,
    language: "en",
    intent: "BENIGN_TRANSACTIONAL",
    messages: [
      {
        from: PAYROLL,
        to: [SAM],
        minutesAgo: 2 * DAY + 2 * HOUR,
        isRead: true,
        text: "Hello Sam,\n\nYour payslip for September is now available in the Pennant employee portal. For your security, payslips are never attached to email.\n\nPennant Payroll, on behalf of Northwind Freight Ltd",
      },
    ],
  },

  {
    n: 22,
    subject: "Your statement for account ending 4417 is ready",
    category: "FINANCE",
    priority: "LOW",
    priorityScore: 28,
    needsReply: false,
    language: "en",
    intent: "BENIGN_TRANSACTIONAL",
    messages: [
      {
        from: BANK,
        to: [SAM],
        minutesAgo: 4 * DAY,
        isRead: true,
        text: "Your monthly statement for the business account ending 4417 is ready to view when you sign in to online banking.\n\nWe will never ask for your password, PIN or a one-time code by email.\n\nAllder Bank",
      },
    ],
  },

  {
    n: 23,
    subject: "Expense report approved: September travel",
    category: "NOTIFICATION",
    priority: "LOW",
    priorityScore: 24,
    needsReply: false,
    language: "en",
    intent: "BENIGN_TRANSACTIONAL",
    messages: [
      {
        from: TALLYHO,
        to: [SAM],
        minutesAgo: 1 * DAY + 9 * HOUR,
        isRead: true,
        text: 'Your expense report "September travel" (£312.40) was approved by Inês Duarte and will be paid with the next payroll run.',
      },
    ],
  },

  {
    n: 24,
    subject: "Ravi Menon and 3 others commented on your post",
    category: "SOCIAL",
    priority: "LOW",
    priorityScore: 12,
    needsReply: false,
    language: "en",
    intent: "BENIGN_MARKETING",
    messages: [
      {
        from: LINKLINE,
        to: [SAM],
        minutesAgo: 10 * HOUR,
        html: html(
          "<p><strong>Ravi Menon</strong> and 3 others commented on your post “Hiring: two HGV drivers for our Dover depot”.</p>",
          "<p>“Shared with a couple of people who might be interested.”</p>",
          '<p><a href="https://linkline.example/posts/8812">See the comments</a></p>',
          '<p style="font-size:12px;color:#888"><a href="https://linkline.example/settings/notifications">Notification settings</a></p>',
        ),
      },
    ],
  },

  {
    n: 25,
    subject: "Appointment reminder: Tuesday 8 October, 08:30",
    category: "PERSONAL",
    priority: "NORMAL",
    priorityScore: 33,
    needsReply: false,
    language: "en",
    intent: "BENIGN_TRANSACTIONAL",
    messages: [
      {
        from: DENTIST,
        to: [SAM],
        minutesAgo: 11 * HOUR,
        text: "Hello Sam,\n\nThis is a reminder of your check-up with Dr Aziz on Tuesday 8 October at 08:30.\n\nIf you need to move it, please call us at least 24 hours before.\n\nCastle Street Dental",
      },
    ],
  },

  {
    n: 26,
    subject: "Book club — October pick",
    category: "PERSONAL",
    priority: "LOW",
    priorityScore: 26,
    needsReply: false,
    language: "en",
    intent: "BENIGN_PERSONAL",
    messages: [
      {
        from: HANNAH,
        to: [SAM],
        minutesAgo: 1 * DAY + 14 * HOUR,
        isRead: true,
        text: "Hi all,\n\nThe votes are in and October's book is The Lighthouse Keepers. We are meeting at mine on the 29th, 7.30pm. Bring something to drink.\n\nHannah",
      },
    ],
  },
];

/* ── Everything else the pages show ─────────────────────────────────────────────── */

export interface DemoScheduled {
  n: number;
  /** A reply into this thread, or a new message when absent. */
  threadN?: number;
  to: DemoPerson[];
  subject: string;
  body: string;
  /** Days from the reset, and the wall-clock time in `DEMO_TIMEZONE`. */
  inDays: number;
  at: string;
  expectsReply?: boolean;
}

/** The zone the demo user lives in. The scheduled times are wall clocks in it. */
export const DEMO_TIMEZONE = "Europe/London";

export const DEMO_SCHEDULED: readonly DemoScheduled[] = [
  {
    n: 1,
    threadN: 8,
    to: [INES],
    subject: "Re: Team offsite — venue shortlist",
    body: "Hi Inês,\n\nHartwell Barn for me as well. Either date works, but the 13th would avoid month-end.\n\nSam",
    inDays: 1,
    at: "09:00",
  },
  {
    n: 2,
    to: [MARCUS],
    subject: "Chilled freight quote — any questions?",
    body: "Hi Marcus,\n\nJust checking the quote reached you. The rate holds until 15 October, and I am happy to adjust the pallet count if your volumes are still settling.\n\nBest,\nSam",
    inDays: 2,
    at: "08:30",
    expectsReply: true,
  },
];

export interface DemoReminder {
  n: number;
  threadN: number;
  reason: string;
  /** Minutes before the reset that the reminder came due. */
  dueMinutesAgo: number;
  status: "PENDING" | "TRIGGERED";
}

export const DEMO_REMINDERS: readonly DemoReminder[] = [
  {
    n: 1,
    threadN: 13,
    reason: "No reply to the chilled freight quote yet.",
    dueMinutesAgo: 1 * DAY + 2 * HOUR,
    status: "TRIGGERED",
  },
  {
    n: 2,
    threadN: 14,
    reason: "Waiting on the landlord about the roof repairs.",
    dueMinutesAgo: 2 * HOUR,
    status: "PENDING",
  },
];

/** The writing-style profile every live draft is written with. */
export const DEMO_WRITING_STYLE = {
  greeting: "Hi <name>,",
  signOff: "Sam",
  formality: "neutral",
  avgSentenceLen: 14,
  usesEmoji: false,
  descriptor:
    "Direct and friendly. Short paragraphs, gets to the decision in the first line, confirms deadlines explicitly, and signs off with just 'Sam'.",
  sampleCount: 30,
} as const;
