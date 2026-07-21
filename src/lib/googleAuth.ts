import { OAuth2Client } from "google-auth-library";
import { env } from "./config";
import { unauthorized } from "./errors";

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

export interface GoogleAuthProvider {
  verifyIdToken(idToken: string): Promise<GoogleIdentity>;
}

class GoogleAuthLibraryProvider implements GoogleAuthProvider {
  private client = new OAuth2Client(env.GOOGLE_CLIENT_ID);

  async verifyIdToken(idToken: string): Promise<GoogleIdentity> {
    let ticket;
    try {
      ticket = await this.client.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
    } catch {
      throw unauthorized("Invalid Google credential");
    }
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) {
      throw unauthorized("Invalid Google credential");
    }
    return {
      sub: payload.sub,
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified ?? false,
      name: payload.name ?? payload.email,
    };
  }
}

let provider: GoogleAuthProvider = new GoogleAuthLibraryProvider();

export function getGoogleAuthProvider(): GoogleAuthProvider {
  return provider;
}

// DI seam so tests can inject a fake identity instead of hitting Google's network --
// same pattern as src/notifications/registry.ts.
export function setGoogleAuthProvider(next: GoogleAuthProvider): void {
  provider = next;
}
