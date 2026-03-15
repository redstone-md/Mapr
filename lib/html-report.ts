import { z } from "zod";

import type { BundleAnalysis } from "./analysis-schema";
import { artifactTypeSchema } from "./artifacts";
import type { DeterministicSurface } from "./surface-analysis";
import { domPageSnapshotSchema, type DomPageSnapshot } from "./dom-snapshot";
import type { FormattedArtifact } from "./formatter";

const htmlReportInputSchema = z.object({
  targetUrl: z.string().url(),
  reportStatus: z.enum(["complete", "partial"]),
  analysisError: z.string().optional(),
  htmlPages: z.array(z.string().url()),
  domSnapshots: z.array(domPageSnapshotSchema).default([]),
  artifacts: z.array(
    z.object({
      url: z.string().url(),
      type: artifactTypeSchema,
      sizeBytes: z.number().int().nonnegative(),
      discoveredFrom: z.string(),
      formattingSkipped: z.boolean(),
      formattingNote: z.string().optional(),
    }),
  ),
  analysis: z.custom<BundleAnalysis>(),
  deterministicSurface: z.custom<DeterministicSurface>(),
});

type HtmlReportInput = z.infer<typeof htmlReportInputSchema>;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatList(items: string[], emptyState: string): string {
  return items.length > 0 ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p class="empty">${escapeHtml(emptyState)}</p>`;
}

function buildGraphNodes(analysis: BundleAnalysis): Array<{ id: string; type: string; meta: string }> {
  const nodes = new Map<string, { id: string; type: string; meta: string }>();

  for (const entryPoint of analysis.entryPoints) {
    nodes.set(entryPoint.symbol, { id: entryPoint.symbol, type: "entry", meta: entryPoint.description });
  }
  for (const rename of analysis.restoredNames) {
    if (!nodes.has(rename.suggestedName)) {
      nodes.set(rename.suggestedName, { id: rename.suggestedName, type: "restored", meta: rename.justification });
    }
    if (!nodes.has(rename.originalName)) {
      nodes.set(rename.originalName, { id: rename.originalName, type: "opaque", meta: rename.justification });
    }
  }
  for (const edge of analysis.callGraph) {
    if (!nodes.has(edge.caller)) {
      nodes.set(edge.caller, { id: edge.caller, type: "function", meta: edge.rationale });
    }
    if (!nodes.has(edge.callee)) {
      nodes.set(edge.callee, { id: edge.callee, type: "function", meta: edge.rationale });
    }
  }

  return [...nodes.values()].slice(0, 240);
}

function buildManifest(
  artifacts: Array<{
    url: string;
    type: string;
    sizeBytes: number;
    discoveredFrom: string;
    formattingSkipped: boolean;
    formattingNote?: string | undefined;
  }>,
): Array<Record<string, unknown>> {
  return artifacts.map((artifact) => ({
    url: artifact.url,
    type: artifact.type,
    sizeBytes: artifact.sizeBytes,
    discoveredFrom: artifact.discoveredFrom,
    formatting: artifact.formattingSkipped ? "fallback" : "formatted",
    formattingNote: artifact.formattingNote ?? null,
  }));
}

function buildEmbeddedData(input: HtmlReportInput): string {
  return JSON.stringify({
    summary: {
      targetUrl: input.targetUrl,
      reportStatus: input.reportStatus,
      analysisError: input.analysisError ?? null,
      pages: input.htmlPages.length,
      artifacts: input.artifacts.length,
      chunks: input.analysis.analyzedChunkCount,
    },
    overview: input.analysis.overview,
    initializationFlow: input.analysis.initializationFlow,
    entryPoints: input.analysis.entryPoints,
    callGraph: input.analysis.callGraph,
    restoredNames: input.analysis.restoredNames,
    notableLibraries: input.analysis.notableLibraries,
    investigationTips: input.analysis.investigationTips,
    risks: input.analysis.risks,
    artifactSummaries: input.analysis.artifactSummaries,
    htmlPages: input.htmlPages,
    domSnapshots: input.domSnapshots,
    deterministicSurface: input.deterministicSurface,
    manifest: buildManifest(input.artifacts),
    graphNodes: buildGraphNodes(input.analysis),
  });
}

export class HtmlReportBuilder {
  public generate(input: {
    targetUrl: string;
    reportStatus: "complete" | "partial";
    analysisError?: string;
    htmlPages: string[];
    domSnapshots: DomPageSnapshot[];
    artifacts: FormattedArtifact[];
    analysis: BundleAnalysis;
    deterministicSurface: DeterministicSurface;
  }): string {
    const report = htmlReportInputSchema.parse(input);
    const embeddedData = buildEmbeddedData(report);

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mapr Run Report</title>
  <style>
    :root{--bg:#f5f5f4;--panel:#fff;--line:#d6d3d1;--text:#1c1917;--muted:#57534e;--accent:#b45309;--accent-soft:#fff7ed;--warn:#b91c1c;--ok:#166534}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 "Segoe UI Variable Text","Helvetica Neue",sans-serif}
    .shell{max-width:1440px;margin:0 auto;padding:20px 24px 40px}
    .topbar{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;padding:0 0 20px;border-bottom:1px solid var(--line)}
    .title{font-size:28px;font-weight:650;letter-spacing:-.02em}.subtitle,.muted{color:var(--muted)}
    .meta{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin:20px 0}
    .metric,.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px}
    .metric{padding:14px 16px}.metric strong{display:block;font-size:19px}.metric span{color:var(--muted)}
    .grid{display:grid;grid-template-columns:300px minmax(0,1fr);gap:18px}
    .sidebar{display:flex;flex-direction:column;gap:16px}.main{display:flex;flex-direction:column;gap:16px}
    .panel{padding:16px 18px}.panel h2{margin:0 0 12px;font-size:16px}.panel h3{margin:18px 0 8px;font-size:13px}
    .panel ul{margin:0;padding-left:18px}.empty{margin:0;color:var(--muted)}
    .search{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:#fff}
    .stack{display:flex;flex-direction:column;gap:10px}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    .pill{display:inline-flex;align-items:center;padding:3px 8px;border-radius:8px;border:1px solid var(--line);background:#fafaf9;color:var(--muted);font-size:12px}
    .list{display:flex;flex-direction:column;gap:10px}.item{padding:12px;border:1px solid var(--line);border-radius:8px;background:#fcfcfb}
    .item strong{display:block;margin-bottom:4px}
    .manifest{max-height:520px;overflow:auto}.manifest table{width:100%;border-collapse:collapse}.manifest th,.manifest td{text-align:left;padding:8px;border-bottom:1px solid #ece7e3;vertical-align:top}
    .code-map{display:grid;grid-template-columns:320px minmax(0,1fr);gap:14px}
    .node-list{max-height:480px;overflow:auto;border:1px solid var(--line);border-radius:8px}
    .node{padding:10px 12px;border-bottom:1px solid #ece7e3;cursor:pointer}.node:last-child{border-bottom:none}.node:hover,.node.active{background:var(--accent-soft)}
    .graph-detail{border:1px solid var(--line);border-radius:8px;padding:14px;min-height:320px;background:#fcfcfb}
    .badge-ok{color:var(--ok)}.badge-warn{color:var(--warn)}a{color:inherit}
    pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.45 Consolas,monospace}
    @media (max-width:1100px){.meta{grid-template-columns:repeat(3,minmax(0,1fr))}.grid,.code-map{grid-template-columns:1fr}}
    @media (max-width:720px){.shell{padding:14px}.meta{grid-template-columns:repeat(2,minmax(0,1fr))}}
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div>
        <div class="title">Mapr Run Report</div>
        <div class="subtitle">${escapeHtml(report.targetUrl)}</div>
      </div>
      <div class="muted">
        <div><a href="https://github.com/redstone-md/Mapr">github.com/redstone-md/Mapr</a></div>
        <div>Author and contributors assume no liability.</div>
      </div>
    </header>
    <section class="meta" id="meta"></section>
    <div class="grid">
      <aside class="sidebar">
        <section class="panel">
          <h2>Summary</h2>
          <div id="overview" class="muted"></div>
        </section>
        <section class="panel">
          <h2>Quick Findings</h2>
          <div id="quick-findings" class="stack"></div>
        </section>
        <section class="panel">
          <h2>Pages And DOM</h2>
          <div id="dom-surface" class="list"></div>
        </section>
      </aside>
      <main class="main">
        <section class="panel">
          <h2>Interactive Code Map</h2>
          <div class="row" style="margin-bottom:12px">
            <input id="graph-search" class="search" type="search" placeholder="Filter functions, symbols, entry points">
          </div>
          <div class="code-map">
            <div class="node-list" id="node-list"></div>
            <div class="graph-detail" id="graph-detail"><p class="empty">Select a node to inspect inbound and outbound relationships.</p></div>
          </div>
        </section>
        <section class="panel">
          <h2>API And Flow Surface</h2>
          <div id="surface-sections" class="stack"></div>
        </section>
        <section class="panel">
          <h2>Artifact Manifest</h2>
          <div class="manifest" id="manifest"></div>
        </section>
      </main>
    </div>
  </div>
  <script id="mapr-data" type="application/json">${escapeHtml(embeddedData)}</script>
  <script>
    const data = JSON.parse(document.getElementById("mapr-data").textContent);
    const byId = (id) => document.getElementById(id);
    const q = (value) => String(value ?? "");
    const renderList = (items, empty) => items.length ? "<ul>" + items.map((item) => "<li>" + q(item) + "</li>").join("") + "</ul>" : "<p class=\\"empty\\">" + empty + "</p>";

    byId("meta").innerHTML = [
      ["Status", data.summary.reportStatus === "complete" ? "<span class=\\"badge-ok\\">complete</span>" : "<span class=\\"badge-warn\\">partial</span>"],
      ["Pages", data.summary.pages],
      ["Artifacts", data.summary.artifacts],
      ["Chunks", data.summary.chunks],
      ["REST", data.deterministicSurface.apiEndpoints.length],
      ["GraphQL", data.deterministicSurface.graphQlEndpoints.length],
      ["Auth flows", data.deterministicSurface.authFlows.length],
      ["Captcha", data.deterministicSurface.captchaFlows.length],
      ["Fingerprinting", data.deterministicSurface.fingerprintingSignals.length],
      ["Encryption", data.deterministicSurface.encryptionSignals.length],
      ["Risks", data.risks.length],
      ["Libraries", data.notableLibraries.length]
    ].map(([label, value]) => "<div class=\\"metric\\"><strong>" + value + "</strong><span>" + label + "</span></div>").join("");

    byId("overview").innerHTML = "<p>" + q(data.overview) + "</p>" + (data.summary.analysisError ? "<p class=\\"badge-warn\\">Analysis error: " + q(data.summary.analysisError) + "</p>" : "");

    byId("quick-findings").innerHTML = [
      ["Entry points", data.entryPoints.map((entry) => entry.symbol + ": " + entry.description)],
      ["Initialization flow", data.initializationFlow],
      ["Investigation tips", data.investigationTips],
      ["Risks", data.risks]
    ].map(([title, items]) => "<div><strong>" + title + "</strong>" + renderList(items, "No entries") + "</div>").join("");

    byId("dom-surface").innerHTML = data.domSnapshots.length
      ? data.domSnapshots.map((snapshot) => "<div class=\\"item\\"><strong>" + q(snapshot.url) + "</strong><div class=\\"muted\\">" + q(snapshot.summary) + "</div></div>").join("")
      : "<p class=\\"empty\\">No DOM snapshots captured.</p>";

    const nodeList = byId("node-list");
    const graphDetail = byId("graph-detail");
    const graphSearch = byId("graph-search");
    const edges = data.callGraph || [];
    let activeNode = null;

    function renderNodeList(filter = "") {
      const needle = filter.trim().toLowerCase();
      const nodes = data.graphNodes.filter((node) => !needle || node.id.toLowerCase().includes(needle) || q(node.meta).toLowerCase().includes(needle));
      nodeList.innerHTML = nodes.length
        ? nodes.map((node) => "<div class=\\"node" + (activeNode === node.id ? " active" : "") + "\\" data-node=\\"" + q(node.id) + "\\"><strong>" + q(node.id) + "</strong><div class=\\"muted\\">" + q(node.type) + "</div></div>").join("")
        : "<div class=\\"node\\"><div class=\\"muted\\">No nodes match the current filter.</div></div>";
      [...nodeList.querySelectorAll("[data-node]")].forEach((element) => element.addEventListener("click", () => selectNode(element.getAttribute("data-node"))));
    }

    function selectNode(nodeId) {
      activeNode = nodeId;
      renderNodeList(graphSearch.value);
      const info = data.graphNodes.find((node) => node.id === nodeId);
      const inbound = edges.filter((edge) => edge.callee === nodeId);
      const outbound = edges.filter((edge) => edge.caller === nodeId);
      const rename = data.restoredNames.find((entry) => entry.originalName === nodeId || entry.suggestedName === nodeId);
      graphDetail.innerHTML = info ? [
        "<strong>" + q(info.id) + "</strong>",
        "<div class=\\"muted\\" style=\\"margin:6px 0 12px\\">" + q(info.type) + (info.meta ? " · " + q(info.meta) : "") + "</div>",
        rename ? "<div class=\\"item\\"><strong>Rename context</strong><div>" + q(rename.originalName) + " → " + q(rename.suggestedName) + "</div><div class=\\"muted\\">" + q(rename.justification) + "</div></div>" : "",
        "<h3>Outbound</h3>",
        renderList(outbound.map((edge) => edge.callee + ": " + edge.rationale), "No outbound edges"),
        "<h3>Inbound</h3>",
        renderList(inbound.map((edge) => edge.caller + ": " + edge.rationale), "No inbound edges")
      ].join("") : "<p class=\\"empty\\">Node not found.</p>";
    }

    graphSearch.addEventListener("input", () => renderNodeList(graphSearch.value));
    renderNodeList();
    if (data.graphNodes.length) selectNode(data.graphNodes[0].id);

    const sections = [
      ["REST endpoints", data.deterministicSurface.apiEndpoints.map((entry) => "<div class=\\"item\\"><strong>" + q(entry.url) + "</strong><div>" + q(entry.purpose) + "</div><div class=\\"muted\\">Methods: " + q(entry.methods.join(", ") || "unknown") + " · Request fields: " + q(entry.requestFields.join(", ") || "none") + "</div></div>")],
      ["OpenAPI / Swagger", data.deterministicSurface.openApiDocuments.map((entry) => "<div class=\\"item\\"><strong>" + q(entry.url) + "</strong><div class=\\"muted\\">" + q(entry.pathSummaries.join("; ") || "No parsed path summaries") + "</div></div>")],
      ["GraphQL", data.deterministicSurface.graphQlEndpoints.map((entry) => "<div class=\\"item\\"><strong>" + q(entry.url) + "</strong><div class=\\"muted\\">Introspection: " + q(entry.introspectionStatus) + " · " + q(entry.sampleFields.join(", ") || "No schema hints") + "</div></div>").concat(data.deterministicSurface.graphQlOperations.map((entry) => "<div class=\\"item\\"><strong>" + q(entry.operationType) + " " + q(entry.operationName) + "</strong><div>" + q(entry.sampleRequest) + "</div><div class=\\"muted\\">Expected response: " + q(entry.expectedResponse) + "</div></div>"))],
      ["Auth flow", data.deterministicSurface.authFlows.map((flow) => "<div class=\\"item\\"><strong>" + q(flow.title) + "</strong><div>Triggers: " + q(flow.triggers.join(", ") || "none") + "</div><div class=\\"muted\\">Tokens: " + q(flow.tokens.join(", ") || "none") + " · Errors: " + q(flow.errors.join(", ") || "none") + "</div></div>")],
      ["Captcha flow", data.deterministicSurface.captchaFlows.map((flow) => "<div class=\\"item\\"><strong>" + q(flow.provider) + "</strong><div>Triggers: " + q(flow.triggers.join(", ") || "none") + "</div><div class=\\"muted\\">Endpoints: " + q(flow.endpoints.join(", ") || "none") + " · Errors: " + q(flow.errors.join(", ") || "none") + "</div></div>")],
      ["Fingerprinting", data.deterministicSurface.fingerprintingSignals.map((signal) => "<div class=\\"item\\"><strong>" + q(signal.collector) + "</strong><div>" + q(signal.purpose) + "</div><div class=\\"muted\\">Data: " + q(signal.dataPoints.join(", ") || "none") + " · Destinations: " + q(signal.destinationUrls.join(", ") || "none") + "</div></div>")],
      ["Encryption / signing", data.deterministicSurface.encryptionSignals.map((signal) => "<div class=\\"item\\"><strong>" + q(signal.algorithmHints.join(", ") || "Unknown algorithms") + "</strong><div class=\\"muted\\">Inputs: " + q(signal.inputs.join(", ") || "none") + " · Outputs: " + q(signal.outputs.join(", ") || "none") + " · Destinations: " + q(signal.destinationUrls.join(", ") || "none") + "</div></div>")],
      ["Security findings", data.deterministicSurface.securityFindings.map((finding) => "<div class=\\"item\\"><strong>[" + q(finding.severity) + "] " + q(finding.title) + "</strong><div>" + q(finding.detail) + "</div><div class=\\"muted\\">Remediation: " + q(finding.remediation) + "</div></div>")]
    ];

    byId("surface-sections").innerHTML = sections.map(([title, items]) => "<div><h3>" + q(title) + "</h3>" + (items.length ? items.join("") : "<p class=\\"empty\\">No entries.</p>") + "</div>").join("");

    byId("manifest").innerHTML = "<table><thead><tr><th>Artifact</th><th>Type</th><th>Bytes</th><th>Discovery</th><th>Formatting</th></tr></thead><tbody>" + data.manifest.map((entry) => "<tr><td>" + q(entry.url) + "</td><td>" + q(entry.type) + "</td><td>" + q(entry.sizeBytes) + "</td><td>" + q(entry.discoveredFrom) + "</td><td>" + q(entry.formatting) + "</td></tr>").join("") + "</tbody></table>";
  </script>
</body>
</html>`;
  }
}
