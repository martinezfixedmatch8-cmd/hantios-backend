import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as referenceService from "../services/referenceLookup.service";

const searchQuerySchema = z.object({ search: z.string().trim().optional().default("") });
const countryCodeParamSchema = z.object({ countryCode: z.string().trim().length(2).toUpperCase() });

export function searchCountries(req: Request, res: Response, next: NextFunction): void {
  try {
    const { search } = searchQuerySchema.parse(req.query);
    res.status(200).json({ data: referenceService.searchCountries(search) });
  } catch (err) {
    next(err);
  }
}

export function getCountryTimezones(req: Request, res: Response, next: NextFunction): void {
  try {
    const { countryCode } = countryCodeParamSchema.parse(req.params);
    res.status(200).json({ data: referenceService.getCountryTimezoneList(countryCode) });
  } catch (err) {
    next(err);
  }
}

export function searchCurrencies(req: Request, res: Response, next: NextFunction): void {
  try {
    const { search } = searchQuerySchema.parse(req.query);
    res.status(200).json({ data: referenceService.searchCurrencyReference(search) });
  } catch (err) {
    next(err);
  }
}
