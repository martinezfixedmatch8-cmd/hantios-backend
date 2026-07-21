import { randomUUID } from "crypto";
import type { GoogleAuthProvider, GoogleIdentity } from "../../src/lib/googleAuth";
import { unauthorized } from "../../src/lib/errors";

// Test double for GoogleAuthProvider -- avoids hitting Google's network in tests.
// verifyIdToken treats the "idToken" as an opaque key into a preregistered identity map,
// so tests can simulate a real Google identity without a real token.
export class FakeGoogleAuthProvider implements GoogleAuthProvider {
  private identities = new Map<string, GoogleIdentity>();

  registerIdentity(idToken: string, identity: Partial<GoogleIdentity> = {}): GoogleIdentity {
    const full: GoogleIdentity = {
      sub: identity.sub ?? randomUUID(),
      email: identity.email ?? `google-${randomUUID()}@example.test`,
      emailVerified: identity.emailVerified ?? true,
      name: identity.name ?? "Google Test User",
    };
    this.identities.set(idToken, full);
    return full;
  }

  async verifyIdToken(idToken: string): Promise<GoogleIdentity> {
    const identity = this.identities.get(idToken);
    if (!identity) {
      // Matches the real provider's behavior for an invalid/unverifiable token.
      throw unauthorized("Invalid Google credential");
    }
    return identity;
  }
}
