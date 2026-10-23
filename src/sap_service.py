import json
import os
import socket
import sys
import threading
import time
import uuid
import webbrowser
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, JSONResponse
from mcp import Client, StdioServerParameters

from src.jwt_to_saml import verify_and_parse_saml_assertion

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Simulated SAP User Master Data (SU01 / USR02)
SAP_USER_MASTER: dict[str, dict[str, Any]] = {
    "ELDIEBELDIE": {
        "bname": "ELDIEBELDIE",
        "fullName": "eldiebeldie (SAP Senior Architect)",
        "department": "Enterprise Integration & AI",
        "mandt": "100",
        "costCenter": "CC-4100",
        "authorizedRoles": [
            "SAP_SD_SALES_ORDER_CREATE",
            "SAP_SD_SALES_ORDER_DISPLAY",
            "SAP_MM_PURCHASE_DISPLAY",
            "SAP_MM_PURCHASE_APPROVE",
        ],
    },
    "ALICE_FIN": {
        "bname": "ALICE_FIN",
        "fullName": "Alice (Finance Controller)",
        "department": "FI/CO",
        "mandt": "100",
        "costCenter": "CC-2000",
        "authorizedRoles": ["SAP_FI_INVOICE_APPROVE", "SAP_SD_SALES_ORDER_DISPLAY"],
    },
}

# Simulated SAP S/4HANA Tables (VBAK Sales Orders & EBAN Purchase Requisitions)
SAP_SALES_ORDERS: list[dict[str, Any]] = [
    {
        "SalesOrder": "0000010042",
        "SalesOrderType": "OR",
        "SoldToParty": "CUST-1001",
        "TotalNetAmount": "14500.00",
        "TransactionCurrency": "EUR",
        "CreatedByUser": "ELDIEBELDIE",
        "OverallSDProcessStatus": "OPEN",
    },
    {
        "SalesOrder": "0000010043",
        "SalesOrderType": "OR",
        "SoldToParty": "CUST-1001",
        "TotalNetAmount": "8200.50",
        "TransactionCurrency": "EUR",
        "CreatedByUser": "ALICE_FIN",
        "OverallSDProcessStatus": "COMPLETED",
    },
    {
        "SalesOrder": "0000010044",
        "SalesOrderType": "OR",
        "SoldToParty": "CUST-2009",
        "TotalNetAmount": "39900.00",
        "TransactionCurrency": "USD",
        "CreatedByUser": "ELDIEBELDIE",
        "OverallSDProcessStatus": "IN_PROCESS",
    },
]

SAP_PURCHASE_REQS: list[dict[str, Any]] = [
    {
        "PurchaseRequisition": "0010008821",
        "Material": "MAT-AI-GPU-H100",
        "Quantity": 4,
        "TotalValue": "120000.00",
        "Currency": "USD",
        "ReleaseStatus": "PENDING_APPROVAL",
        "ApprovedBy": None,
    }
]

ACTIVE_SAP_OAUTH_TOKENS: dict[str, dict[str, Any]] = {}


def execute_sap_business_logic(
    sap_user: dict[str, Any], user_request: dict[str, Any] | None
) -> dict[str, Any]:
    req = user_request or {}
    action = str(req.get("action") or "GET_SALES_ORDERS").upper()
    params = req.get("parameters") or {}

    if action == "GET_SALES_ORDERS":
        customer_filter = params.get("customer")
        results = (
            [so for so in SAP_SALES_ORDERS if so["SoldToParty"] == customer_filter]
            if customer_filter
            else SAP_SALES_ORDERS
        )
        return {
            "sapTransaction": "VA03 (Display Sales Orders)",
            "odataEntitySet": "A_SalesOrder",
            "executedBySapUser": sap_user["bname"],
            "mandt": sap_user["mandt"],
            "recordCount": len(results),
            "d": {"results": results},
        }

    if action == "CREATE_SALES_ORDER":
        new_order_num = str(10045 + len(SAP_SALES_ORDERS)).zfill(10)
        new_order = {
            "SalesOrder": new_order_num,
            "SalesOrderType": params.get("orderType") or "OR",
            "SoldToParty": params.get("customer") or "CUST-1001",
            "Material": params.get("material") or "MAT-SAP-BTP-LIC",
            "RequestedQuantity": params.get("quantity") or 1,
            "TotalNetAmount": str(params.get("amount") or "5000.00"),
            "TransactionCurrency": params.get("currency") or "EUR",
            "CreatedByUser": sap_user["bname"],
            "OverallSDProcessStatus": "CREATED",
        }
        SAP_SALES_ORDERS.append(new_order)
        return {
            "sapTransaction": "VA01 (Create Sales Order)",
            "odataEntitySet": "A_SalesOrder",
            "executedBySapUser": sap_user["bname"],
            "mandt": sap_user["mandt"],
            "message": f"Sales Order {new_order_num} created in SAP Client {sap_user['mandt']} by {sap_user['bname']}",
            "d": new_order,
        }

    if action == "APPROVE_PURCHASE_REQ":
        pr_num = params.get("purchaseRequisition") or "0010008821"
        pr = next(
            (
                item
                for item in SAP_PURCHASE_REQS
                if item["PurchaseRequisition"] == pr_num
            ),
            None,
        )
        if pr is None:
            pr = {
                "PurchaseRequisition": pr_num,
                "Material": params.get("material") or "MAT-SERVER-01",
                "Quantity": params.get("quantity") or 1,
                "TotalValue": str(params.get("amount") or "15000.00"),
                "Currency": "EUR",
                "ReleaseStatus": "APPROVED",
                "ApprovedBy": sap_user["bname"],
            }
            SAP_PURCHASE_REQS.append(pr)
        else:
            pr["ReleaseStatus"] = "APPROVED"
            pr["ApprovedBy"] = sap_user["bname"]

        return {
            "sapTransaction": "ME54N (Release Purchase Requisition)",
            "odataEntitySet": "A_PurchaseRequisitionHeader",
            "executedBySapUser": sap_user["bname"],
            "mandt": sap_user["mandt"],
            "message": f"Purchase Requisition {pr_num} approved by {sap_user['bname']}",
            "d": pr,
        }

    return {
        "sapTransaction": "SE37 / Custom RFC & OData Execution",
        "executedBySapUser": sap_user["bname"],
        "mandt": sap_user["mandt"],
        "identifiedAction": action,
        "parametersReceived": params,
        "message": f"SAP identified user {sap_user['bname']} ({sap_user['fullName']}) via SAML 2.0 and executed custom request '{action}'.",
    }


FLOW_STUDIO_HTML = """<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <title>⚡ MCP → JWT → SAML 2.0 → SAP Flow Studio (Python) | by @eldiebeldie</title>
  <style>
    :root, [data-theme="dark"] {
      --bg-grad: radial-gradient(circle at top, #1e1b4b 0%, #0f172a 45%, #020617 100%);
      --text-main: #e2e8f0;
      --text-sub: #94a3b8;
      --card-bg: rgba(30, 41, 59, 0.85);
      --step-bg: rgba(15, 23, 42, 0.92);
      --border: #334155;
      --input-bg: #0f172a;
      --pre-bg: #020617;
      --pre-text: #cbd5e1;
      --pre-border: #1e293b;
      --badge-bg: #334155;
      --badge-text: #f8fafc;
      --summary-bg: rgba(51, 65, 85, 0.45);
      --accent: #38bdf8;
      --btn-grad: linear-gradient(135deg, #0284c7, #7c3aed);
      --title-grad: linear-gradient(90deg, #38bdf8, #c084fc, #34d399);
    }
    [data-theme="light"] {
      --bg-grad: linear-gradient(180deg, #f8fafc 0%, #e2e8f0 100%);
      --text-main: #0f172a;
      --text-sub: #475569;
      --card-bg: rgba(255, 255, 255, 0.95);
      --step-bg: #ffffff;
      --border: #cbd5e1;
      --input-bg: #f1f5f9;
      --pre-bg: #0f172a;
      --pre-text: #e2e8f0;
      --pre-border: #334155;
      --badge-bg: #e2e8f0;
      --badge-text: #0f172a;
      --summary-bg: #f1f5f9;
      --accent: #0284c7;
      --btn-grad: linear-gradient(135deg, #0284c7, #2563eb);
      --title-grad: linear-gradient(90deg, #0369a1, #6d28d9, #047857);
    }
    [data-theme="cyberpunk"] {
      --bg-grad: radial-gradient(circle at top, #3b0764 0%, #1e0536 50%, #090114 100%);
      --text-main: #fdf4ff;
      --text-sub: #f0abfc;
      --card-bg: rgba(46, 16, 101, 0.78);
      --step-bg: rgba(24, 5, 56, 0.92);
      --border: #d946ef;
      --input-bg: #18042c;
      --pre-bg: #0b0118;
      --pre-text: #67e8f9;
      --pre-border: #86198f;
      --badge-bg: #a21caf;
      --badge-text: #fdf4ff;
      --summary-bg: rgba(162, 28, 175, 0.25);
      --accent: #00f5d4;
      --btn-grad: linear-gradient(135deg, #f72585, #7209b7);
      --title-grad: linear-gradient(90deg, #00f5d4, #f72585, #fee440);
    }
    [data-theme="sap-horizon"] {
      --bg-grad: linear-gradient(160deg, #001428 0%, #002a54 55%, #001c38 100%);
      --text-main: #f0f6ff;
      --text-sub: #93c5fd;
      --card-bg: rgba(0, 48, 96, 0.82);
      --step-bg: rgba(0, 32, 66, 0.94);
      --border: #0070f2;
      --input-bg: #001833;
      --pre-bg: #001024;
      --pre-text: #dbeafe;
      --pre-border: #1d4ed8;
      --badge-bg: #0070f2;
      --badge-text: #ffffff;
      --summary-bg: rgba(0, 112, 242, 0.22);
      --accent: #f5b000;
      --btn-grad: linear-gradient(135deg, #0070f2, #0057b8);
      --title-grad: linear-gradient(90deg, #60a5fa, #f5b000, #38bdf8);
    }
    [data-theme="emerald"] {
      --bg-grad: radial-gradient(circle at top, #064e3b 0%, #022c22 55%, #011510 100%);
      --text-main: #ecfdf5;
      --text-sub: #6ee7b7;
      --card-bg: rgba(6, 78, 59, 0.78);
      --step-bg: rgba(2, 44, 34, 0.92);
      --border: #10b981;
      --input-bg: #022019;
      --pre-bg: #01110d;
      --pre-text: #a7f3d0;
      --pre-border: #047857;
      --badge-bg: #059669;
      --badge-text: #ecfdf5;
      --summary-bg: rgba(16, 185, 129, 0.2);
      --accent: #34d399;
      --btn-grad: linear-gradient(135deg, #10b981, #0d9488);
      --title-grad: linear-gradient(90deg, #34d399, #a7f3d0, #fbbf24);
    }
    [data-theme="sunset"] {
      --bg-grad: linear-gradient(160deg, #431407 0%, #31102f 55%, #18071c 100%);
      --text-main: #fff7ed;
      --text-sub: #fdba74;
      --card-bg: rgba(76, 29, 49, 0.82);
      --step-bg: rgba(45, 14, 32, 0.94);
      --border: #f97316;
      --input-bg: #27091c;
      --pre-bg: #160410;
      --pre-text: #fed7aa;
      --pre-border: #9a3412;
      --badge-bg: #ea580c;
      --badge-text: #fff7ed;
      --summary-bg: rgba(249, 115, 22, 0.22);
      --accent: #fb923c;
      --btn-grad: linear-gradient(135deg, #f97316, #db2777);
      --title-grad: linear-gradient(90deg, #fb923c, #f43f5e, #fde047);
    }

    * { box-sizing: border-box; font-family: 'Inter', system-ui, -apple-system, sans-serif; }
    body { margin: 0; background: var(--bg-grad); color: var(--text-main); padding: 28px 24px; min-height: 100vh; transition: background 0.35s, color 0.25s; }
    .container { max-width: 1240px; margin: 0 auto; }
    .hero { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 16px; margin-bottom: 18px; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
    h1 { margin: 0 0 6px; font-size: 26px; background: var(--title-grad); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-weight: 800; }
    p.sub { margin: 0; color: var(--text-sub); font-size: 14px; }
    .top-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; margin-left: auto; }
    .author-corner { display: inline-flex; align-items: center; gap: 10px; background: var(--card-bg); border: 1px solid var(--accent); padding: 8px 16px; border-radius: 999px; font-size: 13px; color: var(--text-main); text-decoration: none; transition: all 0.2s; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25); }
    .author-corner:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(56, 189, 248, 0.3); }
    .author-date { color: var(--text-sub); font-size: 12px; font-weight: 600; border-left: 1px solid var(--border); padding-left: 10px; }
    .theme-bar { display: flex; flex-wrap: wrap; gap: 6px; }
    .theme-btn { background: var(--card-bg); color: var(--text-main); border: 1px solid var(--border); padding: 5px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 600; cursor: pointer; width: auto; transition: all 0.2s; }
    .theme-btn:hover, .theme-btn.active { border-color: var(--accent); background: var(--summary-bg); transform: translateY(-1px); }
    .pipeline { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 22px; }
    .node { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 14px 12px; text-align: center; position: relative; transition: all 0.3s; }
    .node.active { border-color: var(--accent); box-shadow: 0 0 18px rgba(56, 189, 248, 0.28); transform: translateY(-2px); background: var(--step-bg); }
    .node .icon { font-size: 24px; margin-bottom: 6px; display: block; }
    .node .title { font-size: 13px; font-weight: 700; color: var(--text-main); }
    .node .desc { font-size: 11px; color: var(--text-sub); margin-top: 4px; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 18px; margin-bottom: 20px; backdrop-filter: blur(8px); }
    .controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; align-items: end; }
    label { display: block; font-size: 11px; color: var(--text-sub); margin-bottom: 6px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
    select, input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--input-bg); color: var(--text-main); font-size: 14px; }
    button#runBtn { background: var(--btn-grad); color: white; border: none; padding: 11px 20px; border-radius: 8px; font-weight: 700; cursor: pointer; font-size: 14px; transition: all 0.2s; width: 100%; }
    button#runBtn:hover { opacity: 0.95; transform: translateY(-1px); box-shadow: 0 6px 16px rgba(0, 0, 0, 0.3); }
    button#runBtn:disabled { opacity: 0.5; cursor: wait; }
    .steps { display: grid; grid-template-columns: 1fr; gap: 18px; }
    .step-box { background: var(--step-bg); border: 1px solid var(--border); border-left: 5px solid var(--accent); border-radius: 10px; padding: 16px 18px; }
    .step-box.init { border-left-color: #f59e0b; }
    .step-box.saml { border-left-color: #c084fc; }
    .step-box.http { border-left-color: #f97316; }
    .step-box.sap { border-left-color: #10b981; }
    .step-title { font-weight: 700; font-size: 15px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
    .summary-bar { font-size: 13px; color: var(--text-main); background: var(--summary-bg); padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; border: 1px solid var(--border); line-height: 1.5; }
    .badge { font-size: 11px; padding: 4px 10px; border-radius: 999px; background: var(--badge-bg); color: var(--badge-text); font-weight: 600; }
    .sub-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 10px; }
    @media (max-width: 900px) { .sub-grid { grid-template-columns: 1fr; } }
    .code-label { font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--accent); margin: 10px 0 6px; letter-spacing: 0.4px; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-all; font-family: 'Cascadia Code', Consolas, monospace; font-size: 12px; color: var(--pre-text); background: var(--pre-bg); padding: 12px; border-radius: 8px; max-height: 290px; overflow: auto; border: 1px solid var(--pre-border); }
  </style>
</head>
<body>
  <div class="container">
    <div class="hero">
      <div>
        <h1>⚡ MCP ➔ JWT ➔ SAML 2.0 ➔ SAP S/4HANA Studio (Python)</h1>
        <p class="sub">Interactive Principal Propagation & Raw HTTP Wire Inspector — Powered by Python MCP SDK & FastAPI.</p>
      </div>
      <div class="top-actions">
        <a class="author-corner" href="https://github.com/eldiebeldie/jwttosaml" target="_blank" rel="noopener">
          <span>👨‍💻 Crafted by <strong>@eldiebeldie</strong></span>
          <span class="author-date" id="currentDateBadge">📅 Oct 23, 2026</span>
        </a>
        <div class="theme-bar" id="themeBar">
          <button class="theme-btn active" onclick="setTheme('dark')">🌙 Dark</button>
          <button class="theme-btn" onclick="setTheme('light')">☀️ Light</button>
          <button class="theme-btn" onclick="setTheme('cyberpunk')">🌆 Cyberpunk</button>
          <button class="theme-btn" onclick="setTheme('sap-horizon')">💎 SAP Horizon</button>
          <button class="theme-btn" onclick="setTheme('emerald')">🌲 Emerald</button>
          <button class="theme-btn" onclick="setTheme('sunset')">🌅 Sunset</button>
        </div>
      </div>
    </div>

    <div class="pipeline" id="pipeline">
      <div class="node" id="node-0">
        <span class="icon">🧑‍💻</span>
        <div class="title">0. Initial Request</div>
        <div class="desc">Client ➔ MCP (JSON-RPC)</div>
      </div>
      <div class="node" id="node-1">
        <span class="icon">🪙</span>
        <div class="title">1. Mint RS256 JWT</div>
        <div class="desc">Tool: create_jwt_token</div>
      </div>
      <div class="node" id="node-2">
        <span class="icon">🔐</span>
        <div class="title">2. JWT ➔ SAML 2.0</div>
        <div class="desc">XML-DSig + X.509 Cert</div>
      </div>
      <div class="node" id="node-3">
        <span class="icon">📡</span>
        <div class="title">3. HTTP POST to SAP</div>
        <div class="desc">Authorization: SAML2.0</div>
      </div>
      <div class="node" id="node-4">
        <span class="icon">🏢</span>
        <div class="title">4. SAP S/4HANA</div>
        <div class="desc">Verify ➔ SU01 ➔ Execute</div>
      </div>
    </div>

    <div class="card">
      <div class="controls">
        <div>
          <label>SAP User (Principal)</label>
          <select id="userId">
            <option value="ELDIEBELDIE">ELDIEBELDIE (eldiebeldie - SAP Architect)</option>
            <option value="ALICE_FIN">ALICE_FIN (Alice - Finance Controller)</option>
          </select>
        </div>
        <div>
          <label>SAP Business Action</label>
          <select id="action">
            <option value="CREATE_SALES_ORDER">CREATE_SALES_ORDER (VA01)</option>
            <option value="GET_SALES_ORDERS">GET_SALES_ORDERS (VA03)</option>
            <option value="APPROVE_PURCHASE_REQ">APPROVE_PURCHASE_REQ (ME54N)</option>
          </select>
        </div>
        <div>
          <label>Customer / Target ID</label>
          <input id="customer" value="CUST-1001" />
        </div>
        <div>
          <label>Amount (EUR)</label>
          <input id="amount" value="18500.00" />
        </div>
        <div>
          <button id="runBtn" onclick="runFlow()">⚡ Run MCP ➔ SAP Flow</button>
        </div>
      </div>
    </div>

    <div id="output" class="steps"></div>
  </div>

  <script>
    function setTheme(themeName) {
      document.documentElement.setAttribute('data-theme', themeName);
      localStorage.setItem('sap_mcp_theme', themeName);
      document.querySelectorAll('.theme-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('onclick').includes("'" + themeName + "'"));
      });
    }

    (function initSavedTheme() {
      const saved = localStorage.getItem('sap_mcp_theme');
      if (saved) setTheme(saved);
      const dateEl = document.getElementById('currentDateBadge');
      if (dateEl) {
        const formatted = new Date().toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        });
        dateEl.textContent = '📅 ' + formatted;
      }
    })();

    function esc(str) {
      return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function highlightNodes(upTo) {
      for (let i = 0; i <= 4; i++) {
        const el = document.getElementById('node-' + i);
        if (el) el.classList.toggle('active', i <= upTo);
      }
    }

    async function runFlow() {
      const btn = document.getElementById('runBtn');
      const out = document.getElementById('output');
      btn.disabled = true;
      btn.textContent = '⏳ Running MCP Flow...';
      highlightNodes(0);
      out.innerHTML = '<div class="card">🚀 Sending initial request to Python MCP Server over stdio...</div>';

      try {
        const userId = document.getElementById('userId').value;
        const action = document.getElementById('action').value;
        const customer = document.getElementById('customer').value;
        const amount = document.getElementById('amount').value;

        const initialPayload = {
          userId,
          email: userId.toLowerCase() + '@enterprise.local',
          sapClient: '100',
          action,
          parameters: { customer, amount, material: 'MAT-SAP-AI-CORE', quantity: 2, purchaseRequisition: '0010008821' }
        };

        const res = await fetch('/api/run-mcp-flow', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(initialPayload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Flow failed');

        highlightNodes(4);

        const httpReq = data.sapExchange.httpRequestSent;
        const httpRes = data.sapExchange.httpResponseReceived;

        out.innerHTML = `
          <div class="step-box init">
            <div class="step-title">
              <span>🟢 Step 0: Initial Request Sent (Browser HTTP ➔ Python MCP JSON-RPC 2.0)</span>
              <span class="badge">Destination: Python MCP Server (src/mcp_server.py)</span>
            </div>
            <div class="summary-bar">
              <strong>What is sent & where:</strong> The client sends an HTTP POST to <code>/api/run-mcp-flow</code>, which sends a <strong>JSON-RPC 2.0 <code>tools/call</code></strong> message over <code>stdio</code> to the Python MCP Server invoking tool <code>create_jwt_token</code> for SAP user <code>${esc(initialPayload.userId)}</code>.
            </div>
            <div class="sub-grid">
              <div>
                <div class="code-label">1. Browser ➔ Demo Server (Raw HTTP Request)</div>
                <pre>${esc(data.wireRequests.step0_browserHttpWire)}</pre>
              </div>
              <div>
                <div class="code-label">2. MCP Client ➔ Python MCP Server (JSON-RPC 2.0 Request over stdio)</div>
                <pre>${esc(JSON.stringify(data.wireRequests.step1_mcpCreateJwtRpc, null, 2))}</pre>
              </div>
            </div>
          </div>

          <div class="step-box">
            <div class="step-title">
              <span>🔵 Step 1: MCP Minted Signed RS256 JWT & Sent to SAML Converter</span>
              <span class="badge">MCP Tool: create_jwt_token ➔ convert_jwt_to_saml</span>
            </div>
            <div class="summary-bar">
              <strong>What happened:</strong> MCP signed an RS256 JWT token with our IdP private key and passed that JWT into the second MCP tool call (<code>convert_jwt_to_saml</code>).
            </div>
            <div class="sub-grid">
              <div>
                <div class="code-label">Generated RS256 JWT & Decoded Claims</div>
                <pre><strong>Raw JWT Token:</strong>\n${esc(data.jwt.token)}\n\n<strong>Decoded Header:</strong>\n${esc(JSON.stringify(data.jwt.header, null, 2))}\n\n<strong>Decoded Claims:</strong>\n${esc(JSON.stringify(data.jwt.claims, null, 2))}</pre>
              </div>
              <div>
                <div class="code-label">MCP Client ➔ Python MCP Server (JSON-RPC 2.0 Request to convert_jwt_to_saml)</div>
                <pre>${esc(JSON.stringify(data.wireRequests.step2_mcpConvertSamlRpc, null, 2))}</pre>
              </div>
            </div>
          </div>

          <div class="step-box saml">
            <div class="step-title">
              <span>🟣 Step 2: JWT Converted into Signed SAML 2.0 Bearer Assertion</span>
              <span class="badge">XML-DSig (RSA-SHA256 + Exclusive C14N)</span>
            </div>
            <div class="summary-bar">
              <strong>What happened:</strong> The JWT claims were mapped into an OASIS <code>&lt;saml2:Assertion&gt;</code> for <code>&lt;saml2:NameID&gt;${esc(data.saml.subjectNameId)}&lt;/saml2:NameID&gt;</code>, signed with our X.509 certificate, and Base64-encoded for HTTP transport.
            </div>
            <div class="sub-grid">
              <div>
                <div class="code-label">Signed SAML 2.0 XML Assertion</div>
                <pre>${esc(data.saml.signedXml)}</pre>
              </div>
              <div>
                <div class="code-label">Base64-Encoded SAML Assertion (Ready for HTTP Header)</div>
                <pre>${esc(data.saml.samlBase64)}</pre>
              </div>
            </div>
          </div>

          <div class="step-box http">
            <div class="step-title">
              <span>🟠 Step 3: Actual HTTP Request Sent to SAP S/4HANA</span>
              <span class="badge">POST /sap/opu/odata/sap/Z_MCP_GATEWAY_SRV/ExecuteRequest</span>
            </div>
            <div class="summary-bar">
              <strong>How the HTTP Request is sent to SAP:</strong> Below is the exact raw HTTP/1.1 request sent over the wire to SAP (using the <code>Authorization: SAML2.0 &lt;base64&gt;</code> header), the equivalent <code>curl</code> command you can run yourself, and the standard SAP RFC 7522 OAuth2 SAML Bearer HTTP request format.
            </div>
            <div class="code-label">1. Exact Raw HTTP/1.1 Request Sent to SAP Gateway</div>
            <pre>${esc(httpReq.rawHttpWire)}</pre>
            <div class="sub-grid">
              <div>
                <div class="code-label">2. Copy-Pasteable cURL Command</div>
                <pre>${esc(httpReq.curlCommand)}</pre>
              </div>
              <div>
                <div class="code-label">3. Alternative SAP Standard OAuth2 SAML Bearer HTTP Request (RFC 7522)</div>
                <pre>${esc(httpReq.rfc7522OAuthWire)}</pre>
              </div>
            </div>
          </div>

          <div class="step-box sap">
            <div class="step-title">
              <span>✅ Step 4: Actual HTTP Response Received from SAP S/4HANA</span>
              <span class="badge">HTTP ${esc(httpRes.status)} — SAP Transaction: ${esc(httpRes.body.sapResponse.sapTransaction)}</span>
            </div>
            <div class="summary-bar">
              <strong>What SAP did:</strong> SAP verified the SAML 2.0 XML-DSig signature, mapped <code>${esc(httpRes.body.authentication.mappedSapUser)}</code> (<em>${esc(httpRes.body.authentication.sapUserFullName)}</em>), identified the action <code>${esc(httpRes.body.userRequestIdentified.action)}</code>, and returned the OData response below.
            </div>
            <div class="code-label">Raw HTTP/1.1 Response from SAP Service</div>
            <pre>HTTP/1.1 ${esc(httpRes.status)}
Content-Type: ${esc(httpRes.headers['content-type'])}

${esc(JSON.stringify(httpRes.body, null, 2))}</pre>
          </div>
        `;
      } catch (err) {
        out.innerHTML = '<div class="card" style="border-color:#ef4444;color:#fca5a5;">Error: ' + esc(err.message) + '</div>';
      } finally {
        btn.disabled = false;
        btn.textContent = '⚡ Run MCP ➔ SAP Flow';
      }
    }

    runFlow();
  </script>
</body>
</html>
"""


def create_sap_app() -> FastAPI:
    app = FastAPI(title="SAP S/4HANA Mock Gateway & MCP Flow Studio")

    @app.get("/", response_class=HTMLResponse)
    async def index() -> str:
        return FLOW_STUDIO_HTML

    @app.get("/sap/bc/ping")
    async def sap_ping() -> dict[str, Any]:
        return {
            "system": "SAP S/4HANA Mock Server (SID: S4H, Client: 100)",
            "runtime": "Python FastAPI + MCP SDK",
            "status": "AVAILABLE",
            "supportedAuth": [
                "SAML 2.0 Bearer Assertion (Direct Header / Body)",
                "OAuth 2.0 SAML Bearer Assertion Flow (RFC 7522)",
            ],
        }

    @app.post("/api/run-mcp-flow")
    async def run_mcp_flow(request: Request) -> JSONResponse:
        try:
            body = await request.json()
        except Exception:
            body = {}

        port = request.url.port or 4004
        sap_base_url = f"http://localhost:{port}"

        user_id = body.get("userId", "ELDIEBELDIE")
        email = body.get("email", "eldiebeldie@enterprise.local")
        sap_client = body.get("sapClient", "100")
        action = body.get("action", "CREATE_SALES_ORDER")
        parameters = body.get("parameters", {})

        initial_payload = {
            "userId": user_id,
            "email": email,
            "sapClient": sap_client,
            "action": action,
            "parameters": parameters,
        }
        initial_body_str = json.dumps(initial_payload, indent=2)

        step0_browser_http_wire = "\n".join(
            [
                "POST /api/run-mcp-flow HTTP/1.1",
                f"Host: localhost:{port}",
                "Content-Type: application/json",
                f"Content-Length: {len(initial_body_str.encode('utf-8'))}",
                "",
                initial_body_str,
            ]
        )

        step1_mcp_create_jwt_rpc = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "create_jwt_token",
                "arguments": initial_payload,
            },
        }

        print(
            "\n================================================================================"
        )
        print(" 🟢 [STEP 0 - INITIAL REQUEST SENT TO PYTHON MCP SERVER]")
        print(
            "================================================================================"
        )
        print("  • From       : Client / Browser UI")
        print(
            '  • Sent To    : Python MCP Server (src/mcp_server.py over stdio) -> Tool: "create_jwt_token"'
        )
        print(f"  • Who (User) : {user_id} ({email}), SAP Client: {sap_client}")
        print(f"  • What Action: {action}")
        print("\n  📡 [ACTUAL JSON-RPC 2.0 REQUEST SENT TO MCP]:")
        print(json.dumps(step1_mcp_create_jwt_rpc, indent=2))

        server_params = StdioServerParameters(
            command=sys.executable,
            args=["-m", "src.mcp_server"],
            cwd=str(PROJECT_ROOT),
            env={**os.environ, "SAP_BASE_URL": sap_base_url},
        )

        try:
            async with Client(server_params) as mcp_client:
                # Step 1: Call create_jwt_token
                res1 = await mcp_client.call_tool("create_jwt_token", initial_payload)
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
                print("  • Decoded JWT Claims:")
                print(json.dumps(jwt_data["claims"], indent=2))

                step2_mcp_convert_saml_rpc = {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {
                        "name": "convert_jwt_to_saml",
                        "arguments": {"jwtToken": jwt_data["token"]},
                    },
                }

                # Step 2: Call convert_jwt_to_saml
                print(
                    "\n--------------------------------------------------------------------------------"
                )
                print(" 🟣 [STEP 2 - MCP CONVERTED JWT TO SIGNED SAML 2.0 ASSERTION]")
                print(
                    "--------------------------------------------------------------------------------"
                )
                print("  📡 [ACTUAL JSON-RPC 2.0 REQUEST SENT TO MCP SAML CONVERTER]:")
                print(json.dumps(step2_mcp_convert_saml_rpc, indent=2))

                res2 = await mcp_client.call_tool(
                    "convert_jwt_to_saml", {"jwtToken": jwt_data["token"]}
                )
                saml_data = json.loads(res2.content[0].text)

                print(f"\n  • SAML ID    : {saml_data['assertionId']}")
                print(f"  • NameID     : {saml_data['subjectNameId']}")
                print(
                    "  • Signature  : Enveloped XML-DSig (RSA-SHA256 + X.509 Certificate)"
                )
                print("  • Signed SAML 2.0 XML:")
                print(saml_data["signedXml"])

                # Step 3: Call send_saml_to_sap
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

                print("  📡 [RAW HTTP/1.1 WIRE REQUEST SENT TO SAP]:")
                print(sap_exchange["httpRequestSent"]["rawHttpWire"])
                print("\n  💻 [EQUIVALENT CURL COMMAND]:")
                print(sap_exchange["httpRequestSent"]["curlCommand"])
                print(
                    "\n  🔑 [ALTERNATIVE SAP RFC 7522 OAUTH2 SAML BEARER HTTP REQUEST]:"
                )
                print(sap_exchange["httpRequestSent"]["rfc7522OAuthWire"])

                print(
                    "\n--------------------------------------------------------------------------------"
                )
                print(" 📥 [STEP 4 - ACTUAL HTTP RESPONSE RECEIVED FROM SAP SERVICE]")
                print(
                    "--------------------------------------------------------------------------------"
                )
                print(f"HTTP/1.1 {sap_exchange['httpResponseReceived']['status']}")
                print(
                    f"Content-Type: {sap_exchange['httpResponseReceived']['headers']['content-type']}\n"
                )
                print(
                    json.dumps(
                        sap_exchange["httpResponseReceived"]["body"], indent=2
                    )
                )
                print(
                    "================================================================================\n"
                )

                return JSONResponse(
                    {
                        "wireRequests": {
                            "step0_browserHttpWire": step0_browser_http_wire,
                            "step1_mcpCreateJwtRpc": step1_mcp_create_jwt_rpc,
                            "step2_mcpConvertSamlRpc": step2_mcp_convert_saml_rpc,
                        },
                        "jwt": jwt_data,
                        "saml": saml_data,
                        "sapExchange": sap_exchange,
                        "sapResponse": sap_exchange["sapResult"],
                    }
                )
        except Exception as exc:
            return JSONResponse({"error": str(exc)}, status_code=500)

    @app.post("/sap/opu/odata/sap/Z_MCP_GATEWAY_SRV/ExecuteRequest")
    async def sap_execute_request(request: Request) -> JSONResponse:
        try:
            body = await request.json()
        except Exception:
            body = {}

        saml_assertion = body.get("samlAssertion")
        auth_header = request.headers.get("authorization", "")
        if not saml_assertion and auth_header.startswith("SAML2.0 "):
            saml_assertion = auth_header[len("SAML2.0 ") :].strip()

        if not saml_assertion:
            return JSONResponse(
                {
                    "error": "SAP_SAML2_MISSING",
                    "message": "No SAML 2.0 assertion provided. Send `Authorization: SAML2.0 <base64>` header or `samlAssertion` in body.",
                },
                status_code=401,
            )

        try:
            saml_info = verify_and_parse_saml_assertion(saml_assertion)
            name_id = saml_info["nameId"]
            sap_user = SAP_USER_MASTER.get(name_id) or {
                "bname": name_id,
                "fullName": f"{name_id} (Dynamic SAML Mapped User)",
                "department": "Enterprise User",
                "mandt": saml_info.get("sapClient") or "100",
                "costCenter": "CC-1000",
                "authorizedRoles": saml_info.get("roles") or [],
            }

            effective_request = (
                body.get("userRequest")
                or saml_info.get("userRequest")
                or {"action": "GET_SALES_ORDERS", "parameters": {}}
            )
            business_result = execute_sap_business_logic(sap_user, effective_request)

            print(
                "\n--------------------------------------------------------------------------------"
            )
            print(" 🏢 [SAP INTERNAL GATEWAY LOG - SAML 2.0 PRINCIPAL PROPAGATION]")
            print(
                "--------------------------------------------------------------------------------"
            )
            print(
                "  • Endpoint Hit     : POST /sap/opu/odata/sap/Z_MCP_GATEWAY_SRV/ExecuteRequest"
            )
            print(
                "  • SAML Signature   : VALID (Verified against trusted IdP X.509 Certificate)"
            )
            print(
                f"  • Identified User  : {sap_user['bname']} — {sap_user['fullName']} (SAP Client {sap_user['mandt']})"
            )
            print(f"  • User Action      : {effective_request.get('action')}")
            print(f"  • SAP Transaction  : {business_result['sapTransaction']}")
            exec_summary = (
                business_result.get("message")
                or f"Returned {business_result.get('recordCount')} records"
            )
            print(f"  • Execution Result : {exec_summary}")

            return JSONResponse(
                {
                    "sapSystem": f"S4H (Client {sap_user['mandt']})",
                    "authentication": {
                        "protocol": "SAML 2.0 Bearer Assertion (XML-DSig Verified)",
                        "samlAssertionId": saml_info["assertionId"],
                        "trustedIdpIssuer": saml_info["issuer"],
                        "samlSubjectNameId": name_id,
                        "mappedSapUser": sap_user["bname"],
                        "sapUserFullName": sap_user["fullName"],
                        "sapRoles": sap_user["authorizedRoles"],
                    },
                    "userRequestIdentified": effective_request,
                    "sapResponse": business_result,
                }
            )
        except Exception as exc:
            return JSONResponse(
                {
                    "error": "SAP_SAML2_VALIDATION_ERROR",
                    "message": str(exc),
                },
                status_code=403,
            )

    @app.post("/sap/bc/sec/oauth2/token")
    async def sap_oauth_token(
        grant_type: str = Form(...), assertion: str = Form(...)
    ) -> JSONResponse:
        if grant_type != "urn:ietf:params:oauth:grant-type:saml2-bearer":
            return JSONResponse(
                {
                    "error": "unsupported_grant_type",
                    "error_description": "Expected urn:ietf:params:oauth:grant-type:saml2-bearer",
                },
                status_code=400,
            )

        try:
            padded_b64 = assertion.replace("-", "+").replace("_", "/")
            saml_info = verify_and_parse_saml_assertion(padded_b64)
            access_token = f"sap_oauth_{uuid.uuid4().hex}"
            ACTIVE_SAP_OAUTH_TOKENS[access_token] = {
                "samlInfo": saml_info,
                "createdAt": time.time(),
            }
            return JSONResponse(
                {
                    "access_token": access_token,
                    "token_type": "Bearer",
                    "expires_in": 3600,
                    "scope": " ".join(saml_info["roles"]),
                    "sap_user": saml_info["nameId"],
                }
            )
        except Exception as exc:
            return JSONResponse(
                {
                    "error": "invalid_grant",
                    "error_description": str(exc),
                },
                status_code=401,
            )

    return app


def find_available_port(preferred_port: int = 4004) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if s.connect_ex(("127.0.0.1", preferred_port)) != 0:
            return preferred_port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


app = create_sap_app()

if __name__ == "__main__":
    requested_port = int(os.environ.get("SAP_PORT", "4004"))
    port = find_available_port(requested_port)
    base_url = f"http://localhost:{port}"
    should_open = "--open" in sys.argv or os.environ.get("OPEN_BROWSER") == "true"

    print(
        "================================================================================"
    )
    print(" 🚀 SAP Mock Service & Interactive Python MCP Flow Visualizer Ready!")
    print(
        "================================================================================"
    )
    print(f" 🌐 Web UI Visualizer  : {base_url}")
    print(
        f" 🔗 SAP SAML Endpoint  : POST {base_url}/sap/opu/odata/sap/Z_MCP_GATEWAY_SRV/ExecuteRequest"
    )
    print(f" 🔑 SAP OAuth2 Endpoint: POST {base_url}/sap/bc/sec/oauth2/token")
    print(
        "================================================================================\n"
    )

    if should_open:
        print(f" 👉 Opening browser at {base_url} ...\n")
        threading.Timer(1.0, lambda: webbrowser.open(base_url)).start()

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
