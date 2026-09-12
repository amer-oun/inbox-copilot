import { z } from "zod";

export const dependencyHealthSchema = z.object({
  status: z.enum(["up", "down"]),
  /** Round-trip latency of the ping, in milliseconds. */
  latencyMs: z.number().nonnegative(),
  /** Present only when `status` is "down". Never contains connection strings. */
  error: z.string().optional(),
});
export type DependencyHealth = z.infer<typeof dependencyHealthSchema>;

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  checkedAt: z.iso.datetime(),
  dependencies: z.object({
    postgres: dependencyHealthSchema,
    redis: dependencyHealthSchema,
  }),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
