import { describe, expect, test } from "bun:test";

import { ApiSurfaceDiscoverer } from "../lib/api-discovery";

describe("ApiSurfaceDiscoverer", () => {
  test("extracts REST, GraphQL, and OpenAPI clues from formatted artifacts", async () => {
    const discoverer = new ApiSurfaceDiscoverer({
      fetcher: async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://example.com/openapi.json") {
          return new Response(
            JSON.stringify({
              openapi: "3.1.0",
              info: { title: "Example API", version: "1.0.0" },
              paths: {
                "/api/login": {
                  post: { summary: "Create session" },
                },
              },
              components: {
                schemas: {
                  LoginRequest: {},
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        if (url === "https://example.com/graphql") {
          return new Response(
            JSON.stringify({
              data: {
                __schema: {
                  queryType: { name: "Query" },
                  mutationType: { name: "Mutation" },
                  subscriptionType: null,
                  types: [{ name: "User", kind: "OBJECT" }],
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        return new Response("not found", { status: 404 });
      },
    });

    const result = await discoverer.discover("https://example.com/login.html", [
      {
        url: "https://example.com/assets/app.js",
        type: "script",
        content: "",
        formattedContent: `
          fetch("/api/login", { method: "POST", body: JSON.stringify({ email: value, password: secret }) });
          const schemaUrl = "/openapi.json";
          const gql = "query Viewer($id: ID!) { viewer(id: $id) { id email } }";
          const endpoint = "/graphql";
        `,
        sizeBytes: 200,
        discoveredFrom: "root",
        formattingSkipped: false,
      },
    ]);

    expect(result.apiEndpoints.some((entry) => entry.url === "https://example.com/api/login")).toBe(true);
    expect(result.openApiDocuments.some((entry) => entry.url === "https://example.com/openapi.json")).toBe(true);
    expect(result.graphQlEndpoints.find((entry) => entry.url === "https://example.com/graphql")?.introspectionStatus).toBe("supported");
    expect(result.graphQlOperations.some((entry) => entry.operationName === "Viewer")).toBe(true);
  });
});
