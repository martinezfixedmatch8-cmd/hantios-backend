import { Router } from "express";
import { searchCountries, getCountryTimezones, searchCurrencies } from "../controllers/reference.controller";

const router = Router();

// Deliberately unauthenticated -- this data is needed by a prospective
// customer picking their country *before* an account exists, same reasoning
// as /auth/signup itself. No business_id scoping applies (it's global
// reference data, not a business resource).
router.get("/countries", searchCountries);
router.get("/countries/:countryCode/timezones", getCountryTimezones);
router.get("/currencies", searchCurrencies);

export default router;
