import asyncio
import json
import os
import sys
import threading
import time
from pathlib import Path

import uvicorn
from mcp import Client, StdioServerParameters

from src.sap_service import app, find_available_port

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PROJECT_ROOT = Path(__file__).resolve().parent.parent


async def run_demo() -> None:
    print(
        "================================================================================"
    )
    print(" 🚀 MCP -> JWT -> SAML 2.0 -> SAP Principal Propagation Demo (Python CLI)")
    print(
        "================================================================================\n"
    )

    requested_port = int(os.environ.get("SAP_PORT", "4004"))
    port = find_available_port(requested_port)
    sap_base_url = f"http://localhost:{port}"

    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    # Wait briefly for FastAPI server to bind
    for _ in range(30):
        if server.started:
            break
        await asyncio.sleep(0.1)

    print(f"✅ [Setup 1/2] Mock SAP S/4HANA Service (FastAPI) started at {sap_base_url}")

    server_params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "src.mcp_server"],
        cwd=str(PROJECT_ROOT),
        env={**os.environ, "SAP_BASE_URL": sap_base_url},
    )

    async with Client(server_params) as mcp_client:
        tools_res = await mcp_client.list_tools()
        tool_names = [t.name for t in tools_res.tools]
        print(
            f"✅ [Setup 2/2] Connected to Python MCP Server (src/mcp_server.py). Tools: {', '.join(tool_names)}\n"
        )

        initial_request = {
            "userId": "ELDIEBELDIE",
            "email": "eldiebeldie@enterprise.local",
            "sapClient": "100",
            "action": "CREATE_SALES_ORDER",
            "parameters": {
                "customer": "CUST-1001",
                "material": "MAT-SAP-AI-CORE",
                "quantity": 2,
                "amount": "18500.00",
                "currency": "EUR",
            },
        }

        step1_rpc_wire = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "create_jwt_token",
                "arguments": initial_request,
            },
        }

        print(
            "================================================================================"
        )
        print(" 🟢 [STEP 0 - INITIAL REQUEST SENT TO PYTHON MCP SERVER]")
        print(
            "================================================================================"
        )
        print("  • From       : Demo Client (src/demo.py)")
        print(
            '  • Sent To    : Python MCP Server (src/mcp_server.py via stdio) -> Tool: "create_jwt_token"'
        )
        print(
            f"  • Who (User) : {initial_request['userId']} ({initial_request['email']}), SAP Client: {initial_request['sapClient']}"
        )
        print(f"  • What Action: {initial_request['action']}")
        print("\n  📡 [ACTUAL JSON-RPC 2.0 REQUEST SENT TO MCP]:")
        print(json.dumps(step1_rpc_wire, indent=2))

        res1 = await mcp_client.call_tool("create_jwt_token", initial_request)
        jwt_data = json.loads(res1.content[0].text)

        print(
            "\n--------------------------------------------------------------------------------"
        )
        print(" 🔵 [STEP 1 - MCP CREATED SIGNED JWT TOKEN]")
        print(
            "--------------------------------------------------------------------------------"
        )
        print("  • Algorithm  : RS256 (Signed with IdP RSA Private Key)")
        print(f"  • Raw JWT    : {jwt_data['token']}")
        print("  • Decoded JWT Header:")
        print(json.dumps(jwt_data["header"], indent=2))
        print("  • Decoded JWT Claims:")
        print(json.dumps(jwt_data["claims"], indent=2))

        step2_rpc_wire = {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "convert_jwt_to_saml",
                "arguments": {"jwtToken": jwt_data["token"]},
            },
        }

        print(
            "\n--------------------------------------------------------------------------------"
        )
        print(" 🟣 [STEP 2 - MCP CONVERTED JWT TO SIGNED SAML 2.0 ASSERTION]")
        print(
            "--------------------------------------------------------------------------------"
        )
        print("  📡 [ACTUAL JSON-RPC 2.0 REQUEST SENT TO MCP SAML CONVERTER]:")
        print(json.dumps(step2_rpc_wire, indent=2))

        res2 = await mcp_client.call_tool(
            "convert_jwt_to_saml", {"jwtToken": jwt_data["token"]}
        )
        saml_data = json.loads(res2.content[0].text)

        print(f"\n  • SAML ID    : {saml_data['assertionId']}")
        print(f"  • NameID     : {saml_data['subjectNameId']}")
        print("  • Signature  : Enveloped XML-DSig (RSA-SHA256 + X.509 Certificate)")
        print("  • Signed SAML 2.0 XML:")
        print(saml_data["signedXml"])

        print(
            "\n--------------------------------------------------------------------------------"
        )
        print(" 🟠 [STEP 3 - ACTUAL HTTP REQUEST SENT TO SAP SERVICE]")
        print(
            "--------------------------------------------------------------------------------"
        )

        res3 = await mcp_client.call_tool(
            "send_saml_to_sap",
            {
                "samlBase64": saml_data["samlBase64"],
                "sapBaseUrl": sap_base_url,
            },
        )
        sap_exchange = json.loads(res3.content[0].text)

        print("\n  📡 [1. EXACT RAW HTTP/1.1 WIRE REQUEST SENT TO SAP GATEWAY]:")
        print(sap_exchange["httpRequestSent"]["rawHttpWire"])

        print("\n  💻 [2. COPY-PASTEABLE CURL COMMAND]:")
        print(sap_exchange["httpRequestSent"]["curlCommand"])

        print("\n  🔑 [3. ALTERNATIVE SAP RFC 7522 OAUTH2 SAML BEARER HTTP REQUEST]:")
        print(sap_exchange["httpRequestSent"]["rfc7522OAuthWire"])

        print(
            "\n--------------------------------------------------------------------------------"
        )
        print(" ✅ [STEP 4 - ACTUAL HTTP RESPONSE RECEIVED FROM SAP SERVICE]")
        print(
            "--------------------------------------------------------------------------------"
        )
        print(f"HTTP/1.1 {sap_exchange['httpResponseReceived']['status']}")
        print(
            f"Content-Type: {sap_exchange['httpResponseReceived']['headers']['content-type']}\n"
        )
        print(json.dumps(sap_exchange["httpResponseReceived"]["body"], indent=2))

    server.should_exit = True
    print("\n✅ Python Demo completed successfully!")


if __name__ == "__main__":
    asyncio.run(run_demo())
