import { createHmac } from "node:crypto";

/**
 * What the App answers a bridge's challenge with: proof that it holds the runtime token, without the token being
 * sent. Left by an App that crashed, a runtime file's port can be another program's by now (its pid taken over by
 * another process after a restart), and the bridge sent that program the token, the reader's captures, and took
 * its replies for adopted principles to hand the agent.
 */
export const runtimeIdentityProof = (token: string, nonce: string): string =>
  createHmac("sha256", token).update(`decision-runtime-identity\n${nonce}`, "utf8").digest("base64url");
