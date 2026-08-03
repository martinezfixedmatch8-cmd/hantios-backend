import { z } from "zod";

export const setDeadlineSchema = z.object({
  version: z.number().int().nonnegative(),
  respondBy: z.string().datetime().nullable(),
});
export type SetDeadlineInput = z.infer<typeof setDeadlineSchema>;
