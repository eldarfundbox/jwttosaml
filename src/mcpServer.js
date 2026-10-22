import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createJwtToken, convertJwtToSaml } from './jwtToSaml.js';

const DEFAULT_SAP_BASE_URL = process.env.SAP_BASE_URL || 'http://localhost:4004';

/**
 * Helper to build the exact raw HTTP wire representation & curl command,
 * then send the Base64-encoded SAML 2.0 Assertion to the SAP service.
 */
export async function postSamlToSap({
  samlBase64,
  userRequest,
  sapBaseUrl = DEFAULT_SAP_BASE_URL,
}) {
  const endpointPath = '/sap/opu/odata/sap/Z_MCP_GATEWAY_SRV/ExecuteRequest';
  const endpoint = `${sapBaseUrl}${endpointPath}`;
  const parsedUrl = new URL(endpoint);

  const requestBodyObj = { userRequest };
  const requestBodyStr = JSON.stringify(requestBodyObj, null, 2);

  const headers = {
    Host: parsedUrl.host,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `SAML2.0 ${samlBase64}`,
  };

  // Raw HTTP/1.1 Wire Format (Direct SAML 2.0 Header to SAP Gateway)
  const rawHttpWire = [
    `POST ${endpointPath} HTTP/1.1`,
    `Host: ${parsedUrl.host}`,
    `Content-Type: application/json`,
    `Accept: application/json`,
    `Authorization: SAML2.0 ${samlBase64}`,
    `Content-Length: ${Buffer.byteLength(requestBodyStr, 'utf8')}`,
    ``,
    requestBodyStr,
  ].join('\n');

  // Alternative SAP Standard RFC 7522 OAuth2 SAML Bearer Token Exchange HTTP Wire Format
  const oauthFormBody = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Asaml2-bearer&assertion=${encodeURIComponent(
    samlBase64
  )}`;
  const rfc7522OAuthWire = [
    `POST /sap/bc/sec/oauth2/token HTTP/1.1`,
    `Host: ${parsedUrl.host}`,
    `Content-Type: application/x-www-form-urlencoded`,
    `Content-Length: ${Buffer.byteLength(oauthFormBody, 'utf8')}`,
    ``,
    oauthFormBody,
  ].join('\n');

  // Copy-pasteable curl command
  const curlCommand = `curl -X POST "${endpoint}" \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: SAML2.0 ${samlBase64}" \\\n  -d '${JSON.stringify(
    requestBodyObj
  )}'`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `SAML2.0 ${samlBase64}`,
    },
    body: requestBodyStr,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      `SAP returned HTTP ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return {
    httpRequestSent: {
      method: 'POST',
      url: endpoint,
      headers,
      body: requestBodyObj,
      rawHttpWire,
      rfc7522OAuthWire,
      curlCommand,
    },
    httpResponseReceived: {
      status: `${response.status} ${response.statusText}`,
      headers: {
        'content-type': response.headers.get('content-type'),
      },
      body: data,
    },
    sapResult: data,
  };
}

export function buildMcpServer() {
  const server = new McpServer({
    name: 'sap-jwt-to-saml-mcp',
    version: '1.0.0',
  });

  // Tool 1: End-to-End Flow (Request -> MCP creates JWT -> Converts JWT to SAML -> Sends SAML to SAP -> SAP executes)
  server.tool(
    'execute_sap_request',
    'End-to-end flow: receives a user request, creates a signed JWT token, converts the JWT into a signed SAML 2.0 Bearer Assertion, and sends it to SAP to authenticate the user and execute the action.',
    {
      userId: z
        .string()
        .default('ELDIEBELDIE')
        .describe('SAP User ID (e.g., ELDIEBELDIE or ALICE_FIN)'),
      email: z
        .string()
        .default('eldiebeldie@enterprise.local')
        .describe('User email address'),
      sapClient: z
        .string()
        .default('100')
        .describe('SAP Client / Mandant (e.g., 100)'),
      action: z
        .enum([
          'GET_SALES_ORDERS',
          'CREATE_SALES_ORDER',
          'APPROVE_PURCHASE_REQ',
          'CUSTOM_ACTION',
        ])
        .default('GET_SALES_ORDERS')
        .describe('The business operation SAP should execute for the user'),
      parameters: z
        .record(z.any())
        .optional()
        .describe(
          'Action parameters (e.g., { customer: "CUST-1001", material: "MAT-SAP-BTP-LIC", amount: 5000 })'
        ),
      sapBaseUrl: z
        .string()
        .optional()
        .describe('Base URL of the SAP service (defaults to http://localhost:4004)'),
    },
    async ({ userId, email, sapClient, action, parameters = {}, sapBaseUrl }) => {
      const userRequest = { action, parameters };

      // Step 1: MCP creates a signed RS256 JWT token
      const jwtResult = createJwtToken({
        userId,
        email,
        sapClient,
        userRequest,
      });

      // Step 2: Convert the JWT token into a signed SAML 2.0 Bearer Assertion
      const samlResult = convertJwtToSaml(jwtResult.token);

      // Step 3: Send the SAML 2.0 Assertion to the SAP service in the easiest way (Authorization: SAML2.0 <base64>)
      const sapExchange = await postSamlToSap({
        samlBase64: samlResult.samlBase64,
        userRequest,
        sapBaseUrl: sapBaseUrl || DEFAULT_SAP_BASE_URL,
      });

      const flowSummary = {
        step1_jwtCreatedByMcp: {
          tokenPreview: `${jwtResult.token.slice(0, 48)}...`,
          jwtFullToken: jwtResult.token,
          header: jwtResult.header,
          claims: jwtResult.claims,
        },
        step2_jwtConvertedToSaml: {
          assertionId: samlResult.assertionId,
          subjectNameId: samlResult.subjectNameId,
          issuer: samlResult.issuer,
          audience: samlResult.audience,
          samlBase64: samlResult.samlBase64,
          signedXml: samlResult.signedXml,
        },
        step3_httpRequestToSap: sapExchange.httpRequestSent,
        step4_sapHttpResponse: sapExchange.httpResponseReceived,
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(flowSummary, null, 2),
          },
        ],
      };
    }
  );

  // Tool 2: Step 1 only - Create a signed JWT token
  server.tool(
    'create_jwt_token',
    'Step 1: Creates a signed RS256 JWT token for an SAP user and their request payload.',
    {
      userId: z.string().default('ELDIEBELDIE'),
      email: z.string().default('eldiebeldie@enterprise.local'),
      sapClient: z.string().default('100'),
      action: z.string().default('GET_SALES_ORDERS'),
      parameters: z.record(z.any()).optional(),
    },
    async ({ userId, email, sapClient, action, parameters = {} }) => {
      const result = createJwtToken({
        userId,
        email,
        sapClient,
        userRequest: { action, parameters },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool 3: Step 2 only - Convert JWT token to SAML 2.0 Assertion
  server.tool(
    'convert_jwt_to_saml',
    'Step 2: Validates a JWT token and converts it into a signed SAML 2.0 Bearer Assertion (XML & Base64).',
    {
      jwtToken: z.string().describe('The RS256 JWT token created by create_jwt_token'),
    },
    async ({ jwtToken }) => {
      const samlResult = convertJwtToSaml(jwtToken);
      return {
        content: [{ type: 'text', text: JSON.stringify(samlResult, null, 2) }],
      };
    }
  );

  // Tool 4: Step 3 only - Send SAML 2.0 Assertion to SAP Service
  server.tool(
    'send_saml_to_sap',
    'Step 3: Sends a Base64-encoded SAML 2.0 Assertion to the SAP service so SAP authenticates the user and executes the request.',
    {
      samlBase64: z.string().describe('Base64-encoded signed SAML 2.0 Assertion'),
      action: z.string().optional().describe('Optional action override'),
      parameters: z.record(z.any()).optional().describe('Optional action parameters'),
      sapBaseUrl: z.string().optional(),
    },
    async ({ samlBase64, action, parameters, sapBaseUrl }) => {
      const userRequest = action ? { action, parameters: parameters || {} } : undefined;
      const sapExchange = await postSamlToSap({
        samlBase64,
        userRequest,
        sapBaseUrl: sapBaseUrl || DEFAULT_SAP_BASE_URL,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(sapExchange, null, 2) }],
      };
    }
  );

  return server;
}

// Start stdio transport when run directly
const transport = new StdioServerTransport();
const server = buildMcpServer();
await server.connect(transport);
