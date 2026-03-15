import { z } from "zod";

import type { FormattedArtifact } from "./formatter";
import {
  apiEndpointSchema,
  graphQlEndpointSchema,
  graphQlOperationSchema,
  openApiDocumentSchema,
  type ApiEndpoint,
  type GraphQlEndpoint,
  type GraphQlOperation,
  type OpenApiDocument,
} from "./surface-analysis";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const openApiResponseSchema = z.object({
  openapi: z.string().optional(),
  swagger: z.string().optional(),
  info: z.object({ title: z.string().optional(), version: z.string().optional() }).optional(),
  paths: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  components: z.object({ schemas: z.record(z.string(), z.unknown()).default({}) }).optional(),
});

const restEndpointPattern = /(?:fetch|axios\.(?:get|post|put|patch|delete)|url\s*:\s*|baseURL\s*:\s*)[^"'`\n]{0,80}["'`](\/(?:api|rest|graphql|v\d+)[^"'`\s)]+)["'`]/gi;
const genericApiStringPattern = /["'`](\/(?:api|rest|graphql|v\d+)[^"'`\s)]+)["'`]/gi;
const graphQlEndpointPattern = /["'`](https?:\/\/[^"'`\s]*\/graphql[^"'`\s]*|\/graphql[^"'`\s]*)["'`]/gi;
const graphQlOperationPattern =
  /(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^)]*)\))?\s*\{/g;
const methodHints = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const openApiCandidatePaths = [
  "/swagger.json",
  "/openapi.json",
  "/openapi.yaml",
  "/openapi.yml",
  "/v3/api-docs",
  "/api-docs",
];

function clonePattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags);
}

interface ApiDiscoveryOptions {
  fetcher?: FetchLike;
  onProgress?: (message: string) => void;
}

function clipSnippet(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 220);
}

function uniqueBy<T>(items: T[], keySelector: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    const key = keySelector(item);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

function toAbsoluteMaybe(reference: string, baseUrl: string): string {
  try {
    return new URL(reference, baseUrl).toString();
  } catch {
    return reference;
  }
}

function extractNearbyObjectKeys(content: string, index: number): string[] {
  const window = content.slice(Math.max(0, index - 240), Math.min(content.length, index + 360));
  return [...window.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]{1,40})\s*:/g)].map((match) => match[1] ?? "").filter(Boolean).slice(0, 8);
}

function extractMethodHints(content: string, index: number): string[] {
  const window = content.slice(Math.max(0, index - 180), Math.min(content.length, index + 180)).toUpperCase();
  return methodHints.filter((method) => window.includes(method));
}

function summarizeOpenApiPath(method: string, pathName: string, operation: Record<string, unknown>): string {
  const summary = typeof operation.summary === "string" ? operation.summary : typeof operation.operationId === "string" ? operation.operationId : "No summary";
  return `${method.toUpperCase()} ${pathName} - ${summary}`;
}

async function fetchOpenApiDocument(
  fetcher: FetchLike,
  url: string,
  onProgress?: (message: string) => void,
): Promise<OpenApiDocument | null> {
  try {
    onProgress?.(`Probing OpenAPI document ${url}`);
    const response = await fetcher(url, { headers: { accept: "application/json, application/yaml, text/yaml, */*" } });
    if (!response.ok) {
      return null;
    }

    const body = await response.text();
    const parsed = openApiResponseSchema.safeParse(JSON.parse(body) as unknown);
    if (!parsed.success) {
      return null;
    }

    const pathEntries = Object.entries(parsed.data.paths).slice(0, 20);
    return openApiDocumentSchema.parse({
      url,
      source: "well-known",
      title: parsed.data.info?.title,
      version: parsed.data.info?.version ?? parsed.data.openapi ?? parsed.data.swagger,
      pathSummaries: pathEntries.flatMap(([pathName, methods]) =>
        Object.entries(methods)
          .filter(([method]) => methodHints.includes(method.toUpperCase()))
          .map(([method, operation]) => summarizeOpenApiPath(method, pathName, operation as Record<string, unknown>)),
      ),
      schemaNames: Object.keys(parsed.data.components?.schemas ?? {}).slice(0, 24),
      evidence: [`Fetched OpenAPI-style document from ${url}`],
    });
  } catch {
    return null;
  }
}

async function introspectGraphQlEndpoint(
  fetcher: FetchLike,
  url: string,
  onProgress?: (message: string) => void,
): Promise<Pick<GraphQlEndpoint, "introspectionStatus" | "operationTypes" | "sampleFields">> {
  const introspectionQuery = {
    query: "query IntrospectionQuery { __schema { queryType { name } mutationType { name } subscriptionType { name } types { name kind } } }",
  };

  try {
    onProgress?.(`Probing GraphQL introspection ${url}`);
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(introspectionQuery),
    });

    if (!response.ok) {
      return {
        introspectionStatus: response.status === 400 || response.status === 401 || response.status === 403 ? "blocked" : "failed",
        operationTypes: [],
        sampleFields: [],
      };
    }

    const payload = (await response.json()) as {
      data?: {
        __schema?: {
          queryType?: { name?: string | null };
          mutationType?: { name?: string | null };
          subscriptionType?: { name?: string | null };
          types?: Array<{ name?: string | null; kind?: string | null }>;
        };
      };
    };
    const schema = payload.data?.__schema;
    if (!schema) {
      return { introspectionStatus: "failed", operationTypes: [], sampleFields: [] };
    }

    return {
      introspectionStatus: "supported",
      operationTypes: [schema.queryType?.name, schema.mutationType?.name, schema.subscriptionType?.name].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      ),
      sampleFields: (schema.types ?? [])
        .map((entry) => `${entry.kind ?? "unknown"}:${entry.name ?? "unnamed"}`)
        .filter((value) => !value.endsWith(":unnamed"))
        .slice(0, 12),
    };
  } catch {
    return { introspectionStatus: "failed", operationTypes: [], sampleFields: [] };
  }
}

export class ApiSurfaceDiscoverer {
  private readonly fetcher: FetchLike;
  private readonly onProgress: ((message: string) => void) | undefined;

  public constructor(options: ApiDiscoveryOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.onProgress = options.onProgress;
  }

  public async discover(pageUrl: string, artifacts: FormattedArtifact[]): Promise<{
    apiEndpoints: ApiEndpoint[];
    openApiDocuments: OpenApiDocument[];
    graphQlEndpoints: GraphQlEndpoint[];
    graphQlOperations: GraphQlOperation[];
  }> {
    const restEndpoints: ApiEndpoint[] = [];
    const graphQlEndpoints: GraphQlEndpoint[] = [];
    const graphQlOperations: GraphQlOperation[] = [];
    const openApiDocs: OpenApiDocument[] = [];
    const rootOrigin = new URL(pageUrl).origin;

    for (const artifact of artifacts) {
      const content = artifact.formattedContent || artifact.content;

      for (const matcher of [restEndpointPattern, genericApiStringPattern].map(clonePattern)) {
        let match: RegExpExecArray | null;
        while ((match = matcher.exec(content)) !== null) {
          const rawUrl = match[1] ?? "";
          const endpointUrl = toAbsoluteMaybe(rawUrl, artifact.url);
          restEndpoints.push(
            apiEndpointSchema.parse({
              url: endpointUrl,
              methods: extractMethodHints(content, match.index),
              sourceArtifactUrl: artifact.url,
              purpose: endpointUrl.toLowerCase().includes("auth") || endpointUrl.toLowerCase().includes("login")
                ? "Likely auth/session endpoint"
                : endpointUrl.toLowerCase().includes("captcha")
                  ? "Likely captcha or risk verification endpoint"
                  : "Discovered API endpoint literal",
              requestFields: extractNearbyObjectKeys(content, match.index),
              responseFields: [],
              evidence: [clipSnippet(content.slice(Math.max(0, match.index - 80), match.index + 180))],
            }),
          );
        }
      }

      const graphEndpointMatcher = clonePattern(graphQlEndpointPattern);
      let graphMatch: RegExpExecArray | null;
      while ((graphMatch = graphEndpointMatcher.exec(content)) !== null) {
        const endpointUrl = toAbsoluteMaybe(graphMatch[1] ?? "", artifact.url);
        graphQlEndpoints.push(
          graphQlEndpointSchema.parse({
            url: endpointUrl,
            sourceArtifactUrl: artifact.url,
            evidence: [clipSnippet(content.slice(Math.max(0, graphMatch.index - 80), graphMatch.index + 180))],
          }),
        );
      }

      const graphOperationMatcher = clonePattern(graphQlOperationPattern);
      let operationMatch: RegExpExecArray | null;
      while ((operationMatch = graphOperationMatcher.exec(content)) !== null) {
        const operationType = operationMatch[0].trim().split(/\s+/, 1)[0] ?? "unknown";
        const variables = [...(operationMatch[2] ?? "").matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1] ?? "");
        const endpointUrl = graphQlEndpoints.at(-1)?.url ?? `${rootOrigin}/graphql`;
        graphQlOperations.push(
          graphQlOperationSchema.parse({
            endpointUrl,
            operationType: operationType === "query" || operationType === "mutation" || operationType === "subscription" ? operationType : "unknown",
            operationName: operationMatch[1] ?? "AnonymousOperation",
            variables,
            sampleRequest: clipSnippet(operationMatch[0]),
            expectedResponse:
              operationType === "mutation"
                ? "Mutation response object likely contains status/result payload fields."
                : "Query response object likely returns typed selection-set fields.",
            sourceArtifactUrl: artifact.url,
            evidence: [clipSnippet(content.slice(Math.max(0, operationMatch.index - 80), operationMatch.index + 220))],
          }),
        );
      }

      const openApiMatcher = /["'`](\/(?:swagger|openapi|v3\/api-docs)[^"'`]*)["'`]/gi;
      let docMatch: RegExpExecArray | null;
      while ((docMatch = openApiMatcher.exec(content)) !== null) {
        const docUrl = toAbsoluteMaybe(docMatch[1] ?? "", artifact.url);
        openApiDocs.push(
          openApiDocumentSchema.parse({
            url: docUrl,
            source: "artifact-string",
            evidence: [clipSnippet(content.slice(Math.max(0, docMatch.index - 80), docMatch.index + 160))],
          }),
        );
      }
    }

    for (const candidatePath of openApiCandidatePaths) {
      const fetched = await fetchOpenApiDocument(this.fetcher, new URL(candidatePath, rootOrigin).toString(), this.onProgress);
      if (fetched) {
        openApiDocs.push(fetched);
      }
    }

    const uniqueGraphQlEndpoints = uniqueBy(graphQlEndpoints, (entry) => entry.url);
    const graphQlEndpointResults = await Promise.all(
      uniqueGraphQlEndpoints.map(async (endpoint) =>
        graphQlEndpointSchema.parse({
          ...endpoint,
          ...(endpoint.url.startsWith(rootOrigin)
            ? await introspectGraphQlEndpoint(this.fetcher, endpoint.url, this.onProgress)
            : { introspectionStatus: "not-attempted", operationTypes: [], sampleFields: [] }),
        }),
      ),
    );

    return {
      apiEndpoints: uniqueBy(restEndpoints, (entry) => `${entry.url}:${entry.methods.join(",") || "*"}`).slice(0, 80),
      openApiDocuments: uniqueBy(openApiDocs, (entry) => entry.url).slice(0, 12),
      graphQlEndpoints: graphQlEndpointResults.slice(0, 20),
      graphQlOperations: uniqueBy(
        graphQlOperations,
        (entry) => `${entry.endpointUrl}:${entry.operationType}:${entry.operationName}:${entry.sourceArtifactUrl}`,
      ).slice(0, 40),
    };
  }
}
