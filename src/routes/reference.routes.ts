import type { Request, Response, NextFunction } from "express";
import { Router } from "express";
import { searchCountries, getCountryTimezones, searchCurrencies } from "../controllers/reference.controller";

const router = Router();

// This module's data (world-countries/countries-and-timezones/currency-codes)
// only ever changes on a deliberate dependency bump + redeploy (see
// CLAUDE.md's "Global Reference Data" section) -- safe to let clients/CDNs
// cache it hard. `public` since these routes are unauthenticated and the
// response never varies by requester. Express's default weak ETag (on by
// default, untouched here) still fires on every response -- a client that
// revalidates past 7 days (or ignores max-age entirely) gets a normal
// conditional-GET 304 against the *current* content, not stale data; the two
// headers are complementary, not redundant (see CLAUDE.md for the fuller
// explanation of how they interact).
function cacheControl(_req: Request, res: Response, next: NextFunction): void {
  res.set("Cache-Control", "public, max-age=604800");
  next();
}

// Deliberately unauthenticated -- this data is needed by a prospective
// customer picking their country *before* an account exists, same reasoning
// as /auth/signup itself. No business_id scoping applies (it's global
// reference data, not a business resource).
router.use(cacheControl);
router.get("/countries", searchCountries);
router.get("/countries/:countryCode/timezones", getCountryTimezones);
router.get("/currencies", searchCurrencies);

export default router;
