import { describe, expect, it } from "vitest";
import {
  assertValidTimeZone,
  isValidTimeZone,
  offsetMinutesAt,
  utcToZonedWallTime,
  zonedWallTimeToUtc,
} from "./timezone.js";
import { BadRequestError } from "./errors.js";

/**
 * Wall clock to instant, in a named zone.
 *
 * These are the tests that make "store the IANA timezone, never an offset" (§9) mean
 * something. The cases that matter are all on or around a DST boundary, because that is
 * where an offset and a zone give different answers — and a scheduler that is an hour
 * out twice a year is a broken scheduler, not a rounding error.
 *
 * Fixed zones and fixed dates: these assertions depend on the tz database, and the rules
 * for 2026 in these zones are long settled.
 */

describe("zone validation", () => {
  it("accepts a real IANA zone", () => {
    expect(isValidTimeZone("Africa/Tunis")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejects an offset masquerading as a zone", () => {
    /*
     * The whole point of §9. "+01:00" is a fact about one moment, and a scheduler that
     * accepted it would silently lose the rule it needs in October — so it must not be
     * storable as a timezone at all.
     */
    expect(isValidTimeZone("+01:00")).toBe(false);
    expect(isValidTimeZone("GMT+1")).toBe(false);
  });

  it("rejects nonsense and the empty string", () => {
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
  });

  it("refuses an unknown zone with a 400 rather than deferring the failure", () => {
    // A zone we cannot resolve is a 9am we cannot compute. Failing here means the user
    // is told; failing when the send is due means nobody is.
    expect(() => assertValidTimeZone("Mars/Olympus_Mons")).toThrow(BadRequestError);
  });
});

describe("offsetMinutesAt", () => {
  it("reads the winter and summer offsets of the same zone", () => {
    const winter = new Date("2026-01-15T12:00:00Z");
    const summer = new Date("2026-07-15T12:00:00Z");

    // Tunis is UTC+1 all year; New York moves.
    expect(offsetMinutesAt(winter, "Africa/Tunis")).toBe(60);
    expect(offsetMinutesAt(summer, "Africa/Tunis")).toBe(60);
    expect(offsetMinutesAt(winter, "America/New_York")).toBe(-300);
    expect(offsetMinutesAt(summer, "America/New_York")).toBe(-240);
  });
});

describe("zonedWallTimeToUtc", () => {
  it("resolves a plain morning in a zone with no DST", () => {
    expect(zonedWallTimeToUtc("2026-09-20T09:00", "Africa/Tunis").toISOString()).toBe(
      "2026-09-20T08:00:00.000Z",
    );
  });

  it("resolves the same wall time to different instants either side of a DST change", () => {
    /*
     * This is the assertion the feature exists for. 9am in New York is 13:00Z in
     * October and 14:00Z in November, and the only thing that knows which is the zone.
     * An offset captured in October and stored would send the November mail an hour
     * early, every year, for every user who schedules across the boundary.
     */
    const october = zonedWallTimeToUtc("2026-10-20T09:00", "America/New_York");
    const november = zonedWallTimeToUtc("2026-11-20T09:00", "America/New_York");

    expect(october.toISOString()).toBe("2026-10-20T13:00:00.000Z");
    expect(november.toISOString()).toBe("2026-11-20T14:00:00.000Z");

    // And both really are 9am where the user is, which is the property that matters.
    expect(utcToZonedWallTime(october, "America/New_York")).toBe("2026-10-20T09:00");
    expect(utcToZonedWallTime(november, "America/New_York")).toBe("2026-11-20T09:00");
  });

  it("resolves a time in the hour DST skips to the first moment it arrives", () => {
    /*
     * Spring forward in New York, 2026: 02:00 becomes 03:00, so 02:30 never happens.
     * A scheduler must not throw on this — it is the last Sunday in March, not a
     * pathological input — and "as soon as that time comes round" is 03:30 local,
     * which is 07:30Z.
     */
    const resolved = zonedWallTimeToUtc("2026-03-08T02:30", "America/New_York");
    expect(resolved.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(utcToZonedWallTime(resolved, "America/New_York")).toBe("2026-03-08T03:30");
  });

  it("resolves a repeated hour to the earlier of the two", () => {
    /*
     * Fall back: 01:30 happens twice on 1 November 2026 in New York, at 05:30Z (EDT)
     * and 06:30Z (EST). Earlier is the safer default for a send — the alternative
     * delivers an hour after the user has in mind.
     */
    const resolved = zonedWallTimeToUtc("2026-11-01T01:30", "America/New_York");
    expect(resolved.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("handles a zone on a half-hour offset", () => {
    // Kolkata is UTC+5:30 — the case a naive whole-hour implementation gets wrong.
    expect(zonedWallTimeToUtc("2026-09-20T09:00", "Asia/Kolkata").toISOString()).toBe(
      "2026-09-20T03:30:00.000Z",
    );
  });

  it("handles a zone that is a day ahead", () => {
    expect(zonedWallTimeToUtc("2026-09-20T09:00", "Pacific/Auckland").toISOString()).toBe(
      "2026-09-19T21:00:00.000Z",
    );
  });

  it("refuses an instant where a wall time is required", () => {
    // A `datetime-local` never produces a Z, and accepting one would quietly discard
    // the zone the whole design rests on.
    expect(() => zonedWallTimeToUtc("2026-09-20T09:00:00Z", "Africa/Tunis")).toThrow(
      BadRequestError,
    );
    expect(() => zonedWallTimeToUtc("2026-09-20", "Africa/Tunis")).toThrow(
      BadRequestError,
    );
    expect(() => zonedWallTimeToUtc("2026-13-40T99:99", "Africa/Tunis")).toThrow(
      BadRequestError,
    );
  });
});

describe("utcToZonedWallTime", () => {
  it("round-trips a wall time through an instant and back", () => {
    for (const zone of ["Africa/Tunis", "America/New_York", "Asia/Kolkata", "UTC"]) {
      const wall = "2026-06-15T14:45";
      expect(utcToZonedWallTime(zonedWallTimeToUtc(wall, zone), zone)).toBe(wall);
    }
  });

  it("renders midnight as 00:00 rather than 24:00", () => {
    // ICU renders midnight as hour 24 under `hour12: false` in some locales, which
    // would produce a string no `datetime-local` input accepts.
    const midnight = zonedWallTimeToUtc("2026-09-20T00:00", "Africa/Tunis");
    expect(utcToZonedWallTime(midnight, "Africa/Tunis")).toBe("2026-09-20T00:00");
  });
});
