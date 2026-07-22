import request from "supertest";
import { app } from "../src/app";

describe("Reference API (unauthenticated, global lookup data)", () => {
  describe("GET /reference/countries", () => {
    it("requires no authentication", async () => {
      const res = await request(app).get("/reference/countries");
      expect(res.status).toBe(200);
    });

    it("returns all countries when no search is given", async () => {
      const res = await request(app).get("/reference/countries");
      expect(res.body.data.length).toBeGreaterThan(240);
    });

    it("searches by country name (partial, case-insensitive)", async () => {
      const res = await request(app).get("/reference/countries").query({ search: "som" });
      expect(res.body.data.some((c: { name: string }) => c.name === "Somalia")).toBe(true);
    });

    it("searches by ISO alpha-2", async () => {
      const res = await request(app).get("/reference/countries").query({ search: "SO" });
      expect(res.body.data.some((c: { cca2: string }) => c.cca2 === "SO")).toBe(true);
    });

    it("searches by ISO alpha-3", async () => {
      const res = await request(app).get("/reference/countries").query({ search: "SOM" });
      expect(res.body.data.some((c: { cca3: string }) => c.cca3 === "SOM")).toBe(true);
    });

    it("searches by phone prefix, including ambiguous prefixes shared by multiple countries", async () => {
      const res = await request(app).get("/reference/countries").query({ search: "+1" });
      const names = res.body.data.map((c: { name: string }) => c.name);
      expect(names).toContain("United States");
      expect(names).toContain("Canada");
    });

    it("gives NANP countries (US, Canada, Jamaica, ...) the plain +1 prefix, not an arbitrary area code", async () => {
      // world-countries lists dozens of area codes under `idd.suffixes` for
      // NANP members -- naively appending the first one produces a wrong,
      // misleadingly-specific prefix (e.g. "+1201" instead of "+1" for the US).
      const res = await request(app).get("/reference/countries");
      const us = res.body.data.find((c: { cca2: string }) => c.cca2 === "US");
      const ca = res.body.data.find((c: { cca2: string }) => c.cca2 === "CA");
      expect(us.phonePrefix).toBe("+1");
      expect(ca.phonePrefix).toBe("+1");
    });

    it("returns the expected field set for a known country", async () => {
      const res = await request(app).get("/reference/countries").query({ search: "SO" });
      const somalia = res.body.data.find((c: { cca2: string }) => c.cca2 === "SO");
      expect(somalia).toMatchObject({
        name: "Somalia",
        cca2: "SO",
        cca3: "SOM",
        phonePrefix: "+252",
        currencyCode: "SOS",
        capital: "Mogadishu",
        region: "Africa",
      });
      expect(somalia.flag).toBeTruthy();
      expect(somalia.defaultTimezone).toBeTruthy();
    });
  });

  describe("GET /reference/countries/:countryCode/timezones", () => {
    it("requires no authentication", async () => {
      const res = await request(app).get("/reference/countries/US/timezones");
      expect(res.status).toBe(200);
    });

    it("returns every timezone for a multi-timezone country, with a derived city label", async () => {
      const res = await request(app).get("/reference/countries/US/timezones");
      expect(res.body.data.length).toBeGreaterThan(5);
      const newYork = res.body.data.find((tz: { name: string }) => tz.name === "America/New_York");
      expect(newYork).toBeDefined();
      expect(newYork.city).toBe("New York");
      expect(typeof newYork.utcOffset).toBe("number");
    });

    it("returns exactly one timezone for a single-timezone country", async () => {
      const res = await request(app).get("/reference/countries/SO/timezones");
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe("Africa/Nairobi");
    });

    it("returns 404 for an unknown country code", async () => {
      const res = await request(app).get("/reference/countries/ZZ/timezones");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /reference/currencies", () => {
    it("requires no authentication", async () => {
      const res = await request(app).get("/reference/currencies");
      expect(res.status).toBe(200);
    });

    it("returns all currencies when no search is given", async () => {
      const res = await request(app).get("/reference/currencies");
      expect(res.body.data.length).toBeGreaterThan(100);
    });

    it("searches by currency code and includes decimal precision + symbol", async () => {
      const res = await request(app).get("/reference/currencies").query({ search: "USD" });
      const usd = res.body.data.find((c: { code: string }) => c.code === "USD");
      expect(usd).toMatchObject({ code: "USD", digits: 2 });
      expect(usd.symbol).toBeTruthy();
    });

    it("searches by currency name (partial, case-insensitive)", async () => {
      const res = await request(app).get("/reference/currencies").query({ search: "shilling" });
      expect(res.body.data.some((c: { code: string }) => c.code === "SOS")).toBe(true);
      expect(res.body.data.some((c: { code: string }) => c.code === "KES")).toBe(true);
    });

    it("returns zero-decimal currencies correctly (e.g. JPY)", async () => {
      const res = await request(app).get("/reference/currencies").query({ search: "JPY" });
      const jpy = res.body.data.find((c: { code: string }) => c.code === "JPY");
      expect(jpy).toMatchObject({ code: "JPY", digits: 0 });
    });
  });
});
