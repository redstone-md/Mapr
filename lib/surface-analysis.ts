import { z } from "zod";

export const apiEndpointSchema = z.object({
  url: z.string().min(1),
  methods: z.array(z.string().min(1)).default([]),
  sourceArtifactUrl: z.string().url(),
  purpose: z.string().min(1),
  requestFields: z.array(z.string().min(1)).default([]),
  responseFields: z.array(z.string().min(1)).default([]),
  evidence: z.array(z.string().min(1)).default([]),
});

export const openApiDocumentSchema = z.object({
  url: z.string().url(),
  source: z.enum(["crawler", "artifact-string", "well-known"]),
  title: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  pathSummaries: z.array(z.string().min(1)).default([]),
  schemaNames: z.array(z.string().min(1)).default([]),
  evidence: z.array(z.string().min(1)).default([]),
});

export const graphQlEndpointSchema = z.object({
  url: z.string().min(1),
  sourceArtifactUrl: z.string().url().optional(),
  introspectionStatus: z.enum(["supported", "blocked", "not-attempted", "failed"]).default("not-attempted"),
  operationTypes: z.array(z.string().min(1)).default([]),
  sampleFields: z.array(z.string().min(1)).default([]),
  evidence: z.array(z.string().min(1)).default([]),
});

export const graphQlOperationSchema = z.object({
  endpointUrl: z.string().min(1),
  operationType: z.enum(["query", "mutation", "subscription", "unknown"]),
  operationName: z.string().min(1),
  variables: z.array(z.string().min(1)).default([]),
  sampleRequest: z.string().min(1),
  expectedResponse: z.string().min(1),
  sourceArtifactUrl: z.string().url(),
  evidence: z.array(z.string().min(1)).default([]),
});

export const flowStepSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  endpoints: z.array(z.string().min(1)).default([]),
  evidence: z.array(z.string().min(1)).default([]),
});

export const authFlowSchema = z.object({
  title: z.string().min(1),
  triggers: z.array(z.string().min(1)).default([]),
  steps: z.array(flowStepSchema).default([]),
  tokens: z.array(z.string().min(1)).default([]),
  errors: z.array(z.string().min(1)).default([]),
  evidence: z.array(z.string().min(1)).default([]),
});

export const captchaFlowSchema = z.object({
  provider: z.string().min(1),
  triggers: z.array(z.string().min(1)).default([]),
  endpoints: z.array(z.string().min(1)).default([]),
  requestFields: z.array(z.string().min(1)).default([]),
  errors: z.array(z.string().min(1)).default([]),
  evidence: z.array(z.string().min(1)).default([]),
});

export const fingerprintingSignalSchema = z.object({
  collector: z.string().min(1),
  dataPoints: z.array(z.string().min(1)).default([]),
  destinationUrls: z.array(z.string().min(1)).default([]),
  purpose: z.string().min(1),
  evidence: z.array(z.string().min(1)).default([]),
});

export const encryptionSignalSchema = z.object({
  algorithmHints: z.array(z.string().min(1)).default([]),
  inputs: z.array(z.string().min(1)).default([]),
  outputs: z.array(z.string().min(1)).default([]),
  destinationUrls: z.array(z.string().min(1)).default([]),
  evidence: z.array(z.string().min(1)).default([]),
});

export const securityFindingSchema = z.object({
  severity: z.enum(["low", "medium", "high"]),
  title: z.string().min(1),
  detail: z.string().min(1),
  remediation: z.string().min(1),
  evidence: z.array(z.string().min(1)).default([]),
});

export const deterministicSurfaceSchema = z.object({
  apiEndpoints: z.array(apiEndpointSchema).default([]),
  openApiDocuments: z.array(openApiDocumentSchema).default([]),
  graphQlEndpoints: z.array(graphQlEndpointSchema).default([]),
  graphQlOperations: z.array(graphQlOperationSchema).default([]),
  authFlows: z.array(authFlowSchema).default([]),
  captchaFlows: z.array(captchaFlowSchema).default([]),
  fingerprintingSignals: z.array(fingerprintingSignalSchema).default([]),
  encryptionSignals: z.array(encryptionSignalSchema).default([]),
  securityFindings: z.array(securityFindingSchema).default([]),
});

export type DeterministicSurface = z.infer<typeof deterministicSurfaceSchema>;
export type ApiEndpoint = z.infer<typeof apiEndpointSchema>;
export type OpenApiDocument = z.infer<typeof openApiDocumentSchema>;
export type GraphQlEndpoint = z.infer<typeof graphQlEndpointSchema>;
export type GraphQlOperation = z.infer<typeof graphQlOperationSchema>;
export type AuthFlow = z.infer<typeof authFlowSchema>;
export type CaptchaFlow = z.infer<typeof captchaFlowSchema>;
export type FingerprintingSignal = z.infer<typeof fingerprintingSignalSchema>;
export type EncryptionSignal = z.infer<typeof encryptionSignalSchema>;
export type SecurityFinding = z.infer<typeof securityFindingSchema>;

export const EMPTY_DETERMINISTIC_SURFACE: DeterministicSurface = {
  apiEndpoints: [],
  openApiDocuments: [],
  graphQlEndpoints: [],
  graphQlOperations: [],
  authFlows: [],
  captchaFlows: [],
  fingerprintingSignals: [],
  encryptionSignals: [],
  securityFindings: [],
};

export function deduplicateStrings(items: string[], limit = 24): string[] {
  return [...new Set(items.filter((item) => item.trim().length > 0))].slice(0, limit);
}

export function mergeDeterministicSurface(input: Partial<DeterministicSurface>): DeterministicSurface {
  return deterministicSurfaceSchema.parse({ ...EMPTY_DETERMINISTIC_SURFACE, ...input });
}
