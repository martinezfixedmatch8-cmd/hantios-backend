import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import { createInviteSchema, acceptInviteSchema, tokenParamSchema } from "../validation/staffInvite.schema";
import { createStaffInvite, getInvitePreview, acceptStaffInvite } from "../services/staffInvite.service";

export async function createInvite(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const input = createInviteSchema.parse(req.body);
    const invite = await createStaffInvite(input, {
      userId: req.auth.userId,
      businessId: req.auth.businessId,
    });
    res.status(201).json({ data: invite });
  } catch (err) {
    next(err);
  }
}

export async function previewInvite(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { token } = tokenParamSchema.parse(req.params);
    const preview = await getInvitePreview(token);
    res.status(200).json({ data: preview });
  } catch (err) {
    next(err);
  }
}

export async function acceptInvite(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { token } = tokenParamSchema.parse(req.params);
    const input = acceptInviteSchema.parse(req.body);
    const result = await acceptStaffInvite(token, input, {
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });
    res.status(200).json({ data: result, message: "Account activated. Please log in." });
  } catch (err) {
    next(err);
  }
}
