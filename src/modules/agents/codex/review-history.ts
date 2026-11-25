import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { reviewDecisionQuery, reviewDecisionTool } from '../../../core/review-decisions.js';
import { redact, safeEqual } from '../../../core/security.js';
import type { SessionInput } from '../../../runtime/agent.js';

export async function startReviewHistory(input: SessionInput) {
  const authorization = 'Bearer ' + randomBytes(32).toString('hex');
  const mcp = new McpServer({ name: 'daddyloop_history', version: '1' });
  mcp.registerTool(
    reviewDecisionTool.name,
    {
      description: reviewDecisionTool.description,
      inputSchema: reviewDecisionQuery,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        input.signal.throwIfAborted();
        const page = await input.onTool(reviewDecisionTool.name, args);
        return { content: [{ type: 'text', text: JSON.stringify(page) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: redact(String(error)) }] };
      }
    },
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: randomUUID,
  });
  const http = Fastify({ bodyLimit: 16_384, forceCloseConnections: true });
  http.all('/', async (request, reply) => {
    if (input.signal.aborted || !safeEqual(request.headers.authorization ?? '', authorization))
      return reply.code(403).send();
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers))
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    return reply.send(
      await transport.handleRequest(
        new Request('http://127.0.0.1/', {
          method: request.method,
          headers,
        }),
        { parsedBody: request.body },
      ),
    );
  });
  const close = async () => {
    await mcp.close();
    await http.close();
  };
  try {
    await mcp.connect(transport);
    const url = await http.listen({ host: '127.0.0.1', port: 0 });
    return {
      config: {
        daddyloop_history: {
          url,
          http_headers: { Authorization: authorization },
          required: true,
        },
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
