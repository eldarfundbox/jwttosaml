<div align="right">
  <a href="https://github.com/eldiebeldie">
    <img src="https://img.shields.io/badge/Crafted%20by-%40eldiebeldie-0284c7?style=flat-square&logo=github" alt="Crafted by @eldiebeldie" />
  </a>
  <img src="https://img.shields.io/badge/%F0%9F%93%85%20Date-Oct%2023%2C%202026-334155?style=flat-square" alt="Date: Oct 23, 2026" />
</div>

<div align="center">

# ⚡️ MCP ➔ JWT ➔ SAML 2.0 ➔ SAP S/4HANA (Python)
### *The Ultimate AI-Agent-to-SAP Principal Propagation Playground*

[![Author](https://img.shields.io/badge/Author-eldiebeldie-007acc?style=for-the-badge&logo=github)](https://github.com/eldiebeldie)
[![Python](https://img.shields.io/badge/Python-3.11%2B%20%7C%20FastAPI-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org)
[![MCP](https://img.shields.io/badge/Protocol-Python%20MCP%20SDK-8A2BE2?style=for-the-badge)](https://modelcontextprotocol.io)
[![SAP S/4HANA](https://img.shields.io/badge/SAP-S%2F4HANA%20OData-0FAAFF?style=for-the-badge&logo=sap)](https://www.sap.com)
[![Security](https://img.shields.io/badge/Auth-RS256%20JWT%20%E2%9E%94%20SAML%202.0%20XML--DSig-10B981?style=for-the-badge)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-F59E0B?style=for-the-badge)](./LICENSE)

<p align="center">
  🌐 <strong>English</strong> | 🇮🇱 <a href="./README.he.md"><strong>קריאה בעברית (Hebrew)</strong></a>
</p>

<p align="center">
  <strong>Modern AI Agents speak MCP & JSON Web Tokens. Enterprise SAP speaks SAML 2.0 XML Assertions.</strong><br/>
  Built with the official <strong>Python MCP SDK (<code>MCPServer</code>)</strong>, <strong>FastAPI</strong>, <strong>PyJWT</strong>, and <strong>cryptography</strong> — complete with a live <strong>6-Theme Interactive Flow Studio</strong>.
</p>

</div>

---

## 🎯 The Story: Why Does This Exist?

Imagine an AI Agent wants to create a Sales Order (`VA01`) or approve a Purchase Requisition (`ME54N`) in **SAP S/4HANA** on behalf of a real user (`ELDIEBELDIE`).
You **never** want to use a shared technical system user in SAP — you need **Principal Propagation** so SAP knows *who* the real human is, checks their `SU01` roles, and logs their exact SAP user ID in the audit trail.

Here is how our Python flow makes that effortless:
1. 🗣️ **You ask the Python MCP Server** to perform an SAP action for a user.
2. 🪙 **MCP mints a signed RS256 JWT** capturing the user's identity and intent.
3. 🧬 **The JWT is transformed into an OASIS SAML 2.0 Bearer Assertion**, signed with an X.509 certificate (`XML-DSig RSA-SHA256`).
4. 🏢 **SAP receives the SAML 2.0 token**, verifies the cryptographic XML signature, identifies the SAP user (`ELDIEBELDIE` or `ALICE_FIN`), identifies their business request, and executes the SAP transaction!

---

## 🗺️ Visualized Architecture & Flows

### 1. The High-Level Pipeline (`Client ➔ MCP ➔ JWT ➔ SAML 2.0 ➔ SAP`)

```mermaid
flowchart LR
    subgraph ClientLayer["💻 1. AI Agent / Web UI"]
        A["🧑 User Request<br/>(User: ELDIEBELDIE<br/>Action: CREATE_SALES_ORDER)"]
    end

    subgraph MCPLayer["🧠 2. Python MCP Server (src/mcp_server.py)"]
        B["🪙 Tool: create_jwt_token<br/>Mints RS256 Signed JWT"]
        C["🔐 Tool: convert_jwt_to_saml<br/>Builds & Signs SAML 2.0 XML"]
        D["📡 Tool: send_saml_to_sap<br/>Authorization: SAML2.0 &lt;base64&gt;"]
        B --> C --> D
    end

    subgraph SAPLayer["🏢 3. Mock SAP S/4HANA (src/sap_service.py)"]
        E["🛡️ Verify XML-DSig<br/>Trusted IdP X.509 Cert"]
        F["👤 Map NameID ➔ SU01<br/>Identify User & Roles"]
        G["⚙️ Execute Business Logic<br/>VA01 / VA03 / ME54N"]
        E --> F --> G
    end

    A -->|"stdio / JSON-RPC"| B
    D -->|"HTTP POST /sap/opu/odata/..."| E
    G -->|"✅ OData JSON Response"| A

    style ClientLayer fill:#1e293b,stroke:#f59e0b,stroke-width:2px,color:#fff
    style MCPLayer fill:#1e1b4b,stroke:#8b5cf6,stroke-width:2px,color:#fff
    style SAPLayer fill:#064e3b,stroke:#10b981,stroke-width:2px,color:#fff
```

---

### 2. Deep-Dive Sequence Diagram (Step-by-Step Wire Trace)

```mermaid
sequenceDiagram
    autonumber
    actor User as 🧑‍💻 User / Browser UI
    participant MCP as 🧠 Python MCP Server<br/>(src/mcp_server.py)
    participant Crypto as 🔐 JWT & SAML Engine<br/>(src/jwt_to_saml.py)
    participant SAP as 🏢 SAP S/4HANA FastAPI<br/>(src/sap_service.py)

    User->>MCP: [Step 0] Send Request (userId="ELDIEBELDIE", action="CREATE_SALES_ORDER")
    activate MCP
    MCP->>Crypto: create_jwt_token(user_id, email, sap_client, user_request)
    Crypto-->>MCP: [Step 1] Signed RS256 JWT (eyJhbGciOiJSUzI1NiIs...)

    MCP->>Crypto: convert_jwt_to_saml(jwt_token)
    Note over Crypto: 1. Verify JWT Signature (RS256)<br/>2. Map Claims ➔ <saml2:Assertion><br/>3. Sign XML with IdP X.509 Cert
    Crypto-->>MCP: [Step 2] Signed SAML 2.0 XML + Base64 Payload

    MCP->>SAP: [Step 3] POST /sap/opu/odata/sap/Z_MCP_GATEWAY_SRV/ExecuteRequest<br/>Header: Authorization: SAML2.0 <base64>
    activate SAP
    Note over SAP: [Step 4] SAP Processing:<br/>✔ Verify XML-DSig against IdP Cert<br/>✔ Lookup NameID "ELDIEBELDIE" in SU01<br/>✔ Identify Action "CREATE_SALES_ORDER"<br/>✔ Run Transaction VA01 (Client 100)
    SAP-->>MCP: HTTP 200 OK (SalesOrder "0000010048" Created by ELDIEBELDIE)
    deactivate SAP

    MCP-->>User: Complete Trace (JWT + SAML XML + SAP OData Result)
    deactivate MCP
```

---

### 3. Token Anatomy: How JWT Claims Morph into SAML 2.0 XML

```mermaid
flowchart TD
    subgraph JWT["🪙 Step 1: RS256 JWT Token (JSON)"]
        J1["iss: 'https://mcp-idp.enterprise.local'"]
        J2["sub: 'ELDIEBELDIE'"]
        J3["aud: 'https://sap-s4hana.../oauth2/token'"]
        J4["sap_client: '100' | roles: [...]"]
        J5["sap_request: { action: 'CREATE_SALES_ORDER', ... }"]
    end

    subgraph SAML["📜 Step 2: Signed SAML 2.0 Assertion (XML)"]
        S1["&lt;saml2:Issuer&gt;https://mcp-idp.enterprise.local&lt;/saml2:Issuer&gt;"]
        S2["&lt;saml2:Subject&gt;&lt;saml2:NameID&gt;ELDIEBELDIE&lt;/saml2:NameID&gt;&lt;/saml2:Subject&gt;"]
        S3["&lt;saml2:AudienceRestriction&gt;&lt;saml2:Audience&gt;...&lt;/saml2:Audience&gt;&lt;/saml2:AudienceRestriction&gt;"]
        S4["&lt;saml2:Attribute Name='sap_client'&gt;100&lt;/saml2:Attribute&gt;"]
        S5["&lt;saml2:Attribute Name='user_request'&gt;{'action':'CREATE_SALES_ORDER'}&lt;/saml2:Attribute&gt;"]
        S6["&lt;ds:Signature&gt;RSA-SHA256 + X509Certificate&lt;/ds:Signature&gt;"]
    end

    J1 ==> S1
    J2 ==> S2
    J3 ==> S3
    J4 ==> S4
    J5 ==> S5

    style JWT fill:#0f172a,stroke:#38bdf8,stroke-width:2px,color:#e2e8f0
    style SAML fill:#2e1065,stroke:#c084fc,stroke-width:2px,color:#f3e8ff
```

---

## 🚀 How to Run the Demo (1 Command!)

### Initial Setup (Once)
```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

### Run the Interactive Demo & Open Browser
```bash
python run_demo.py
```

### What Happens When You Run `python run_demo.py`:
1. **Starts the SAP S/4HANA FastAPI Server** at **[http://localhost:4004](http://localhost:4004)**.
2. **Opens your default browser** directly to `http://localhost:4004` (featuring 6 themes: `Dark`, `Light`, `Cyberpunk`, `SAP Horizon`, `Emerald`, `Sunset`).
3. **Executes the live MCP ➔ JWT ➔ SAML ➔ SAP flow** and displays:
   - **In your Browser**: Interactive cards for Step 0 (Initial Request), Step 1 (JWT), Step 2 (Signed SAML 2.0 XML), Step 3 (Raw HTTP/1.1 Request to SAP + `curl` + RFC 7522 OAuth2), and Step 4 (SAP HTTP Response).
   - **In your Terminal Console**: Color-coded, human-readable logs + full raw JSON-RPC and HTTP wire payloads.

> 💡 **Prefer a pure terminal run?**
> Run `python run_demo.py --cli` to execute the entire flow in your terminal and exit cleanly.

---

## 📡 Actual Wire & HTTP Requests Sent (Learn the Protocol!)

Both the **Web Visualizer (`http://localhost:4004`)** and the **Terminal Console** log the **exact raw JSON-RPC and HTTP/1.1 requests** sent at each step:

### 1️⃣ Step 0: MCP JSON-RPC 2.0 Request (`Client ➔ Python MCP Server`)
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "create_jwt_token",
    "arguments": {
      "userId": "ELDIEBELDIE",
      "email": "eldiebeldie@enterprise.local",
      "sapClient": "100",
      "action": "CREATE_SALES_ORDER",
      "parameters": {
        "customer": "CUST-1001",
        "amount": "18500.00",
        "material": "MAT-SAP-AI-CORE",
        "quantity": 2
      }
    }
  }
}
```

### 2️⃣ Step 3A: Direct Raw HTTP/1.1 Request Sent to SAP Gateway (`MCP ➔ SAP`)
```http
POST /sap/opu/odata/sap/Z_MCP_GATEWAY_SRV/ExecuteRequest HTTP/1.1
Host: localhost:4004
Content-Type: application/json
Accept: application/json
Authorization: SAML2.0 PHNhbWwyOkFzc2VydGlvbiB4bWxuczpzYW1sMj0idXJuOm9hc2lzOm5hbWVzOnRjOlNBTUw6Mi4wOmFzc2VydGlvbiIgSUQ9Il85N2E1Y2U2ZmZlNGM0ZDJiOTZkNDQ5ODY1MTczMTk5YiIgSXNzdWVJbnN0YW50PSIyMDI2LTEwLTIyVDIwOjQyOjE2LjM0MFoiIFZlcnNpb249IjIuMCI+...
Content-Length: 162

{
  "userRequest": {
    "action": "CREATE_SALES_ORDER",
    "parameters": {
      "customer": "CUST-1001",
      "material": "MAT-SAP-AI-CORE",
      "quantity": 2,
      "amount": "18500.00",
      "currency": "EUR"
    }
  }
}
```

### 3️⃣ Step 3B: Alternative SAP Standard OAuth 2.0 SAML Bearer HTTP Request (RFC 7522)
In production SAP systems configured via transaction `SOAUTH2`, the SAML 2.0 Assertion can also be sent via `application/x-www-form-urlencoded` to `/sap/bc/sec/oauth2/token`:
```http
POST /sap/bc/sec/oauth2/token HTTP/1.1
Host: localhost:4004
Content-Type: application/x-www-form-urlencoded

grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Asaml2-bearer&assertion=PHNhbWwyOkFzc2VydGlvbiB4bWxu...
```

---

## 🧰 Commands & Architecture

| Mode | Command | What It Does |
| :--- | :--- | :--- |
| **Interactive Demo (Recommended)** | `python run_demo.py` | Starts SAP FastAPI + Flow Studio UI on port `4004` and **auto-opens the browser**. |
| **CLI Demo** | `python run_demo.py --cli` | Runs the end-to-end MCP ➔ JWT ➔ SAML ➔ SAP flow in the terminal and exits. |
| **SAP Service Only** | `python -m src.sap_service` | Starts the Mock SAP S/4HANA server on `http://localhost:4004` without opening a browser. |
| **MCP Server (stdio)** | `python -m src.mcp_server` | Runs [`src/mcp_server.py`](./src/mcp_server.py) over `stdio` for Claude Desktop, Cursor, or Antigravity. |

### Key Source Files
- **[`src/crypto_keys.py`](./src/crypto_keys.py)** — Zero-config RSA-2048 keypair & self-signed X.509 v3 IdP certificate generator using Python `cryptography`.
- **[`src/jwt_to_saml.py`](./src/jwt_to_saml.py)** — Mints RS256 JWTs (`PyJWT`), builds OASIS SAML 2.0 Assertions, signs them with Enveloped XML-DSig (`RSA-SHA256`), and verifies SAML assertions.
- **[`src/mcp_server.py`](./src/mcp_server.py)** — Official Python MCP Server (`MCPServer`) exposing `execute_sap_request`, `create_jwt_token`, `convert_jwt_to_saml`, and `send_saml_to_sap`.
- **[`src/sap_service.py`](./src/sap_service.py)** — FastAPI Mock SAP S/4HANA Gateway (`Z_MCP_GATEWAY_SRV` & `/sap/bc/sec/oauth2/token`) + Live 6-Theme Web Flow Studio UI.
- **[`src/demo.py`](./src/demo.py)** — Automated CLI runner for terminal verification.
- **[`run_demo.py`](./run_demo.py)** — One-command launcher that automatically uses `.venv` if present.

---

## 👨‍💻 Author & Credits

<div align="center">

### Crafted with ❤️ & Enterprise Wizardry by **eldiebeldie**

[![GitHub](https://img.shields.io/badge/GitHub-@eldiebeldie-181717?style=for-the-badge&logo=github)](https://github.com/eldiebeldie)
[![Repository](https://img.shields.io/badge/Repo-eldiebeldie%2Fjwttosaml-0284c7?style=for-the-badge&logo=git)](https://github.com/eldiebeldie/jwttosaml)
[![Email](https://img.shields.io/badge/Email-eldargr%40gmail.com-EA4335?style=for-the-badge&logo=gmail)](mailto:eldargr@gmail.com)

> 💬 **Want to say thank you?**
> If this project helped you or inspired your architecture, feel free to [leave a comment or star in the repo](https://github.com/eldiebeldie/jwttosaml/issues) or send me a short email at **[eldargr@gmail.com](mailto:eldargr@gmail.com)** — in **English and/or Hebrew (אנגלית ו/או עברית)**! 🙏

*Bridging Agentic AI (MCP) with Enterprise SAP Architecture — Making Principal Propagation Fun, Visual, and Effortless.*

</div>
