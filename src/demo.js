import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startSapServer } from './sapService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runDemo() {
  console.log('================================================================================');
  console.log(' 🚀 MCP -> JWT -> SAML 2.0 -> SAP Principal Propagation Demo (CLI)');
  console.log('================================================================================\n');

  // 1. Start the Mock SAP Service (uses port 0 if 4004 is already in use)
  let sapServerInfo;
  try {
    sapServerInfo = await startSapServer(Number(process.env.SAP_PORT || 4004));
  } catch {
    sapServerInfo = await startSapServer(0);
  }
  const { server: sapHttpServer, baseUrl: sapBaseUrl } = sapServerInfo;
  console.log(`✅ [Setup 1/2] Mock SAP S/4HANA Service started at ${sapBaseUrl}`);

  // 2. Connect an MCP Client to our MCP Server over stdio
  const mcpServerPath = path.join(__dirname, 'mcpServer.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServerPath],
    env: {
      ...process.env,
      SAP_BASE_URL: sapBaseUrl,
    },
  });

  const mcpClient = new Client(
    { name: 'sap-demo-mcp-client', version: '1.0.0' },
    { capabilities: {} }
  );

  await mcpClient.connect(transport);
  const { tools } = await mcpClient.listTools();
  console.log(
    `✅ [Setup 2/2] Connected to MCP Server (src/mcpServer.js). Tools: ${tools.map((t) => t.name).join(', ')}\n`
  );

  const initialRequest = {
    userId: 'ELDIEBELDIE',
    email: 'eldiebeldie@enterprise.local',
    sapClient: '100',
    action: 'CREATE_SALES_ORDER',
    parameters: {
      customer: 'CUST-1001',
      material: 'MAT-SAP-AI-CORE',
      quantity: 2,
      amount: '18500.00',
      currency: 'EUR',
    },
  };

  const step1RpcWire = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'create_jwt_token',
      arguments: initialRequest,
    },
  };

  console.log('================================================================================');
  console.log(' 🟢 [STEP 0 - INITIAL REQUEST SENT TO MCP SERVER]');
  console.log('================================================================================');
  console.log('  • From       : Demo Client (src/demo.js)');
  console.log('  • Sent To    : MCP Server (src/mcpServer.js via stdio) -> Tool: "create_jwt_token"');
  console.log('  • Who (User) :', `${initialRequest.userId} (${initialRequest.email}), SAP Client: ${initialRequest.sapClient}`);
  console.log('  • What Action:', initialRequest.action);
  console.log('\n  📡 [ACTUAL JSON-RPC 2.0 REQUEST SENT TO MCP]:');
  console.log(JSON.stringify(step1RpcWire, null, 2));

  // Step 1: MCP creates the signed JWT
  const step1 = await mcpClient.callTool({
    name: 'create_jwt_token',
    arguments: initialRequest,
  });
  const jwtData = JSON.parse(step1.content[0].text);

  console.log('\n--------------------------------------------------------------------------------');
  console.log(' 🔵 [STEP 1 - MCP CREATED SIGNED JWT TOKEN]');
  console.log('--------------------------------------------------------------------------------');
  console.log('  • Algorithm  : RS256 (Signed with IdP RSA Private Key)');
  console.log('  • Raw JWT    :', jwtData.token);
  console.log('  • Decoded JWT Header:');
  console.log(JSON.stringify(jwtData.header, null, 2));
  console.log('  • Decoded JWT Claims:');
  console.log(JSON.stringify(jwtData.claims, null, 2));

  const step2RpcWire = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'convert_jwt_to_saml',
      arguments: { jwtToken: jwtData.token },
    },
  };

  // Step 2: MCP converts the JWT into a signed SAML 2.0 Assertion
  console.log('\n--------------------------------------------------------------------------------');
  console.log(' 🟣 [STEP 2 - MCP CONVERTED JWT TO SIGNED SAML 2.0 ASSERTION]');
  console.log('--------------------------------------------------------------------------------');
  console.log('  📡 [ACTUAL JSON-RPC 2.0 REQUEST SENT TO MCP SAML CONVERTER]:');
  console.log(JSON.stringify(step2RpcWire, null, 2));

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

  // Step 3: MCP sends the SAML 2.0 Assertion to SAP over HTTP
  console.log('\n--------------------------------------------------------------------------------');
  console.log(' 🟠 [STEP 3 - ACTUAL HTTP REQUEST SENT TO SAP SERVICE]');
  console.log('--------------------------------------------------------------------------------');

  const step3 = await mcpClient.callTool({
    name: 'send_saml_to_sap',
    arguments: {
      samlBase64: samlData.samlBase64,
      sapBaseUrl,
    },
  });
  const sapExchange = JSON.parse(step3.content[0].text);

  console.log('\n  📡 [1. EXACT RAW HTTP/1.1 WIRE REQUEST SENT TO SAP GATEWAY]:');
  console.log(sapExchange.httpRequestSent.rawHttpWire);

  console.log('\n  💻 [2. COPY-PASTEABLE CURL COMMAND]:');
  console.log(sapExchange.httpRequestSent.curlCommand);

  console.log('\n  🔑 [3. ALTERNATIVE SAP RFC 7522 OAUTH2 SAML BEARER HTTP REQUEST]:');
  console.log(sapExchange.httpRequestSent.rfc7522OAuthWire);

  console.log('\n--------------------------------------------------------------------------------');
  console.log(' ✅ [STEP 4 - ACTUAL HTTP RESPONSE RECEIVED FROM SAP SERVICE]');
  console.log('--------------------------------------------------------------------------------');
  console.log(`HTTP/1.1 ${sapExchange.httpResponseReceived.status}`);
  console.log(`Content-Type: ${sapExchange.httpResponseReceived.headers['content-type']}\n`);
  console.log(JSON.stringify(sapExchange.httpResponseReceived.body, null, 2));

  // Cleanup
  await mcpClient.close();
  sapHttpServer.close();
  console.log('\n✅ Demo completed successfully!');
}

runDemo().catch((err) => {
  console.error('❌ Demo failed:', err);
  process.exit(1);
});
