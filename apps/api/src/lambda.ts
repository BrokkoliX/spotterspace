import { ApolloServer } from '@apollo/server';
import type { GraphQLRequest } from '@apollo/server';

import { validateJwtSecret } from './auth/validateSecret.js';
import { type Context } from './context.js';
import { resolvers } from './resolvers.js';
import { typeDefs } from './schema.js';

// Singleton server instance for Lambda cold-start efficiency
let server: ApolloServer<Context> | null = null;

// Lazy secret initialization (first invocation fetches secrets from Secrets Manager)
let initPromise: Promise<void> | null = null;

async function initSecrets(): Promise<void> {
  if (process.env.DATABASE_URL) return; // Already set (local dev)

  const { GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const { SecretsManagerClient } = await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({
    region: process.env['AWS_REGION_NAME'] || 'us-east-1',
  });

  const dbSecretId = process.env['DB_SECRET_ARN'] ?? 'spotterspace/DATABASE_URL';
  const jwtSecretId = process.env['JWT_SECRET_ARN'] ?? 'spotterspace/JWT_SECRET';
  const [dbResult, jwtResult] = await Promise.all([
    client.send(new GetSecretValueCommand({ SecretId: dbSecretId })),
    client.send(new GetSecretValueCommand({ SecretId: jwtSecretId })),
  ]);

  process.env.DATABASE_URL = dbResult.SecretString ?? '';
  process.env.JWT_SECRET = jwtResult.SecretString ?? '';
  console.log('Secrets loaded from Secrets Manager');
}

async function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = initSecrets().catch((err) => {
      console.error('Failed to initialize secrets:', err);
      initPromise = null; // Allow retry on next invocation
      throw err;
    });
  }
  await initPromise;
}

function getServer(): ApolloServer<Context> {
  if (!server) {
    server = new ApolloServer<Context>({
      typeDefs,
      resolvers,
      introspection: process.env.NODE_ENV !== 'production',
    });
  }
  return server;
}

export const handler = async (event: {
  requestContext?: { http?: { method: string; path: string } };
  httpMethod?: string;
  path?: string;
  body?: string | null;
  headers?: Record<string, string | undefined>;
  isBase64Encoded?: boolean;
}) => {
  const path = event.requestContext?.http?.path ?? event.path ?? '/';
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? 'GET';

  // Health check endpoint (Lambda Function URL has no custom path routing)
  if (path === '/health' || (path === '/' && method === 'GET')) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ok' }),
    };
  }

  // Initialize secrets before handling (fetches DATABASE_URL from Secrets Manager on cold start)
  await ensureInitialized();

  // Fail hard if JWT_SECRET is missing or is the dev fallback in production
  validateJwtSecret();

  const apolloServer = getServer();

  const headers = event.headers ?? {};

  // Parse body
  let body: unknown = {};
  if (event.body !== undefined && event.body !== null) {
    try {
      body = event.isBase64Encoded
        ? JSON.parse(Buffer.from(event.body as string, 'base64').toString())
        : JSON.parse(event.body as string);
    } catch (err) {
      return {
        statusCode: 400,
        body: JSON.stringify({ errors: [{ message: `Invalid JSON: ${err}` }] }),
      };
    }
  }

  const query = (body as { query?: string }).query;
  const graphQLRequest: Omit<GraphQLRequest, 'query'> & { query?: string | undefined } = {
    query,
    variables: (body as { variables?: Record<string, unknown> }).variables ?? undefined,
    operationName: (body as { operationName?: string }).operationName,
  };

  try {
    // Create context directly (bypass StandaloneServerContextFunctionArgument type requirement)
    const authHeader = headers.authorization ?? headers.Authorization ?? '';
    const ctx: Context = {
      prisma: (await import('@spotterspace/db')).prisma,
      user: null, // Will be populated by createContext logic below
      loaders: null as unknown as import('./loaders.js').Loaders,
      res: {} as Context['res'],
      req: {} as Context['req'],
    };

    // Decode JWT if present
    if (authHeader.startsWith('Bearer ')) {
      const jwt = await import('jsonwebtoken');
      const JWT_SECRET = process.env.JWT_SECRET;
      if (!JWT_SECRET) {
        throw new Error('JWT_SECRET environment variable is not set');
      }
      try {
        const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET) as {
          sub: string;
          email: string;
          username: string;
        };
        ctx.user = { sub: decoded.sub, email: decoded.email, username: decoded.username };
      } catch {
        // Invalid token — treat as unauthenticated
      }
    }

    const { createLoaders } = await import('./loaders.js');
    ctx.loaders = createLoaders(ctx.prisma);

    const response = await apolloServer.executeOperation(graphQLRequest, {
      contextValue: ctx,
    });

    const statusCode = response.http?.status ?? 200;
    const responseHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (response.http?.headers) {
      for (const [key, value] of response.http.headers) {
        responseHeaders[key] = value;
      }
    }

    let bodyStr: string;
    if (response.body.kind === 'single') {
      bodyStr = JSON.stringify(response.body.singleResult);
    } else if (response.body.kind === 'incremental') {
      let s = JSON.stringify(response.body.initialResult);
      for await (const chunk of response.body.subsequentResults) {
        s += JSON.stringify(chunk);
      }
      bodyStr = s;
    } else {
      bodyStr = JSON.stringify({ data: null });
    }

    return { statusCode, headers: responseHeaders, body: bodyStr };
  } catch (err) {
    console.error('Lambda error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ errors: [{ message: 'Internal server error' }] }),
    };
  }
};
