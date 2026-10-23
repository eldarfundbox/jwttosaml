import json
import os
from typing import Any
from urllib.parse import quote, urlparse

import httpx
from mcp.server.mcpserver import MCPServer

from src.jwt_to_saml import (
    convert_jwt_to_saml as _convert_jwt_to_saml,
    create_jwt_token as _create_jwt_token,
)

DEFAULT_SAP_BASE_URL = os.environ.get("SAP_BASE_URL", "http://localhost:4004")

mcp = MCPServer("sap-jwt-to-saml-mcp", version="1.0.0")


async def post_saml_to_sap(
    saml_base64: str,
    user_request: dict[str, Any] | None = None,
    sap_base_url: str = DEFAULT_SAP_BASE_URL,
) -> dict[str, Any]:
    """
    Builds the exact raw HTTP/1.1 wire representation, curl command, and RFC 7522
    OAuth2 SAML Bearer format, then sends the SAML 2.0 Assertion to the SAP service.
    """
    endpoint_path = "/sap/opu/odata/sap/Z_MCP_GATEWAY_SRV/ExecuteRequest"
    endpoint = f"{sap_base_url.rstrip('/')}{endpoint_path}"
    parsed = urlparse(endpoint)

    request_body_obj = {"userRequest": user_request} if user_request is not None else {}
    request_body_str = json.dumps(request_body_obj, indent=2)

    headers = {
        "Host": parsed.netloc,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"SAML2.0 {saml_base64}",
    }

    raw_http_wire = "\n".join(
        [
            f"POST {endpoint_path} HTTP/1.1",
            f"Host: {parsed.netloc}",
            "Content-Type: application/json",
            "Accept: application/json",
            f"Authorization: SAML2.0 {saml_base64}",
            f"Content-Length: {len(request_body_str.encode('utf-8'))}",
            "",
            request_body_str,
        ]
    )

    oauth_form_body = (
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Asaml2-bearer"
        f"&assertion={quote(saml_base64, safe='')}"
    )
    rfc7522_oauth_wire = "\n".join(
        [
            "POST /sap/bc/sec/oauth2/token HTTP/1.1",
            f"Host: {parsed.netloc}",
            "Content-Type: application/x-www-form-urlencoded",
            f"Content-Length: {len(oauth_form_body.encode('utf-8'))}",
            "",
            oauth_form_body,
        ]
    )

    curl_command = (
        f'curl -X POST "{endpoint}" \\\n'
        f'  -H "Content-Type: application/json" \\\n'
        f'  -H "Authorization: SAML2.0 {saml_base64}" \\\n'
        f"  -d '{json.dumps(request_body_obj)}'"
    )

    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.post(
            endpoint,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Authorization": f"SAML2.0 {saml_base64}",
            },
            content=request_body_str.encode("utf-8"),
        )

    data = response.json()
    if response.status_code >= 400:
        raise RuntimeError(
            f"SAP returned HTTP {response.status_code}: {json.dumps(data)}"
        )

    return {
        "httpRequestSent": {
            "method": "POST",
            "url": endpoint,
            "headers": headers,
            "body": request_body_obj,
            "rawHttpWire": raw_http_wire,
            "rfc7522OAuthWire": rfc7522_oauth_wire,
            "curlCommand": curl_command,
        },
        "httpResponseReceived": {
            "status": f"{response.status_code} {response.reason_phrase}",
            "headers": {
                "content-type": response.headers.get(
                    "content-type", "application/json"
                ),
            },
            "body": data,
        },
        "sapResult": data,
    }


@mcp.tool()
async def execute_sap_request(
    userId: str = "ELDIEBELDIE",
    email: str = "eldiebeldie@enterprise.local",
    sapClient: str = "100",
    action: str = "CREATE_SALES_ORDER",
    parameters: dict[str, Any] | None = None,
    sapBaseUrl: str | None = None,
) -> str:
    """
    End-to-end flow: receives a user request, creates a signed RS256 JWT token,
    converts the JWT into a signed SAML 2.0 Bearer Assertion, and sends it to SAP
    to authenticate the user and execute the action.
    """
    user_request = {"action": action, "parameters": parameters or {}}

    jwt_result = _create_jwt_token(
        user_id=userId,
        email=email,
        sap_client=sapClient,
        user_request=user_request,
    )
    saml_result = _convert_jwt_to_saml(jwt_result["token"])
    sap_exchange = await post_saml_to_sap(
        saml_base64=saml_result["samlBase64"],
        user_request=user_request,
        sap_base_url=sapBaseUrl or DEFAULT_SAP_BASE_URL,
    )

    flow_summary = {
        "step1_jwtCreatedByMcp": {
            "tokenPreview": f"{jwt_result['token'][:48]}...",
            "jwtFullToken": jwt_result["token"],
            "header": jwt_result["header"],
            "claims": jwt_result["claims"],
        },
        "step2_jwtConvertedToSaml": {
            "assertionId": saml_result["assertionId"],
            "subjectNameId": saml_result["subjectNameId"],
            "issuer": saml_result["issuer"],
            "audience": saml_result["audience"],
            "samlBase64": saml_result["samlBase64"],
            "signedXml": saml_result["signedXml"],
        },
        "step3_httpRequestToSap": sap_exchange["httpRequestSent"],
        "step4_sapHttpResponse": sap_exchange["httpResponseReceived"],
    }
    return json.dumps(flow_summary, indent=2)


@mcp.tool()
def create_jwt_token(
    userId: str = "ELDIEBELDIE",
    email: str = "eldiebeldie@enterprise.local",
    sapClient: str = "100",
    action: str = "GET_SALES_ORDERS",
    parameters: dict[str, Any] | None = None,
) -> str:
    """Step 1: Creates a signed RS256 JWT token for an SAP user and their request payload."""
    result = _create_jwt_token(
        user_id=userId,
        email=email,
        sap_client=sapClient,
        user_request={"action": action, "parameters": parameters or {}},
    )
    return json.dumps(result, indent=2)


@mcp.tool()
def convert_jwt_to_saml(jwtToken: str) -> str:
    """Step 2: Validates a JWT token and converts it into a signed SAML 2.0 Bearer Assertion (XML & Base64)."""
    saml_result = _convert_jwt_to_saml(jwtToken)
    return json.dumps(saml_result, indent=2)


@mcp.tool()
async def send_saml_to_sap(
    samlBase64: str,
    action: str | None = None,
    parameters: dict[str, Any] | None = None,
    sapBaseUrl: str | None = None,
) -> str:
    """Step 3: Sends a Base64-encoded SAML 2.0 Assertion to the SAP service so SAP authenticates the user and executes the request."""
    user_request = (
        {"action": action, "parameters": parameters or {}} if action else None
    )
    sap_exchange = await post_saml_to_sap(
        saml_base64=samlBase64,
        user_request=user_request,
        sap_base_url=sapBaseUrl or DEFAULT_SAP_BASE_URL,
    )
    return json.dumps(sap_exchange, indent=2)


if __name__ == "__main__":
    mcp.run(transport="stdio")

