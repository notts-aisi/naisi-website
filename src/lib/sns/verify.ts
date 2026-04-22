import "server-only";
import crypto from "node:crypto";

export type SnsMessage = {
  Type: string;
  MessageId: string;
  Message: string;
  Timestamp: string;
  TopicArn: string;
  Signature: string;
  SigningCertURL: string;
  SignatureVersion: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
  UnsubscribeURL?: string;
};

/**
 * Canonical signing string per AWS docs. Field order differs between
 * Notification and *Confirmation message types. Each line is "Key\nValue\n".
 * https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 */
function canonicalString(m: SnsMessage): string {
  const pairs: Array<[string, string]> = [];
  if (m.Type === "Notification") {
    pairs.push(["Message", m.Message]);
    pairs.push(["MessageId", m.MessageId]);
    if (m.Subject !== undefined) pairs.push(["Subject", m.Subject]);
    pairs.push(["Timestamp", m.Timestamp]);
    pairs.push(["TopicArn", m.TopicArn]);
    pairs.push(["Type", m.Type]);
  } else if (
    m.Type === "SubscriptionConfirmation" ||
    m.Type === "UnsubscribeConfirmation"
  ) {
    pairs.push(["Message", m.Message]);
    pairs.push(["MessageId", m.MessageId]);
    pairs.push(["SubscribeURL", m.SubscribeURL ?? ""]);
    pairs.push(["Timestamp", m.Timestamp]);
    pairs.push(["Token", m.Token ?? ""]);
    pairs.push(["TopicArn", m.TopicArn]);
    pairs.push(["Type", m.Type]);
  } else {
    throw new Error(`Unsupported SNS message type: ${m.Type}`);
  }
  return pairs.map(([k, v]) => `${k}\n${v}\n`).join("");
}

function isTrustedSigningUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      u.hostname.endsWith(".amazonaws.com") &&
      u.hostname.startsWith("sns.")
    );
  } catch {
    return false;
  }
}

const certCache = new Map<string, string>();

async function fetchCert(url: string): Promise<string> {
  const cached = certCache.get(url);
  if (cached) return cached;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SNS cert fetch failed: ${res.status}`);
  const pem = await res.text();
  certCache.set(url, pem);
  return pem;
}

export async function verifySnsMessage(m: SnsMessage): Promise<boolean> {
  if (!m.Signature || !m.SigningCertURL) return false;
  if (!isTrustedSigningUrl(m.SigningCertURL)) return false;

  const canonical = canonicalString(m);
  const cert = await fetchCert(m.SigningCertURL);
  const algorithm = m.SignatureVersion === "2" ? "SHA256" : "SHA1";
  const verifier = crypto.createVerify(algorithm);
  verifier.update(canonical, "utf8");
  return verifier.verify(cert, m.Signature, "base64");
}
