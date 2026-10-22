import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = path.join(__dirname, '..', '.keys');

function encodeLength(len) {
  if (len < 128) return Buffer.from([len]);
  const bytes = [];
  let temp = len;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function asn1Tag(tag, content) {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

function asn1Seq(...items) {
  return asn1Tag(0x30, Buffer.concat(items));
}

function asn1Set(...items) {
  return asn1Tag(0x31, Buffer.concat(items));
}

function asn1Oid(oidBytes) {
  return asn1Tag(0x06, Buffer.from(oidBytes));
}

function asn1Utf8(str) {
  return asn1Tag(0x0c, Buffer.from(str, 'utf8'));
}

function asn1UtcTime(date) {
  const s = date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';
  return asn1Tag(0x17, Buffer.from(s, 'ascii'));
}

function asn1BitString(buf) {
  return asn1Tag(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
}

/**
 * Generates a self-signed X.509 v3 certificate in PEM format using pure Node.js crypto.
 */
function createSelfSignedCertPem(privateKey, publicKey) {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  // sha256WithRSAEncryption OID: 1.2.840.113549.1.1.11
  const sigAlg = asn1Seq(
    asn1Oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]),
    Buffer.from([0x05, 0x00])
  );

  // CN=MCP-SAP-IdP (OID 2.5.4.3)
  const cnAttr = asn1Set(
    asn1Seq(asn1Oid([0x55, 0x04, 0x03]), asn1Utf8('MCP-SAP-IdP'))
  );
  const name = asn1Seq(cnAttr);

  const now = new Date(Date.now() - 60_000);
  const exp = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const validity = asn1Seq(asn1UtcTime(now), asn1UtcTime(exp));

  const version = asn1Tag(0xa0, Buffer.from([0x02, 0x01, 0x02])); // v3
  const serial = Buffer.from([0x02, 0x04, 0x01, 0x02, 0x03, 0x04]);

  const tbsCert = asn1Seq(
    version,
    serial,
    sigAlg,
    name,
    validity,
    name,
    spkiDer
  );

  const signer = crypto.createSign('SHA256');
  signer.update(tbsCert);
  const signature = signer.sign(privateKey);

  const certDer = asn1Seq(tbsCert, sigAlg, asn1BitString(signature));
  const b64 = certDer.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

/**
 * Returns a persistent RSA keypair + X.509 Certificate so the MCP Server and
 * Mock SAP Service share the same trusted IdP identity across processes.
 */
export function getIdentityKeys() {
  if (!fs.existsSync(KEYS_DIR)) {
    fs.mkdirSync(KEYS_DIR, { recursive: true });
  }

  const privPath = path.join(KEYS_DIR, 'idp-private.pem');
  const pubPath = path.join(KEYS_DIR, 'idp-public.pem');
  const certPath = path.join(KEYS_DIR, 'idp-cert.pem');

  if (fs.existsSync(privPath) && fs.existsSync(pubPath) && fs.existsSync(certPath)) {
    const privateKeyPem = fs.readFileSync(privPath, 'utf8');
    const publicKeyPem = fs.readFileSync(pubPath, 'utf8');
    const certPem = fs.readFileSync(certPath, 'utf8');
    const certBase64 = certPem
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s+/g, '');
    return { privateKeyPem, publicKeyPem, certPem, certBase64 };
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });

  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const certPem = createSelfSignedCertPem(privateKey, publicKey);

  fs.writeFileSync(privPath, privateKeyPem, 'utf8');
  fs.writeFileSync(pubPath, publicKeyPem, 'utf8');
  fs.writeFileSync(certPath, certPem, 'utf8');

  const certBase64 = certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');

  return { privateKeyPem, publicKeyPem, certPem, certBase64 };
}

