import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { SignedXml } from 'xml-crypto';
import { DOMParser } from '@xmldom/xmldom';
import { getIdentityKeys } from './cryptoKeys.js';

export const IDP_ISSUER = 'https://mcp-idp.enterprise.local';
export const SAP_AUDIENCE = 'https://sap-s4hana.enterprise.local/sap/bc/sec/oauth2/token';
export const SAP_RECIPIENT = 'https://sap-s4hana.enterprise.local/sap/opu/odata/sap';

function escapeXml(unsafe) {
  return String(unsafe ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Step 1: Create a signed RS256 JWT token representing the authenticated user and their intent.
 */
export function createJwtToken({
  userId = 'ELDIEBELDIE',
  email = 'eldiebeldie@enterprise.local',
  sapClient = '100',
  roles = ['SAP_SD_SALES_ORDER_CREATE', 'SAP_MM_PURCHASE_DISPLAY'],
  userRequest = {
    action: 'GET_SALES_ORDERS',
    parameters: { customer: 'CUST-1001', top: 5 },
  },
  expiresInSeconds = 300,
}) {
  const { privateKeyPem } = getIdentityKeys();

  const payload = {
    sub: userId,
    email,
    sap_client: sapClient,
    roles,
    sap_request: userRequest,
  };

  const token = jwt.sign(payload, privateKeyPem, {
    algorithm: 'RS256',
    issuer: IDP_ISSUER,
    audience: SAP_AUDIENCE,
    expiresIn: expiresInSeconds,
    jwtid: `jwt_${crypto.randomUUID()}`,
  });

  const decoded = jwt.decode(token, { complete: true });
  return {
    token,
    claims: decoded.payload,
    header: decoded.header,
  };
}

/**
 * Step 2: Validate a JWT token and convert its principal & claims into a
 * cryptographically signed SAML 2.0 Bearer Assertion (XML + Base64) for SAP.
 */
export function convertJwtToSaml(jwtToken) {
  const { privateKeyPem, publicKeyPem, certBase64 } = getIdentityKeys();

  // 1. Verify the incoming JWT first
  const decoded = jwt.verify(jwtToken, publicKeyPem, {
    algorithms: ['RS256'],
    issuer: IDP_ISSUER,
  });

  const assertionId = `_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = new Date();
  const notBefore = new Date(now.getTime() - 30 * 1000).toISOString();
  const notOnOrAfter = new Date(decoded.exp * 1000).toISOString();
  const issueInstant = now.toISOString();

  const userId = decoded.sub;
  const email = decoded.email || `${userId}@enterprise.local`;
  const sapClient = decoded.sap_client || '100';
  const roles = Array.isArray(decoded.roles) ? decoded.roles : [];
  const sapRequestJson = JSON.stringify(decoded.sap_request || {});

  // 2. Construct unsigned SAML 2.0 Assertion following OASIS & SAP OAuth2SAMLBearerAssertion profile
  const unsignedXml =
    `<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="${escapeXml(assertionId)}" IssueInstant="${escapeXml(issueInstant)}" Version="2.0">` +
    `<saml2:Issuer>${escapeXml(IDP_ISSUER)}</saml2:Issuer>` +
    `<saml2:Subject>` +
    `<saml2:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${escapeXml(userId)}</saml2:NameID>` +
    `<saml2:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml2:SubjectConfirmationData NotOnOrAfter="${escapeXml(notOnOrAfter)}" Recipient="${escapeXml(SAP_RECIPIENT)}"/>` +
    `</saml2:SubjectConfirmation>` +
    `</saml2:Subject>` +
    `<saml2:Conditions NotBefore="${escapeXml(notBefore)}" NotOnOrAfter="${escapeXml(notOnOrAfter)}">` +
    `<saml2:AudienceRestriction>` +
    `<saml2:Audience>${escapeXml(SAP_AUDIENCE)}</saml2:Audience>` +
    `</saml2:AudienceRestriction>` +
    `</saml2:Conditions>` +
    `<saml2:AuthnStatement AuthnInstant="${escapeXml(issueInstant)}" SessionIndex="${escapeXml(decoded.jti || assertionId)}">` +
    `<saml2:AuthnContext>` +
    `<saml2:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PreviousSession</saml2:AuthnContextClassRef>` +
    `</saml2:AuthnContext>` +
    `</saml2:AuthnStatement>` +
    `<saml2:AttributeStatement>` +
    `<saml2:Attribute Name="sap_user_id"><saml2:AttributeValue>${escapeXml(userId)}</saml2:AttributeValue></saml2:Attribute>` +
    `<saml2:Attribute Name="email"><saml2:AttributeValue>${escapeXml(email)}</saml2:AttributeValue></saml2:Attribute>` +
    `<saml2:Attribute Name="sap_client"><saml2:AttributeValue>${escapeXml(sapClient)}</saml2:AttributeValue></saml2:Attribute>` +
    `<saml2:Attribute Name="roles"><saml2:AttributeValue>${escapeXml(roles.join(','))}</saml2:AttributeValue></saml2:Attribute>` +
    `<saml2:Attribute Name="user_request"><saml2:AttributeValue>${escapeXml(sapRequestJson)}</saml2:AttributeValue></saml2:Attribute>` +
    `</saml2:AttributeStatement>` +
    `</saml2:Assertion>`;

  // 3. Sign the SAML Assertion using Enveloped XML-DSig (RSA-SHA256 + Exclusive C14N)
  const sig = new SignedXml({
    privateKey: privateKeyPem,
    publicCert: `-----BEGIN CERTIFICATE-----\n${certBase64}\n-----END CERTIFICATE-----`,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    getKeyInfoContent: () =>
      `<X509Data><X509Certificate>${certBase64}</X509Certificate></X509Data>`,
  });

  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });

  sig.computeSignature(unsignedXml, {
    location: { reference: "//*[local-name(.)='Issuer']", action: 'after' },
  });

  const signedXml = sig.getSignedXml();
  const samlBase64 = Buffer.from(signedXml, 'utf8').toString('base64');
  const samlBase64Url = Buffer.from(signedXml, 'utf8').toString('base64url');

  return {
    assertionId,
    issuer: IDP_ISSUER,
    audience: SAP_AUDIENCE,
    subjectNameId: userId,
    notBefore,
    notOnOrAfter,
    signedXml,
    samlBase64,
    samlBase64Url,
  };
}

/**
 * Step 3 (SAP side): Verify XML-DSig signature on the SAML 2.0 Assertion
 * and extract the authenticated SAP user + user request attributes.
 */
export function verifyAndParseSamlAssertion(samlInput) {
  const { certPem } = getIdentityKeys();

  // Accept either raw XML or Base64 / Base64URL encoded SAML assertion
  const xmlString = samlInput.trim().startsWith('<')
    ? samlInput.trim()
    : Buffer.from(samlInput, 'base64').toString('utf8');

  const doc = new DOMParser().parseFromString(xmlString, 'text/xml');

  const signatureNodes = doc.getElementsByTagNameNS(
    'http://www.w3.org/2000/09/xmldsig#',
    'Signature'
  );
  if (!signatureNodes || signatureNodes.length === 0) {
    throw new Error('SAML Assertion is missing an XML-DSig <Signature> element.');
  }

  const sig = new SignedXml({
    publicCert: certPem,
  });
  sig.loadSignature(signatureNodes[0]);
  const isValid = sig.checkSignature(xmlString);
  if (!isValid) {
    throw new Error('Invalid SAML 2.0 XML signature.');
  }

  // Extract Assertion metadata & Subject NameID
  const assertionNode = doc.getElementsByTagNameNS(
    'urn:oasis:names:tc:SAML:2.0:assertion',
    'Assertion'
  )[0];
  const assertionId = assertionNode?.getAttribute('ID') || 'unknown';

  const issuerNode = doc.getElementsByTagNameNS(
    'urn:oasis:names:tc:SAML:2.0:assertion',
    'Issuer'
  )[0];
  const issuer = issuerNode?.textContent?.trim();

  const nameIdNode = doc.getElementsByTagNameNS(
    'urn:oasis:names:tc:SAML:2.0:assertion',
    'NameID'
  )[0];
  const nameId = nameIdNode?.textContent?.trim();

  const conditionsNode = doc.getElementsByTagNameNS(
    'urn:oasis:names:tc:SAML:2.0:assertion',
    'Conditions'
  )[0];
  const notBefore = conditionsNode?.getAttribute('NotBefore');
  const notOnOrAfter = conditionsNode?.getAttribute('NotOnOrAfter');

  const now = Date.now();
  if (notBefore && now < Date.parse(notBefore) - 5000) {
    throw new Error(`SAML Assertion is not valid yet (NotBefore: ${notBefore})`);
  }
  if (notOnOrAfter && now >= Date.parse(notOnOrAfter) + 5000) {
    throw new Error(`SAML Assertion has expired (NotOnOrAfter: ${notOnOrAfter})`);
  }

  // Extract AttributeStatement attributes
  const attributes = {};
  const attrNodes = doc.getElementsByTagNameNS(
    'urn:oasis:names:tc:SAML:2.0:assertion',
    'Attribute'
  );
  for (let i = 0; i < attrNodes.length; i++) {
    const attr = attrNodes[i];
    const name = attr.getAttribute('Name');
    const valNode = attr.getElementsByTagNameNS(
      'urn:oasis:names:tc:SAML:2.0:assertion',
      'AttributeValue'
    )[0];
    if (name && valNode) {
      attributes[name] = valNode.textContent || '';
    }
  }

  let parsedUserRequest = null;
  if (attributes.user_request) {
    try {
      parsedUserRequest = JSON.parse(attributes.user_request);
    } catch {
      parsedUserRequest = { raw: attributes.user_request };
    }
  }

  return {
    verified: true,
    assertionId,
    issuer,
    nameId,
    notBefore,
    notOnOrAfter,
    sapClient: attributes.sap_client || '100',
    email: attributes.email || '',
    roles: attributes.roles ? attributes.roles.split(',').filter(Boolean) : [],
    userRequest: parsedUserRequest,
    attributes,
  };
}

