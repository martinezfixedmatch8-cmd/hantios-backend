import { renderTemplate, isSupportedLanguage } from "../src/lib/messageTemplates";

const variables = { productName: "Sugar 1kg", quantity: "3", minStockLevel: "10", branchName: "Main Branch" };

describe("isSupportedLanguage", () => {
  it("accepts all 5 launch languages", () => {
    for (const lang of ["en", "so", "ar", "fr", "es"]) {
      expect(isSupportedLanguage(lang)).toBe(true);
    }
  });

  it("rejects an unsupported language", () => {
    expect(isSupportedLanguage("de")).toBe(false);
  });
});

describe("renderTemplate", () => {
  it("renders low_stock_alert in all 5 launch languages, each containing the variables", () => {
    for (const lang of ["en", "so", "ar", "fr", "es"] as const) {
      const body = renderTemplate("low_stock_alert", lang, variables);
      expect(body).toContain(variables.productName);
      expect(body).toContain(variables.quantity);
      expect(body).toContain(variables.minStockLevel);
      expect(body).toContain(variables.branchName);
    }
  });

  it("renders stock_recovered in all 5 launch languages, each containing the variables", () => {
    for (const lang of ["en", "so", "ar", "fr", "es"] as const) {
      const body = renderTemplate("stock_recovered", lang, variables);
      expect(body).toContain(variables.productName);
      expect(body).toContain(variables.quantity);
      expect(body).toContain(variables.minStockLevel);
      expect(body).toContain(variables.branchName);
    }
  });

  it("falls back to English for an unsupported language rather than throwing", () => {
    const body = renderTemplate("low_stock_alert", "de", variables);
    expect(body).toBe(renderTemplate("low_stock_alert", "en", variables));
  });

  it("throws for an unknown template key", () => {
    expect(() => renderTemplate("nonexistent_template" as never, "en", variables)).toThrow(/Unknown message template/);
  });

  it("never includes a color/severity field in rendered output (backend emits severity enum only, not color)", () => {
    for (const lang of ["en", "so", "ar", "fr", "es"] as const) {
      const body = renderTemplate("low_stock_alert", lang, variables);
      expect(body.toLowerCase()).not.toMatch(/#[0-9a-f]{3,6}\b/);
    }
  });
});
