import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { verifyAndParseSamlAssertion } from './jwtToSaml.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function openBrowser(url) {
  const platform = process.platform;
  const cmd =
    platform === 'win32'
      ? `start "" "${url}"`
      : platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

// Simulated SAP User Master Data (SU01 / USR02)
const SAP_USER_MASTER = {
  ELDIEBELDIE: {
    bname: 'ELDIEBELDIE',
    fullName: 'eldiebeldie (SAP Senior Architect)',
    department: 'Enterprise Integration & AI',
    mandt: '100',
    costCenter: 'CC-4100',
    authorizedRoles: [
      'SAP_SD_SALES_ORDER_CREATE',
      'SAP_SD_SALES_ORDER_DISPLAY',
      'SAP_MM_PURCHASE_DISPLAY',
      'SAP_MM_PURCHASE_APPROVE',
    ],
  },
  ALICE_FIN: {
    bname: 'ALICE_FIN',
    fullName: 'Alice (Finance Controller)',
    department: 'FI/CO',
    mandt: '100',
    costCenter: 'CC-2000',
    authorizedRoles: ['SAP_FI_INVOICE_APPROVE', 'SAP_SD_SALES_ORDER_DISPLAY'],
  },
};

// Simulated SAP S/4HANA Tables (VBAK Sales Orders & EBAN Purchase Requisitions)
const SAP_SALES_ORDERS = [
  {
    SalesOrder: '0000010042',
    SalesOrderType: 'OR',
    SoldToParty: 'CUST-1001',
    TotalNetAmount: '14500.00',
    TransactionCurrency: 'EUR',
    CreatedByUser: 'ELDIEBELDIE',
    OverallSDProcessStatus: 'OPEN',
  },
  {
    SalesOrder: '0000010043',
    SalesOrderType: 'OR',
    SoldToParty: 'CUST-1001',
    TotalNetAmount: '8200.50',
    TransactionCurrency: 'EUR',
    CreatedByUser: 'ALICE_FIN',
    OverallSDProcessStatus: 'COMPLETED',
  },
  {
    SalesOrder: '0000010044',
    SalesOrderType: 'OR',
    SoldToParty: 'CUST-2009',
    TotalNetAmount: '39900.00',
    TransactionCurrency: 'USD',
    CreatedByUser: 'ELDIEBELDIE',
    OverallSDProcessStatus: 'IN_PROCESS',
  },
];

const SAP_PURCHASE_REQS = [
  {
    PurchaseRequisition: '0010008821',
    Material: 'MAT-AI-GPU-H100',
    Quantity: 4,
    TotalValue: '120000.00',
    Currency: 'USD',
    ReleaseStatus: 'PENDING_APPROVAL',
    ApprovedBy: null,
  },
];

// Active OAuth2 sessions issued via RFC 7522 SAML 2.0 Bearer Assertion
const activeSapOAuthTokens = new Map();

/**
 * Executes the identified user request inside SAP under the authenticated SAP user context.
 */
function executeSapBusinessLogic(sapUser, userRequest) {
  const action = (userRequest?.action || 'GET_SALES_ORDERS').toUpperCase();
  const params = userRequest?.parameters || {};

  switch (action) {
    case 'GET_SALES_ORDERS': {
      const customerFilter = params.customer;
      const results = customerFilter
        ? SAP_SALES_ORDERS.filter((so) => so.SoldToParty === customerFilter)
        : SAP_SALES_ORDERS;

      return {
        sapTransaction: 'VA03 (Display Sales Orders)',
        odataEntitySet: 'A_SalesOrder',
        executedBySapUser: sapUser.bname,
        mandt: sapUser.mandt,
        recordCount: results.length,
        d: { results },
      };
    }

    case 'CREATE_SALES_ORDER': {
      const newOrderNum = String(10045 + SAP_SALES_ORDERS.length).padStart(10, '0');
      const newOrder = {
        SalesOrder: newOrderNum,
        SalesOrderType: params.orderType || 'OR',
        SoldToParty: params.customer || 'CUST-1001',
        Material: params.material || 'MAT-SAP-BTP-LIC',
        RequestedQuantity: params.quantity || 1,
        TotalNetAmount: String(params.amount || '5000.00'),
        TransactionCurrency: params.currency || 'EUR',
        CreatedByUser: sapUser.bname,
        OverallSDProcessStatus: 'CREATED',
      };
      SAP_SALES_ORDERS.push(newOrder);

      return {
        sapTransaction: 'VA01 (Create Sales Order)',
        odataEntitySet: 'A_SalesOrder',
        executedBySapUser: sapUser.bname,
        mandt: sapUser.mandt,
        message: `Sales Order ${newOrderNum} created in SAP Client ${sapUser.mandt} by ${sapUser.bname}`,
        d: newOrder,
      };
    }

    case 'APPROVE_PURCHASE_REQ': {
      const prNum = params.purchaseRequisition || '0010008821';
      let pr = SAP_PURCHASE_REQS.find((item) => item.PurchaseRequisition === prNum);
      if (!pr) {
        pr = {
          PurchaseRequisition: prNum,
          Material: params.material || 'MAT-SERVER-01',
          Quantity: params.quantity || 1,
          TotalValue: String(params.amount || '15000.00'),
          Currency: 'EUR',
          ReleaseStatus: 'APPROVED',
          ApprovedBy: sapUser.bname,
        };
        SAP_PURCHASE_REQS.push(pr);
      } else {
        pr.ReleaseStatus = 'APPROVED';
        pr.ApprovedBy = sapUser.bname;
      }

      return {
        sapTransaction: 'ME54N (Release Purchase Requisition)',
        odataEntitySet: 'A_PurchaseRequisitionHeader',
        executedBySapUser: sapUser.bname,
        mandt: sapUser.mandt,
        message: `Purchase Requisition ${prNum} approved by ${sapUser.bname}`,
        d: pr,
      };
    }

    default: {
      return {
        sapTransaction: 'SE37 / Custom RFC & OData Execution',
        executedBySapUser: sapUser.bname,
        mandt: sapUser.mandt,
        identifiedAction: action,
        parametersReceived: params,
        message: `SAP identified user ${sapUser.bname} (${sapUser.fullName}) via SAML 2.0 and executed custom request '${action}'.`,
      };
    }
  }
}

export function createSapApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  // Interactive Web UI to visually trigger & inspect the MCP -> JWT -> SAML -> SAP flow + Raw HTTP Requests
  app.get('/', (_req, res) => {
    res.type('html').send(`<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <title>⚡ MCP → JWT → SAML 2.0 → SAP Flow Studio | by @eldiebeldie</title>
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
        <h1>⚡ MCP ➔ JWT ➔ SAML 2.0 ➔ SAP S/4HANA Studio</h1>
        <p class="sub">Interactive Principal Propagation & Raw HTTP Wire Inspector — Learn how every JSON-RPC & HTTP request is constructed and sent.</p>
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
      out.innerHTML = '<div class="card">🚀 Sending initial request to MCP Server over stdio...</div>';

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

        out.innerHTML = \`
          <div class="step-box init">
            <div class="step-title">
              <span>🟢 Step 0: Initial Request Sent (Browser HTTP ➔ MCP JSON-RPC 2.0)</span>
              <span class="badge">Destination: MCP Server (src/mcpServer.js)</span>
            </div>
            <div class="summary-bar">
              <strong>What is sent & where:</strong> The client sends an HTTP POST to <code>/api/run-mcp-flow</code>, which sends a <strong>JSON-RPC 2.0 <code>tools/call</code></strong> message over <code>stdio</code> to the MCP Server invoking tool <code>create_jwt_token</code> for SAP user <code>\${esc(initialPayload.userId)}</code>.
            </div>
            <div class="sub-grid">
              <div>
                <div class="code-label">1. Browser ➔ Demo Server (Raw HTTP Request)</div>
                <pre>\${esc(data.wireRequests.step0_browserHttpWire)}</pre>
              </div>
              <div>
                <div class="code-label">2. MCP Client ➔ MCP Server (JSON-RPC 2.0 Request over stdio)</div>
                <pre>\${esc(JSON.stringify(data.wireRequests.step1_mcpCreateJwtRpc, null, 2))}</pre>
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
                <pre><strong>Raw JWT Token:</strong>\n\${esc(data.jwt.token)}\n\n<strong>Decoded Header:</strong>\n\${esc(JSON.stringify(data.jwt.header, null, 2))}\n\n<strong>Decoded Claims:</strong>\n\${esc(JSON.stringify(data.jwt.claims, null, 2))}</pre>
              </div>
              <div>
                <div class="code-label">MCP Client ➔ MCP Server (JSON-RPC 2.0 Request to convert_jwt_to_saml)</div>
                <pre>\${esc(JSON.stringify(data.wireRequests.step2_mcpConvertSamlRpc, null, 2))}</pre>
              </div>
            </div>
          </div>

          <div class="step-box saml">
            <div class="step-title">
              <span>🟣 Step 2: JWT Converted into Signed SAML 2.0 Bearer Assertion</span>
              <span class="badge">XML-DSig (RSA-SHA256 + Exclusive C14N)</span>
            </div>
            <div class="summary-bar">
              <strong>What happened:</strong> The JWT claims were mapped into an OASIS <code>&lt;saml2:Assertion&gt;</code> for <code>&lt;saml2:NameID&gt;\${esc(data.saml.subjectNameId)}&lt;/saml2:NameID&gt;</code>, signed with our X.509 certificate, and Base64-encoded for HTTP transport.
            </div>
            <div class="sub-grid">
              <div>
                <div class="code-label">Signed SAML 2.0 XML Assertion</div>
                <pre>\${esc(data.saml.signedXml)}</pre>
              </div>
              <div>
                <div class="code-label">Base64-Encoded SAML Assertion (Ready for HTTP Header)</div>
                <pre>\${esc(data.saml.samlBase64)}</pre>
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
            <pre>\${esc(httpReq.rawHttpWire)}</pre>
            <div class="sub-grid">
              <div>
                <div class="code-label">2. Copy-Pasteable cURL Command</div>
                <pre>\${esc(httpReq.curlCommand)}</pre>
              </div>
              <div>
                <div class="code-label">3. Alternative SAP Standard OAuth2 SAML Bearer HTTP Request (RFC 7522)</div>
                <pre>\${esc(httpReq.rfc7522OAuthWire)}</pre>
              </div>
            </div>
          </div>

          <div class="step-box sap">
            <div class="step-title">
              <span>✅ Step 4: Actual HTTP Response Received from SAP S/4HANA</span>
              <span class="badge">HTTP \${esc(httpRes.status)} — SAP Transaction: \${esc(httpRes.body.sapResponse.sapTransaction)}</span>
            </div>
            <div class="summary-bar">
              <strong>What SAP did:</strong> SAP verified the SAML 2.0 XML-DSig signature, mapped <code>\${esc(httpRes.body.authentication.mappedSapUser)}</code> (<em>\${esc(httpRes.body.authentication.sapUserFullName)}</em>), identified the action <code>\${esc(httpRes.body.userRequestIdentified.action)}</code>, and returned the OData response below.
            </div>
            <div class="code-label">Raw HTTP/1.1 Response from SAP Service</div>
            <pre>HTTP/1.1 \${esc(httpRes.status)}
Content-Type: \${esc(httpRes.headers['content-type'])}

\${esc(JSON.stringify(httpRes.body, null, 2))}</pre>
          </div>
        \`;
      } catch (err) {
        out.innerHTML = '<div class="card" style="border-color:#ef4444;color:#fca5a5;">Error: ' + esc(err.message) + '</div>';
      } finally {
        btn.disabled = false;
        btn.textContent = '⚡ Run MCP ➔ SAP Flow';
      }
    }

    // Run once automatically on page load
    runFlow();
  </script>
</body>
</html>`);
  });

  // API endpoint used by the Visualizer UI to invoke the real MCP server and return full wire artifacts
  app.post('/api/run-mcp-flow', async (req, res) => {
    const port = req.socket.localPort || 4004;
    const sapBaseUrl = `http://localhost:${port}`;
    const mcpServerPath = path.join(__dirname, 'mcpServer.js');

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpServerPath],
      env: { ...process.env, SAP_BASE_URL: sapBaseUrl },
    });

    const mcpClient = new Client(
      { name: 'sap-ui-visualizer-client', version: '1.0.0' },
      { capabilities: {} }
    );

    try {
      await mcpClient.connect(transport);

      const {
        userId = 'ELDIEBELDIE',
        email = 'eldiebeldie@enterprise.local',
        sapClient = '100',
        action = 'CREATE_SALES_ORDER',
        parameters = {},
      } = req.body || {};

      const initialRequestPayload = { userId, email, sapClient, action, parameters };
      const initialBodyStr = JSON.stringify(initialRequestPayload, null, 2);

      // Construct exact raw wire representations for learning & logging
      const step0_browserHttpWire = [
        `POST /api/run-mcp-flow HTTP/1.1`,
        `Host: localhost:${port}`,
        `Content-Type: application/json`,
        `Content-Length: ${Buffer.byteLength(initialBodyStr, 'utf8')}`,
        ``,
        initialBodyStr,
      ].join('\n');

      const step1_mcpCreateJwtRpc = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'create_jwt_token',
          arguments: initialRequestPayload,
        },
      };

      console.log('\n================================================================================');
      console.log(' 🟢 [STEP 0 - INITIAL REQUEST SENT TO MCP SERVER]');
      console.log('================================================================================');
      console.log('  • From       : Client / Browser UI');
      console.log('  • Sent To    : MCP Server (src/mcpServer.js over stdio) -> Tool: "create_jwt_token"');
      console.log('  • Who (User) :', `${userId} (${email}), SAP Client: ${sapClient}`);
      console.log('  • What Action:', action);
      console.log('\n  📡 [ACTUAL JSON-RPC 2.0 REQUEST SENT TO MCP]:');
      console.log(JSON.stringify(step1_mcpCreateJwtRpc, null, 2));

      // Call MCP Tool 1: create_jwt_token
      const step1 = await mcpClient.callTool({
        name: 'create_jwt_token',
        arguments: initialRequestPayload,
      });
      const jwtData = JSON.parse(step1.content[0].text);

      console.log('\n--------------------------------------------------------------------------------');
      console.log(' 🔵 [STEP 1 - MCP CREATED SIGNED JWT TOKEN]');
      console.log('--------------------------------------------------------------------------------');
      console.log('  • Algorithm  : RS256 (Signed with IdP RSA Private Key)');
      console.log('  • Raw JWT    :', jwtData.token);
      console.log('  • Decoded JWT Claims:');
      console.log(JSON.stringify(jwtData.claims, null, 2));

      const step2_mcpConvertSamlRpc = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'convert_jwt_to_saml',
          arguments: { jwtToken: jwtData.token },
        },
      };

      // Call MCP Tool 2: convert_jwt_to_saml
      console.log('\n--------------------------------------------------------------------------------');
      console.log(' 🟣 [STEP 2 - MCP CONVERTED JWT TO SIGNED SAML 2.0 ASSERTION]');
      console.log('--------------------------------------------------------------------------------');
      console.log('  📡 [ACTUAL JSON-RPC 2.0 REQUEST SENT TO MCP SAML CONVERTER]:');
      console.log(JSON.stringify(step2_mcpConvertSamlRpc, null, 2));

      const step2 = await mcpClient.callTool({
        name: 'convert_jwt_to_saml',
        arguments: { jwtToken: jwtData.token },
      });
      const samlData = JSON.parse(step2.content[0].text);
      console.log('\n  • SAML ID    :', samlData.assertionId);
      console.log('  • NameID     :', samlData.subjectNameId);
      console.log('  • Signature  : Enveloped XML-DSig (RSA-SHA256 + X.509 Certificate)');
      console.log('  • Signed SAML 2.0 XML:');
      console.log(samlData.signedXml);

      // Call MCP Tool 3: send_saml_to_sap
      console.log('\n--------------------------------------------------------------------------------');
      console.log(' 🟠 [STEP 3 - ACTUAL HTTP REQUEST SENT TO SAP SERVICE]');
      console.log('--------------------------------------------------------------------------------');

      const step3 = await mcpClient.callTool({
        name: 'send_saml_to_sap',
        arguments: { samlBase64: samlData.samlBase64, sapBaseUrl },
      });
      const sapExchange = JSON.parse(step3.content[0].text);

      console.log('  📡 [RAW HTTP/1.1 WIRE REQUEST SENT TO SAP]:');
      console.log(sapExchange.httpRequestSent.rawHttpWire);
      console.log('\n  💻 [EQUIVALENT CURL COMMAND]:');
      console.log(sapExchange.httpRequestSent.curlCommand);
      console.log('\n  🔑 [ALTERNATIVE SAP RFC 7522 OAUTH2 SAML BEARER HTTP REQUEST]:');
      console.log(sapExchange.httpRequestSent.rfc7522OAuthWire);

      console.log('\n--------------------------------------------------------------------------------');
      console.log(' 📥 [STEP 4 - ACTUAL HTTP RESPONSE RECEIVED FROM SAP SERVICE]');
      console.log('--------------------------------------------------------------------------------');
      console.log(`HTTP/1.1 ${sapExchange.httpResponseReceived.status}`);
      console.log(`Content-Type: ${sapExchange.httpResponseReceived.headers['content-type']}\n`);
      console.log(JSON.stringify(sapExchange.httpResponseReceived.body, null, 2));
      console.log('================================================================================\n');

      res.json({
        wireRequests: {
          step0_browserHttpWire,
          step1_mcpCreateJwtRpc,
          step2_mcpConvertSamlRpc,
        },
        jwt: jwtData,
        saml: samlData,
        sapExchange,
        sapResponse: sapExchange.sapResult,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      await mcpClient.close().catch(() => {});
    }
  });

  // Health / Metadata check
  app.get('/sap/bc/ping', (_req, res) => {
    res.json({
      system: 'SAP S/4HANA Mock Server (SID: S4H, Client: 100)',
      status: 'AVAILABLE',
      supportedAuth: [
        'SAML 2.0 Bearer Assertion (Direct Header / Body)',
        'OAuth 2.0 SAML Bearer Assertion Flow (RFC 7522)',
      ],
    });
  });

  /**
   * Option A (Easiest Direct Way):
   * Send the SAML 2.0 Assertion directly in `Authorization: SAML2.0 <base64>` or JSON body
   * to the SAP Gateway endpoint. SAP verifies the SAML signature, maps NameID -> SAP User,
   * identifies the user's request, and executes it immediately.
   */
  app.post('/sap/opu/odata/sap/Z_MCP_GATEWAY_SRV/ExecuteRequest', (req, res) => {
    try {
      let samlAssertion = req.body?.samlAssertion;
      const authHeader = req.headers.authorization || '';
      if (!samlAssertion && authHeader.startsWith('SAML2.0 ')) {
        samlAssertion = authHeader.slice('SAML2.0 '.length).trim();
      }

      if (!samlAssertion) {
        return res.status(401).json({
          error: 'SAP_SAML2_MISSING',
          message:
            'No SAML 2.0 assertion provided. Send `Authorization: SAML2.0 <base64>` header or `samlAssertion` in body.',
        });
      }

      // 1. Verify SAML 2.0 XML-DSig signature and extract claims
      const samlInfo = verifyAndParseSamlAssertion(samlAssertion);

      // 2. Map SAML Subject NameID to SAP User Master (SU01 / USR02)
      const sapUser = SAP_USER_MASTER[samlInfo.nameId] || {
        bname: samlInfo.nameId,
        fullName: `${samlInfo.nameId} (Dynamic SAML Mapped User)`,
        department: 'Enterprise User',
        mandt: samlInfo.sapClient || '100',
        costCenter: 'CC-1000',
        authorizedRoles: samlInfo.roles,
      };

      // 3. Identify the user request (either explicitly passed in HTTP body or carried in SAML AttributeStatement)
      const effectiveRequest = req.body?.userRequest ||
        samlInfo.userRequest || { action: 'GET_SALES_ORDERS', parameters: {} };

      // 4. Execute the SAP business action as that SAP user
      const businessResult = executeSapBusinessLogic(sapUser, effectiveRequest);

      console.log('\n--------------------------------------------------------------------------------');
      console.log(' 🏢 [SAP INTERNAL GATEWAY LOG - SAML 2.0 PRINCIPAL PROPAGATION]');
      console.log('--------------------------------------------------------------------------------');
      console.log('  • Endpoint Hit     : POST /sap/opu/odata/sap/Z_MCP_GATEWAY_SRV/ExecuteRequest');
      console.log('  • SAML Signature   : VALID (Verified against trusted IdP X.509 Certificate)');
      console.log(`  • Identified User  : ${sapUser.bname} — ${sapUser.fullName} (SAP Client ${sapUser.mandt})`);
      console.log(`  • User Action      : ${effectiveRequest.action}`);
      console.log(`  • SAP Transaction  : ${businessResult.sapTransaction}`);
      console.log(`  • Execution Result : ${businessResult.message || `Returned ${businessResult.recordCount} records`}`);

      return res.status(200).json({
        sapSystem: 'S4H (Client ' + sapUser.mandt + ')',
        authentication: {
          protocol: 'SAML 2.0 Bearer Assertion (XML-DSig Verified)',
          samlAssertionId: samlInfo.assertionId,
          trustedIdpIssuer: samlInfo.issuer,
          samlSubjectNameId: samlInfo.nameId,
          mappedSapUser: sapUser.bname,
          sapUserFullName: sapUser.fullName,
          sapRoles: sapUser.authorizedRoles,
        },
        userRequestIdentified: effectiveRequest,
        sapResponse: businessResult,
      });
    } catch (err) {
      return res.status(403).json({
        error: 'SAP_SAML2_VALIDATION_ERROR',
        message: err.message,
      });
    }
  });

  /**
   * Option B (SAP Standard OAuth2SAMLBearerAssertion Endpoint - /sap/bc/sec/oauth2/token):
   * Exchanges a SAML 2.0 Bearer Assertion for an SAP OAuth 2.0 Access Token.
   */
  app.post('/sap/bc/sec/oauth2/token', (req, res) => {
    try {
      const { grant_type, assertion } = req.body;
      if (grant_type !== 'urn:ietf:params:oauth:grant-type:saml2-bearer') {
        return res.status(400).json({
          error: 'unsupported_grant_type',
          error_description: 'Expected urn:ietf:params:oauth:grant-type:saml2-bearer',
        });
      }

      const paddedB64 = assertion.replace(/-/g, '+').replace(/_/g, '/');
      const samlInfo = verifyAndParseSamlAssertion(paddedB64);

      const accessToken = `sap_oauth_${crypto.randomUUID().replace(/-/g, '')}`;
      activeSapOAuthTokens.set(accessToken, {
        samlInfo,
        createdAt: Date.now(),
      });

      return res.status(200).json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: samlInfo.roles.join(' '),
        sap_user: samlInfo.nameId,
      });
    } catch (err) {
      return res.status(401).json({
        error: 'invalid_grant',
        error_description: err.message,
      });
    }
  });

  return app;
}

export function startSapServer(port = 4004) {
  const app = createSapApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      const actualPort = server.address().port;
      resolve({
        server,
        port: actualPort,
        baseUrl: `http://localhost:${actualPort}`,
      });
    });
    server.once('error', reject);
  });
}

// Run standalone if invoked directly via `npm start`, `npm run demo`, or `npm run start:sap`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const requestedPort = Number(process.env.SAP_PORT || 4004);
  const shouldOpenBrowser =
    process.argv.includes('--open') || process.env.OPEN_BROWSER === 'true';

  startSapServer(requestedPort)
    .catch(() => startSapServer(0))
    .then(({ baseUrl }) => {
      console.log('================================================================================');
      console.log(' 🚀 SAP Mock Service & Interactive MCP Flow Visualizer Ready!');
      console.log('================================================================================');
      console.log(` 🌐 Web UI Visualizer  : ${baseUrl}`);
      console.log(` 🔗 SAP SAML Endpoint  : POST ${baseUrl}/sap/opu/odata/sap/Z_MCP_GATEWAY_SRV/ExecuteRequest`);
      console.log(` 🔑 SAP OAuth2 Endpoint: POST ${baseUrl}/sap/bc/sec/oauth2/token`);
      console.log('================================================================================\n');

      if (shouldOpenBrowser) {
        console.log(` 👉 Opening browser at ${baseUrl} ...\n`);
        openBrowser(baseUrl);
      }
    });
}
