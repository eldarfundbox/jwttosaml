import base64
import copy
import hashlib
import json
import time
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Any
from xml.sax.saxutils import escape

import jwt
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

from src.crypto_keys import get_identity_keys

IDP_ISSUER = "https://mcp-idp.enterprise.local"
SAP_AUDIENCE = "https://sap-s4hana.enterprise.local/sap/bc/sec/oauth2/token"
SAP_RECIPIENT = "https://sap-s4hana.enterprise.local/sap/opu/odata/sap"

SAML2_NS = "urn:oasis:names:tc:SAML:2.0:assertion"
DSIG_NS = "http://www.w3.org/2000/09/xmldsig#"

ET.register_namespace("saml2", SAML2_NS)
ET.register_namespace("ds", DSIG_NS)


def _iso_utc(ts: float) -> str:
    return (
        datetime.fromtimestamp(ts, tz=timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]
        + "Z"
    )


def create_jwt_token(
    user_id: str = "ELDIEBELDIE",
    email: str = "eldiebeldie@enterprise.local",
    sap_client: str = "100",
    roles: list[str] | None = None,
    user_request: dict[str, Any] | None = None,
    expires_in_seconds: int = 300,
) -> dict[str, Any]:
    """
    Step 1: Create a signed RS256 JWT token representing the authenticated user and their SAP request.
    """
    keys = get_identity_keys()
    if roles is None:
        roles = ["SAP_SD_SALES_ORDER_CREATE", "SAP_MM_PURCHASE_DISPLAY"]
    if user_request is None:
        user_request = {
            "action": "GET_SALES_ORDERS",
            "parameters": {"customer": "CUST-1001", "top": 5},
        }

    now = int(time.time())
    jti = f"jwt_{uuid.uuid4()}"

    payload = {
        "sub": user_id,
        "email": email,
        "sap_client": sap_client,
        "roles": roles,
        "sap_request": user_request,
        "iat": now,
        "exp": now + expires_in_seconds,
        "aud": SAP_AUDIENCE,
        "iss": IDP_ISSUER,
        "jti": jti,
    }

    token = jwt.encode(payload, keys["privateKeyPem"], algorithm="RS256")
    header = jwt.get_unverified_header(token)

    return {
        "token": token,
        "claims": payload,
        "header": header,
    }


def convert_jwt_to_saml(jwt_token: str) -> dict[str, Any]:
    """
    Step 2: Validate a JWT token and convert its principal & claims into a
    cryptographically signed SAML 2.0 Bearer Assertion (XML + Base64) for SAP.
    """
    keys = get_identity_keys()

    decoded = jwt.decode(
        jwt_token,
        keys["publicKeyPem"],
        algorithms=["RS256"],
        issuer=IDP_ISSUER,
        audience=SAP_AUDIENCE,
    )

    assertion_id = f"_{uuid.uuid4().hex}"
    now_ts = time.time()
    issue_instant = _iso_utc(now_ts)
    not_before = _iso_utc(now_ts - 30)
    not_on_or_after = _iso_utc(float(decoded["exp"]))

    user_id = decoded["sub"]
    email = decoded.get("email") or f"{user_id.lower()}@enterprise.local"
    sap_client = decoded.get("sap_client") or "100"
    roles = decoded.get("roles") or []
    sap_request_json = json.dumps(decoded.get("sap_request") or {})
    session_index = decoded.get("jti") or assertion_id

    unsigned_xml = (
        f'<saml2:Assertion xmlns:saml2="{SAML2_NS}" ID="{escape(assertion_id)}" '
        f'IssueInstant="{escape(issue_instant)}" Version="2.0">'
        f"<saml2:Issuer>{escape(IDP_ISSUER)}</saml2:Issuer>"
        f"<saml2:Subject>"
        f'<saml2:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">{escape(user_id)}</saml2:NameID>'
        f'<saml2:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">'
        f'<saml2:SubjectConfirmationData NotOnOrAfter="{escape(not_on_or_after)}" Recipient="{escape(SAP_RECIPIENT)}"/>'
        f"</saml2:SubjectConfirmation>"
        f"</saml2:Subject>"
        f'<saml2:Conditions NotBefore="{escape(not_before)}" NotOnOrAfter="{escape(not_on_or_after)}">'
        f"<saml2:AudienceRestriction>"
        f"<saml2:Audience>{escape(SAP_AUDIENCE)}</saml2:Audience>"
        f"</saml2:AudienceRestriction>"
        f"</saml2:Conditions>"
        f'<saml2:AuthnStatement AuthnInstant="{escape(issue_instant)}" SessionIndex="{escape(session_index)}">'
        f"<saml2:AuthnContext>"
        f"<saml2:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PreviousSession</saml2:AuthnContextClassRef>"
        f"</saml2:AuthnContext>"
        f"</saml2:AuthnStatement>"
        f"<saml2:AttributeStatement>"
        f'<saml2:Attribute Name="sap_user_id"><saml2:AttributeValue>{escape(user_id)}</saml2:AttributeValue></saml2:Attribute>'
        f'<saml2:Attribute Name="email"><saml2:AttributeValue>{escape(email)}</saml2:AttributeValue></saml2:Attribute>'
        f'<saml2:Attribute Name="sap_client"><saml2:AttributeValue>{escape(sap_client)}</saml2:AttributeValue></saml2:Attribute>'
        f'<saml2:Attribute Name="roles"><saml2:AttributeValue>{escape(",".join(roles))}</saml2:AttributeValue></saml2:Attribute>'
        f'<saml2:Attribute Name="user_request"><saml2:AttributeValue>{escape(sap_request_json)}</saml2:AttributeValue></saml2:Attribute>'
        f"</saml2:AttributeStatement>"
        f"</saml2:Assertion>"
    )

    # 1. Canonicalize unsigned Assertion & compute SHA-256 DigestValue
    unsigned_root = ET.fromstring(unsigned_xml)
    c14n_assertion = ET.canonicalize(
        ET.tostring(unsigned_root, encoding="unicode"), with_comments=False
    ).encode("utf-8")
    digest_b64 = base64.b64encode(hashlib.sha256(c14n_assertion).digest()).decode("ascii")

    # 2. Construct <ds:SignedInfo> and sign its canonical form with RSA-SHA256
    signed_info_xml = (
        f'<ds:SignedInfo xmlns:ds="{DSIG_NS}">'
        f'<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>'
        f'<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>'
        f'<ds:Reference URI="#{escape(assertion_id)}">'
        f"<ds:Transforms>"
        f'<ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>'
        f'<ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>'
        f"</ds:Transforms>"
        f'<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>'
        f"<ds:DigestValue>{digest_b64}</ds:DigestValue>"
        f"</ds:Reference>"
        f"</ds:SignedInfo>"
    )

    signed_info_elem = ET.fromstring(signed_info_xml)
    c14n_signed_info = ET.canonicalize(
        ET.tostring(signed_info_elem, encoding="unicode"), with_comments=False
    ).encode("utf-8")
    private_key = serialization.load_pem_private_key(
        keys["privateKeyPem"].encode("utf-8"), password=None
    )
    signature_bytes = private_key.sign(
        c14n_signed_info,
        padding.PKCS1v15(),
        hashes.SHA256(),
    )
    signature_b64 = base64.b64encode(signature_bytes).decode("ascii")

    signature_element_xml = (
        f'<ds:Signature xmlns:ds="{DSIG_NS}">'
        f"{signed_info_xml}"
        f"<ds:SignatureValue>{signature_b64}</ds:SignatureValue>"
        f"<ds:KeyInfo><ds:X509Data><ds:X509Certificate>{keys['certBase64']}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>"
        f"</ds:Signature>"
    )

    # 3. Embed <Signature> immediately after <saml2:Issuer>
    issuer_close_tag = "</saml2:Issuer>"
    signed_xml = unsigned_xml.replace(
        issuer_close_tag, f"{issuer_close_tag}{signature_element_xml}", 1
    )

    saml_bytes = signed_xml.encode("utf-8")
    saml_base64 = base64.b64encode(saml_bytes).decode("ascii")
    saml_base64_url = base64.urlsafe_b64encode(saml_bytes).decode("ascii").rstrip("=")

    return {
        "assertionId": assertion_id,
        "issuer": IDP_ISSUER,
        "audience": SAP_AUDIENCE,
        "subjectNameId": user_id,
        "notBefore": not_before,
        "notOnOrAfter": not_on_or_after,
        "signedXml": signed_xml,
        "samlBase64": saml_base64,
        "samlBase64Url": saml_base64_url,
    }


def verify_and_parse_saml_assertion(saml_input: str) -> dict[str, Any]:
    """
    Step 3 (SAP side): Verify XML-DSig signature & digest on the SAML 2.0 Assertion
    and extract the authenticated SAP user + user request attributes.
    """
    keys = get_identity_keys()

    trimmed = saml_input.strip()
    if trimmed.startswith("<"):
        xml_string = trimmed
    else:
        padded = trimmed + "=" * (-len(trimmed) % 4)
        xml_string = base64.b64decode(padded).decode("utf-8")

    root = ET.fromstring(xml_string)
    sig_node = root.find(f"{{{DSIG_NS}}}Signature")
    if sig_node is None:
        raise ValueError("SAML Assertion is missing an XML-DSig <Signature> element.")

    signed_info_node = sig_node.find(f"{{{DSIG_NS}}}SignedInfo")
    sig_val_node = sig_node.find(f"{{{DSIG_NS}}}SignatureValue")
    digest_val_node = sig_node.find(
        f".//{{{DSIG_NS}}}Reference/{{{DSIG_NS}}}DigestValue"
    )

    if signed_info_node is None or sig_val_node is None or digest_val_node is None:
        raise ValueError("Malformed XML-DSig <Signature> structure.")

    # 1. Verify RSA-SHA256 signature over canonicalized <SignedInfo>
    c14n_signed_info = ET.canonicalize(
        ET.tostring(signed_info_node, encoding="unicode"), with_comments=False
    ).encode("utf-8")
    signature_bytes = base64.b64decode((sig_val_node.text or "").strip())

    cert = x509.load_pem_x509_certificate(keys["certPem"].encode("utf-8"))
    public_key = cert.public_key()
    try:
        public_key.verify(
            signature_bytes,
            c14n_signed_info,
            padding.PKCS1v15(),
            hashes.SHA256(),
        )
    except Exception as exc:
        raise ValueError(f"Invalid SAML 2.0 XML cryptographic signature: {exc}") from exc

    # 2. Verify Enveloped SHA-256 Digest over Assertion (with <Signature> removed)
    root_copy = copy.deepcopy(root)
    sig_in_copy = root_copy.find(f"{{{DSIG_NS}}}Signature")
    if sig_in_copy is not None:
        root_copy.remove(sig_in_copy)
    c14n_unsigned = ET.canonicalize(
        ET.tostring(root_copy, encoding="unicode"), with_comments=False
    ).encode("utf-8")
    computed_digest = base64.b64encode(hashlib.sha256(c14n_unsigned).digest()).decode(
        "ascii"
    )
    if computed_digest != (digest_val_node.text or "").strip():
        raise ValueError("SAML 2.0 XML DigestValue mismatch (Assertion tampered).")

    # 3. Extract SAML metadata, Subject NameID, Conditions, and Attributes
    assertion_id = root.attrib.get("ID", "unknown")
    issuer = (root.findtext(f"{{{SAML2_NS}}}Issuer") or "").strip()
    name_id = (
        root.findtext(f".//{{{SAML2_NS}}}Subject/{{{SAML2_NS}}}NameID") or ""
    ).strip()

    conditions_node = root.find(f"{{{SAML2_NS}}}Conditions")
    not_before = conditions_node.attrib.get("NotBefore") if conditions_node is not None else None
    not_on_or_after = (
        conditions_node.attrib.get("NotOnOrAfter") if conditions_node is not None else None
    )

    now_dt = datetime.now(timezone.utc)
    if not_before:
        nb_dt = datetime.fromisoformat(not_before.replace("Z", "+00:00"))
        if (nb_dt - now_dt).total_seconds() > 5:
            raise ValueError(f"SAML Assertion is not valid yet (NotBefore: {not_before})")
    if not_on_or_after:
        noa_dt = datetime.fromisoformat(not_on_or_after.replace("Z", "+00:00"))
        if (now_dt - noa_dt).total_seconds() > 5:
            raise ValueError(
                f"SAML Assertion has expired (NotOnOrAfter: {not_on_or_after})"
            )

    attributes: dict[str, str] = {}
    for attr in root.findall(
        f".//{{{SAML2_NS}}}AttributeStatement/{{{SAML2_NS}}}Attribute"
    ):
        attr_name = attr.attrib.get("Name")
        val_text = attr.findtext(f"{{{SAML2_NS}}}AttributeValue")
        if attr_name:
            attributes[attr_name] = val_text or ""

    parsed_user_request = None
    if attributes.get("user_request"):
        try:
            parsed_user_request = json.loads(attributes["user_request"])
        except Exception:
            parsed_user_request = {"raw": attributes["user_request"]}

    roles_str = attributes.get("roles", "")
    roles = [r for r in roles_str.split(",") if r]

    return {
        "verified": True,
        "assertionId": assertion_id,
        "issuer": issuer,
        "nameId": name_id,
        "notBefore": not_before,
        "notOnOrAfter": not_on_or_after,
        "sapClient": attributes.get("sap_client", "100"),
        "email": attributes.get("email", ""),
        "roles": roles,
        "userRequest": parsed_user_request,
        "attributes": attributes,
    }
