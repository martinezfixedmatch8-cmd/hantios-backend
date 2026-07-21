import request from "supertest";
import { app } from "../../src/app";

export function extractCookiePair(setCookieHeader: string[], name: string): { header: string; value: string } {
  const line = setCookieHeader.find((c) => c.startsWith(`${name}=`));
  if (!line) throw new Error(`cookie ${name} not found in ${JSON.stringify(setCookieHeader)}`);
  const header = line.split(";")[0];
  return { header, value: header.split("=")[1] };
}

export async function loginAndGetCookies(email: string, password: string, deviceId: string, rememberMe = false) {
  const res = await request(app)
    .post("/auth/login")
    .set("X-Device-Id", deviceId)
    .send({ email, password, rememberMe });
  const setCookie = res.headers["set-cookie"] as unknown as string[];
  const refresh = extractCookiePair(setCookie, "refresh_token");
  const csrf = extractCookiePair(setCookie, "csrf_token");
  return { refresh, csrf };
}
