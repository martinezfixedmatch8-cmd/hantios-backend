import type { UserRole } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        businessId: string;
        role: UserRole;
        name: string;
      };
      idempotencyKey?: string;
    }
  }
}

export {};
