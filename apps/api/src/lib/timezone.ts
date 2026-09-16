import { BadRequestError } from "./errors.js";

/**
 * Wall-clock time in a named zone, and back (§9).
 *
 * §9 says store the user's IANA timezone, never an offset. This module is why that
 * instruction is worth following, and what it costs.
 *
 * An offset is a fact about one moment. `+01:00` was true in Tunis in June and is a
 * lie about it in January, so a "send at 9am daily" stored as an offset drifts by an
 * hour twice a year — and worse, an offset stored once for a *single* future send is
 * wrong whenever the boundary moves between scheduling and sending. Zones are the
 * rule rather than the reading, so the rule is what we keep.
 *
 * No library. `Intl.DateTimeFormat` already ships the tz database in Node, and the
 * one operation it does not offer directly — wall clock in a zone to an instant — is
 * a fixed-point search over the one it does offer, which is what `offsetAt` and
 * `zonedWallTimeToUtc` are.
 */

/** Cached formatters. Constructing one is not cheap and the zones repeat. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const existing = formatters.get(timeZone);
  if (existing !== undefined) return existing;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatters.set(timeZone, formatter);
  return formatter;
}

/**
 * Whether Node recognizes this as an IANA zone.
 *
 * The check is "does the runtime's tz database have it", not a regex over the name.
 * A zone we cannot resolve is a zone whose 9am we cannot compute, and storing it
 * would defer the failure to the moment the send is due — at which point there is
 * nobody to ask.
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    const resolved = formatterFor(timeZone).resolvedOptions().timeZone;
    /*
     * ICU accepts an *offset* as a time zone — `new Intl.DateTimeFormat("en-US", {
     * timeZone: "+01:00" })` constructs happily and resolves to "+01:00". Accepting
     * that would quietly defeat the whole §9 rule: the column would hold a fact about
     * one moment where the rule is required, and a 9am scheduled in July would send at
     * 8am in January with nothing anywhere recording that anything was lost.
     *
     * So an offset is refused by identity rather than by pattern-matching the input:
     * whatever the caller wrote, if what ICU resolved is an offset, it is not a zone.
     */
    return !/^[+-]/.test(resolved);
  } catch {
    // RangeError from ICU for an unknown zone. Also guards the empty string.
    return false;
  }
}

/** Throws a 400 rather than letting an unknown zone reach the database. */
export function assertValidTimeZone(timeZone: string): void {
  if (!isValidTimeZone(timeZone)) {
    throw new BadRequestError(`Unknown time zone: ${timeZone}`);
  }
}

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock reading in `timeZone` at a given instant. */
function partsAt(instant: Date, timeZone: string): WallParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part === undefined ? 0 : Number(part.value);
  };

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    // ICU renders midnight as hour 24 in some locales under hour12:false.
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second"),
  };
}

/**
 * The zone's offset from UTC at an instant, in minutes.
 *
 * Derived by asking what the clock reads there and comparing it with the same
 * reading interpreted as UTC. That is the trick this whole module rests on: the
 * platform will tell us the wall time at an instant, and this inverts it.
 */
export function offsetMinutesAt(instant: Date, timeZone: string): number {
  const parts = partsAt(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // Seconds resolution: the formatter has no milliseconds, so compare at that grain.
  return (asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000;
}

/** `YYYY-MM-DDTHH:mm` -> its five numbers, or null when it is not that shape. */
function parseWallClock(wall: string): WallParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(wall);
  if (match === null) return null;

  const [, year, month, day, hour, minute] = match;
  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: 0,
  };

  if (parts.month < 1 || parts.month > 12) return null;
  if (parts.day < 1 || parts.day > 31) return null;
  if (parts.hour > 23 || parts.minute > 59) return null;
  return parts;
}

/**
 * Resolves `"2026-10-25T09:00"` in `timeZone` to the instant it names.
 *
 * Two passes, because the offset depends on the answer: guess the instant by reading
 * the wall time as UTC, look up the zone's offset *there*, correct, and look it up
 * again in case the correction crossed a transition. A third pass would change
 * nothing — no zone has two transitions within a day.
 *
 * The two awkward cases are handled rather than ignored, because a scheduler that
 * throws on the last Sunday in March is a scheduler that fails twice a year:
 *
 *   - **Spring forward** removes the hour. `02:30` on that date does not exist, and
 *     the two passes converge on 01:30 — an hour *before* what was asked for, which for
 *     a send is the wrong direction to be wrong in. The round-trip check at the bottom
 *     detects that (the instant does not read back as the requested wall time) and
 *     returns the first guess instead, which lands at 03:30: the first moment that wall
 *     time can be said to have arrived.
 *   - **Fall back** repeats it. `01:30` happens twice, and this resolves to the
 *     first — earlier is the safer of two defensible answers for a send, because the
 *     alternative is mail arriving an hour later than the user has in mind.
 */
export function zonedWallTimeToUtc(wall: string, timeZone: string): Date {
  assertValidTimeZone(timeZone);

  const parts = parseWallClock(wall);
  if (parts === null) {
    throw new BadRequestError(`Expected a YYYY-MM-DDTHH:mm local time, got: ${wall}`);
  }

  const naive = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    0,
    0,
  );

  const firstGuess = new Date(naive - offsetMinutesAt(new Date(naive), timeZone) * 60_000);
  const corrected = new Date(naive - offsetMinutesAt(firstGuess, timeZone) * 60_000);

  if (Number.isNaN(corrected.getTime())) {
    throw new BadRequestError(`Could not resolve ${wall} in ${timeZone}`);
  }

  /*
   * If the corrected instant does not read back as the wall time we were asked for,
   * that wall time does not exist — it is inside the hour a spring-forward removes. The
   * fixed point the correction converges on is then *before* the gap, which would send
   * the mail an hour early; `firstGuess` used the pre-transition offset and lands at the
   * first moment after it. Later is the right side to err on for a send.
   */
  if (utcToZonedWallTime(corrected, timeZone) !== wall) return firstGuess;

  return corrected;
}

/**
 * The reverse: the wall clock `instant` shows in `timeZone`, as `YYYY-MM-DDTHH:mm`.
 *
 * Used to record what the user chose when they gave us an instant instead, and by the
 * UI to say "9:00 in Africa/Tunis" rather than a UTC timestamp the reader has to do
 * arithmetic on.
 */
export function utcToZonedWallTime(instant: Date, timeZone: string): string {
  assertValidTimeZone(timeZone);
  const parts = partsAt(instant, timeZone);
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}
