import { z } from "zod";

import type { BundleAnalysis } from "./analysis-schema";
import { artifactTypeSchema } from "./artifacts";
import { domPageSnapshotSchema, type DomPageSnapshot } from "./dom-snapshot";
import type { FormattedArtifact } from "./formatter";
import type { DeterministicSurface } from "./surface-analysis";

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
      content: z.string(),
      formattedContent: z.string(),
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

interface HtmlGraphNode {
  id: string;
  type: string;
  meta: string;
  x: number;
  y: number;
  artifactUrls: string[];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function clip(value: string, maxLength = 1400): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}\n…` : normalized;
}

function tokenize(value: string): string[] {
  return [...value.toLowerCase().matchAll(/[a-zA-Z_$][a-zA-Z0-9_$-]{2,}/g)].map((match) => match[0] ?? "");
}

function artifactRelationMap(input: HtmlReportInput): Map<string, Set<string>> {
  const relatedNodesByArtifact = new Map<string, Set<string>>();
  const nodeIds = [
    ...input.analysis.entryPoints.map((entry) => entry.symbol),
    ...input.analysis.restoredNames.flatMap((entry) => [entry.originalName, entry.suggestedName]),
    ...input.analysis.callGraph.flatMap((entry) => [entry.caller, entry.callee]),
  ];

  for (const artifact of input.artifacts) {
    const summaryText = input.analysis.artifactSummaries.find((summary) => summary.url === artifact.url)?.summary ?? "";
    const tokens = new Set([...tokenize(summaryText), ...tokenize(artifact.url)]);
    const matchedNodes = nodeIds.filter((nodeId) => tokens.has(nodeId.toLowerCase()) || summaryText.includes(nodeId));
    relatedNodesByArtifact.set(artifact.url, new Set(matchedNodes.slice(0, 10)));
  }

  return relatedNodesByArtifact;
}

function buildGraphNodes(input: HtmlReportInput, relatedNodesByArtifact: Map<string, Set<string>>): HtmlGraphNode[] {
  const rawNodes = new Map<string, { id: string; type: string; meta: string }>();
  const artifactUrls = input.artifacts.map((artifact) => artifact.url);

  for (const entryPoint of input.analysis.entryPoints) {
    rawNodes.set(entryPoint.symbol, { id: entryPoint.symbol, type: "entry", meta: entryPoint.description });
  }
  for (const rename of input.analysis.restoredNames) {
    rawNodes.set(rename.suggestedName, rawNodes.get(rename.suggestedName) ?? { id: rename.suggestedName, type: "restored", meta: rename.justification });
    rawNodes.set(rename.originalName, rawNodes.get(rename.originalName) ?? { id: rename.originalName, type: "opaque", meta: rename.justification });
  }
  for (const edge of input.analysis.callGraph) {
    rawNodes.set(edge.caller, rawNodes.get(edge.caller) ?? { id: edge.caller, type: "function", meta: edge.rationale });
    rawNodes.set(edge.callee, rawNodes.get(edge.callee) ?? { id: edge.callee, type: "function", meta: edge.rationale });
  }

  const groups = ["entry", "restored", "function", "opaque"];
  const columns = new Map<string, number>(groups.map((group, index) => [group, index]));
  const columnBuckets = new Map<string, Array<{ id: string; type: string; meta: string }>>();

  for (const node of [...rawNodes.values()].slice(0, 220)) {
    const bucketKey = columns.has(node.type) ? node.type : "function";
    const bucket = columnBuckets.get(bucketKey) ?? [];
    bucket.push(node);
    columnBuckets.set(bucketKey, bucket);
  }

  const result: HtmlGraphNode[] = [];
  for (const [bucketKey, nodes] of columnBuckets.entries()) {
    nodes.forEach((node, index) => {
      const relatedArtifacts = artifactUrls.filter((artifactUrl) => relatedNodesByArtifact.get(artifactUrl)?.has(node.id));
      result.push({
        ...node,
        x: 120 + (columns.get(bucketKey) ?? 2) * 210,
        y: 44 + index * 48,
        artifactUrls: relatedArtifacts.slice(0, 8),
      });
    });
  }

  return result;
}

function buildManifest(input: HtmlReportInput, relatedNodesByArtifact: Map<string, Set<string>>) {
  return input.artifacts.map((artifact, index) => ({
    id: `artifact-${index + 1}`,
    url: artifact.url,
    type: artifact.type,
    sizeBytes: artifact.sizeBytes,
    discoveredFrom: artifact.discoveredFrom,
    formatting: artifact.formattingSkipped ? "fallback" : "formatted",
    formattingNote: artifact.formattingNote ?? null,
    rawPreview: clip(artifact.content),
    formattedPreview: clip(artifact.formattedContent),
    relatedNodeIds: [...(relatedNodesByArtifact.get(artifact.url) ?? new Set<string>())],
    summary: input.analysis.artifactSummaries.find((summary) => summary.url === artifact.url)?.summary ?? "",
  }));
}

function buildFlowRelations(input: HtmlReportInput) {
  const artifactIdByUrl = new Map<string, string>();
  buildManifest(input, artifactRelationMap(input)).forEach((artifact) => artifactIdByUrl.set(artifact.url, artifact.id));
  const apiByEndpoint = new Map(input.deterministicSurface.apiEndpoints.map((endpoint) => [endpoint.url, endpoint.sourceArtifactUrl]));

  return {
    authFlows: input.deterministicSurface.authFlows.map((flow, index) => ({
      id: `auth-flow-${index + 1}`,
      ...flow,
      relatedArtifactUrls: flow.steps.flatMap((step) => step.endpoints.map((endpoint) => apiByEndpoint.get(endpoint))).filter(Boolean),
    })),
    captchaFlows: input.deterministicSurface.captchaFlows.map((flow, index) => ({
      id: `captcha-flow-${index + 1}`,
      ...flow,
      relatedArtifactUrls: flow.endpoints.map((endpoint) => apiByEndpoint.get(endpoint)).filter(Boolean),
    })),
  };
}

function buildEmbeddedData(input: HtmlReportInput): string {
  const relatedNodesByArtifact = artifactRelationMap(input);
  const graphNodes = buildGraphNodes(input, relatedNodesByArtifact);
  const manifest = buildManifest(input, relatedNodesByArtifact);
  const flowRelations = buildFlowRelations(input);

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
    deterministicSurface: {
      ...input.deterministicSurface,
      ...flowRelations,
    },
    manifest,
    graphNodes,
  });
}

const REPORT_STYLE = `
  :root{--bg:#f5f5f4;--panel:#fff;--line:#d6d3d1;--text:#1c1917;--muted:#57534e;--accent:#b45309;--accent-soft:#fff7ed;--warn:#b91c1c;--ok:#166534}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 "Segoe UI Variable Text","Helvetica Neue",sans-serif}
  .shell{max-width:1480px;margin:0 auto;padding:20px 24px 40px}.topbar{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;padding:0 0 20px;border-bottom:1px solid var(--line)}
  .title{font-size:28px;font-weight:650;letter-spacing:-.02em}.subtitle,.muted{color:var(--muted)}.meta{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin:20px 0}
  .metric,.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px}.metric{padding:14px 16px}.metric strong{display:block;font-size:19px}.metric span{color:var(--muted)}
  .grid{display:grid;grid-template-columns:310px minmax(0,1fr);gap:18px}.sidebar,.main{display:flex;flex-direction:column;gap:16px}
  .panel{padding:16px 18px}.panel h2{margin:0 0 12px;font-size:16px}.panel h3{margin:18px 0 8px;font-size:13px}.panel ul{margin:0;padding-left:18px}.empty{margin:0;color:var(--muted)}
  .search{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:#fff}.stack{display:flex;flex-direction:column;gap:10px}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .pill,.link-btn{display:inline-flex;align-items:center;padding:4px 8px;border-radius:8px;border:1px solid var(--line);background:#fafaf9;color:var(--muted);font-size:12px;text-decoration:none;cursor:pointer}
  .list{display:flex;flex-direction:column;gap:10px}.item{padding:12px;border:1px solid var(--line);border-radius:8px;background:#fcfcfb}.item strong{display:block;margin-bottom:4px}
  .graph-shell{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:14px}.graph-stage{border:1px solid var(--line);border-radius:8px;background:#fcfcfb;padding:8px}
  .graph-detail,.artifact-preview{border:1px solid var(--line);border-radius:8px;padding:14px;min-height:280px;background:#fcfcfb}.node-list{max-height:200px;overflow:auto;border:1px solid var(--line);border-radius:8px}
  .node{padding:10px 12px;border-bottom:1px solid #ece7e3;cursor:pointer}.node:last-child{border-bottom:none}.node:hover,.node.active{background:var(--accent-soft)}
  .manifest{max-height:420px;overflow:auto}.manifest table{width:100%;border-collapse:collapse}.manifest th,.manifest td{text-align:left;padding:8px;border-bottom:1px solid #ece7e3;vertical-align:top}
  .badge-ok{color:var(--ok)}.badge-warn{color:var(--warn)}.artifact-layout{display:grid;grid-template-columns:minmax(0,1fr) 420px;gap:14px}.preview-tabs{display:flex;gap:8px;margin-bottom:10px}
  .preview-tab{padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:#fff;cursor:pointer}.preview-tab.active{background:var(--accent-soft);border-color:#e7c7aa;color:#8a4200}
  pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.45 Consolas,monospace}svg text{font:11px "Segoe UI Variable Text","Helvetica Neue",sans-serif;fill:#44403c}
  .svg-node{cursor:pointer}.svg-node rect{fill:#fff;stroke:#d6d3d1}.svg-node.active rect,.svg-node:hover rect{fill:#fff7ed;stroke:#d97706}.svg-edge{stroke:#d6d3d1;stroke-width:1.4;fill:none}
  a{color:inherit}@media (max-width:1180px){.meta{grid-template-columns:repeat(3,minmax(0,1fr))}.grid,.graph-shell,.artifact-layout{grid-template-columns:1fr}}@media (max-width:720px){.shell{padding:14px}.meta{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;

const REPORT_SCRIPT = `
  const data = JSON.parse(document.getElementById("mapr-data").textContent);
  const byId = (id) => document.getElementById(id);
  const q = (value) => String(value ?? "");
  const renderList = (items, empty) => items.length ? "<ul>" + items.map((item) => "<li>" + q(item) + "</li>").join("") + "</ul>" : "<p class=\\"empty\\">" + empty + "</p>";
  const edges = data.callGraph || [];
  let activeNode = null;
  let activeArtifactId = data.manifest[0]?.id ?? null;
  let previewMode = "formatted";

  function escapeHtmlRuntime(value){return q(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");}
  function findNode(nodeId){return data.graphNodes.find((node) => node.id === nodeId);}
  function selectNode(nodeId){
    activeNode=nodeId;renderNodeList(byId("graph-search").value);renderGraph();
    const info=findNode(nodeId);const inbound=edges.filter((edge)=>edge.callee===nodeId);const outbound=edges.filter((edge)=>edge.caller===nodeId);
    const rename=data.restoredNames.find((entry)=>entry.originalName===nodeId||entry.suggestedName===nodeId);
    const relatedArtifacts=(info?.artifactUrls??[]).map((artifactUrl)=>data.manifest.find((artifact)=>artifact.url===artifactUrl)).filter(Boolean);
    byId("graph-detail").innerHTML=info?[
      "<strong>"+q(info.id)+"</strong>",
      "<div class=\\"muted\\" style=\\"margin:6px 0 12px\\">"+q(info.type)+(info.meta?" · "+q(info.meta):"")+"</div>",
      rename?"<div class=\\"item\\"><strong>Rename context</strong><div>"+q(rename.originalName)+" → "+q(rename.suggestedName)+"</div><div class=\\"muted\\">"+q(rename.justification)+"</div></div>":"",
      relatedArtifacts.length?"<div class=\\"row\\">"+relatedArtifacts.map((artifact)=>"<button class=\\"link-btn\\" data-jump-artifact=\\""+q(artifact.id)+"\\">artifact</button>").join("")+"</div>":"",
      "<h3>Outbound</h3>",renderList(outbound.map((edge)=>edge.callee+": "+edge.rationale),"No outbound edges"),
      "<h3>Inbound</h3>",renderList(inbound.map((edge)=>edge.caller+": "+edge.rationale),"No inbound edges")
    ].join(""):"<p class=\\"empty\\">Node not found.</p>";
  }

  function renderNodeList(filter=""){
    const needle=filter.trim().toLowerCase();
    const nodes=data.graphNodes.filter((node)=>!needle||node.id.toLowerCase().includes(needle)||q(node.meta).toLowerCase().includes(needle));
    byId("node-list").innerHTML=nodes.length?nodes.map((node)=>"<div class=\\"node"+(activeNode===node.id?" active":"")+"\\" data-node=\\""+q(node.id)+"\\"><strong>"+q(node.id)+"</strong><div class=\\"muted\\">"+q(node.type)+"</div></div>").join(""):"<div class=\\"node\\"><div class=\\"muted\\">No nodes match the current filter.</div></div>";
    [...byId("node-list").querySelectorAll("[data-node]")].forEach((element)=>element.addEventListener("click",()=>selectNode(element.getAttribute("data-node"))));
  }

  function renderGraph(){
    const needle=byId("graph-search").value.trim().toLowerCase();
    const visibleNodes=data.graphNodes.filter((node)=>!needle||node.id.toLowerCase().includes(needle)||q(node.meta).toLowerCase().includes(needle));
    const visibleIds=new Set(visibleNodes.map((node)=>node.id));
    const visibleEdges=edges.filter((edge)=>visibleIds.has(edge.caller)&&visibleIds.has(edge.callee));
    const nodeIndex=new Map(visibleNodes.map((node)=>[node.id,node]));
    const maxY=Math.max(280,...visibleNodes.map((node)=>node.y+36));
    const edgeSvg=visibleEdges.map((edge)=>{
      const from=nodeIndex.get(edge.caller);const to=nodeIndex.get(edge.callee);if(!from||!to)return "";
      const midX=(from.x+to.x)/2;
      return "<path class=\\"svg-edge\\" d=\\"M "+from.x+" "+from.y+" C "+midX+" "+from.y+", "+midX+" "+to.y+", "+to.x+" "+to.y+"\\" />";
    }).join("");
    const nodeSvg=visibleNodes.map((node)=>{
      const width=Math.min(180,Math.max(96,node.id.length*7+26));const x=node.x-width/2;const y=node.y-16;
      return "<g class=\\"svg-node"+(activeNode===node.id?" active":"")+"\\" data-node=\\""+q(node.id)+"\\"><rect x=\\""+x+"\\" y=\\""+y+"\\" width=\\""+width+"\\" height=\\"32\\" rx=\\"8\\" /><text x=\\""+node.x+"\\" y=\\""+(node.y+4)+"\\" text-anchor=\\"middle\\">"+escapeHtmlRuntime(node.id)+"</text></g>";
    }).join("");
    byId("graph-svg").innerHTML="<svg viewBox=\\"0 0 900 "+maxY+"\\" width=\\"100%\\" height=\\""+Math.min(Math.max(maxY,320),900)+"\\">"+edgeSvg+nodeSvg+"</svg>";
    [...byId("graph-svg").querySelectorAll("[data-node]")].forEach((element)=>element.addEventListener("click",()=>selectNode(element.getAttribute("data-node"))));
  }

  function selectArtifact(artifactId){
    activeArtifactId=artifactId;renderManifest();const artifact=data.manifest.find((entry)=>entry.id===artifactId);
    if(!artifact){byId("artifact-preview").innerHTML="<p class=\\"empty\\">Artifact not found.</p>";return;}
    byId("artifact-preview").innerHTML=[
      "<strong>"+q(artifact.url)+"</strong>",
      "<div class=\\"muted\\" style=\\"margin:6px 0 12px\\">"+q(artifact.type)+" · "+q(artifact.sizeBytes)+" bytes · "+q(artifact.discoveredFrom)+"</div>",
      "<div class=\\"preview-tabs\\"><button class=\\"preview-tab"+(previewMode==="formatted"?" active":"")+"\\" data-preview-mode=\\"formatted\\">Formatted</button><button class=\\"preview-tab"+(previewMode==="raw"?" active":"")+"\\" data-preview-mode=\\"raw\\">Raw</button></div>",
      artifact.summary?"<div class=\\"item\\" style=\\"margin-bottom:12px\\"><strong>Artifact summary</strong><div>"+q(artifact.summary)+"</div></div>":"",
      artifact.relatedNodeIds.length?"<div class=\\"row\\" style=\\"margin-bottom:10px\\">"+artifact.relatedNodeIds.map((nodeId)=>"<button class=\\"link-btn\\" data-jump-node=\\""+q(nodeId)+"\\">"+q(nodeId)+"</button>").join("")+"</div>":"",
      "<pre>"+escapeHtmlRuntime(previewMode==="raw"?artifact.rawPreview:artifact.formattedPreview)+"</pre>"
    ].join("");
    [...byId("artifact-preview").querySelectorAll("[data-preview-mode]")].forEach((element)=>element.addEventListener("click",()=>{previewMode=element.getAttribute("data-preview-mode");selectArtifact(activeArtifactId);}));
    [...byId("artifact-preview").querySelectorAll("[data-jump-node]")].forEach((element)=>element.addEventListener("click",()=>selectNode(element.getAttribute("data-jump-node"))));
  }

  function renderManifest(){
    byId("manifest").innerHTML="<table><thead><tr><th>Artifact</th><th>Type</th><th>Bytes</th><th>Discovery</th><th>Links</th></tr></thead><tbody>"+data.manifest.map((entry)=>"<tr"+(activeArtifactId===entry.id?" style=\\"background:#fff7ed\\"":"")+"><td><div><strong>"+q(entry.url)+"</strong></div><div class=\\"muted\\">"+q(entry.formatting)+(entry.formattingNote?" · "+q(entry.formattingNote):"")+"</div></td><td>"+q(entry.type)+"</td><td>"+q(entry.sizeBytes)+"</td><td>"+q(entry.discoveredFrom)+"</td><td><div class=\\"row\\"><button class=\\"link-btn\\" data-jump-artifact=\\""+q(entry.id)+"\\">preview</button>"+entry.relatedNodeIds.map((nodeId)=>"<button class=\\"link-btn\\" data-jump-node=\\""+q(nodeId)+"\\">node</button>").join("")+"</div></td></tr>").join("")+"</tbody></table>";
  }

  function renderSurfaceSections(){
    const apiCards=data.deterministicSurface.apiEndpoints.map((entry)=>"<div class=\\"item\\"><strong>"+q(entry.url)+"</strong><div>"+q(entry.purpose)+"</div><div class=\\"muted\\">Methods: "+q(entry.methods.join(", ")||"unknown")+" · Request fields: "+q(entry.requestFields.join(", ")||"none")+"</div><div class=\\"row\\" style=\\"margin-top:8px\\"><button class=\\"link-btn\\" data-jump-artifact-by-url=\\""+q(entry.sourceArtifactUrl)+"\\">artifact</button></div></div>");
    const authCards=(data.deterministicSurface.authFlows||[]).map((flow)=>"<div class=\\"item\\"><strong>"+q(flow.title)+"</strong><div>Triggers: "+q(flow.triggers.join(", ")||"none")+"</div><div class=\\"muted\\">Tokens: "+q(flow.tokens.join(", ")||"none")+" · Errors: "+q(flow.errors.join(", ")||"none")+"</div><div class=\\"row\\" style=\\"margin-top:8px\\">"+(flow.relatedArtifactUrls||[]).map((artifactUrl)=>"<button class=\\"link-btn\\" data-jump-artifact-by-url=\\""+q(artifactUrl)+"\\">artifact</button>").join("")+"</div></div>");
    const captchaCards=(data.deterministicSurface.captchaFlows||[]).map((flow)=>"<div class=\\"item\\"><strong>"+q(flow.provider)+"</strong><div>Triggers: "+q(flow.triggers.join(", ")||"none")+"</div><div class=\\"muted\\">Endpoints: "+q(flow.endpoints.join(", ")||"none")+" · Errors: "+q(flow.errors.join(", ")||"none")+"</div><div class=\\"row\\" style=\\"margin-top:8px\\">"+(flow.relatedArtifactUrls||[]).map((artifactUrl)=>"<button class=\\"link-btn\\" data-jump-artifact-by-url=\\""+q(artifactUrl)+"\\">artifact</button>").join("")+"</div></div>");
    const sections=[
      ["REST endpoints",apiCards],
      ["OpenAPI / Swagger",data.deterministicSurface.openApiDocuments.map((entry)=>"<div class=\\"item\\"><strong>"+q(entry.url)+"</strong><div class=\\"muted\\">"+q(entry.pathSummaries.join("; ")||"No parsed path summaries")+"</div></div>")],
      ["GraphQL",data.deterministicSurface.graphQlEndpoints.map((entry)=>"<div class=\\"item\\"><strong>"+q(entry.url)+"</strong><div class=\\"muted\\">Introspection: "+q(entry.introspectionStatus)+" · "+q(entry.sampleFields.join(", ")||"No schema hints")+"</div>"+(entry.sourceArtifactUrl?"<div class=\\"row\\" style=\\"margin-top:8px\\"><button class=\\"link-btn\\" data-jump-artifact-by-url=\\""+q(entry.sourceArtifactUrl)+"\\">artifact</button></div>":"")+"</div>").concat(data.deterministicSurface.graphQlOperations.map((entry)=>"<div class=\\"item\\"><strong>"+q(entry.operationType)+" "+q(entry.operationName)+"</strong><div>"+q(entry.sampleRequest)+"</div><div class=\\"muted\\">Expected response: "+q(entry.expectedResponse)+"</div><div class=\\"row\\" style=\\"margin-top:8px\\"><button class=\\"link-btn\\" data-jump-artifact-by-url=\\""+q(entry.sourceArtifactUrl)+"\\">artifact</button></div></div>"))],
      ["Auth flow",authCards],
      ["Captcha flow",captchaCards],
      ["Fingerprinting",data.deterministicSurface.fingerprintingSignals.map((signal)=>"<div class=\\"item\\"><strong>"+q(signal.collector)+"</strong><div>"+q(signal.purpose)+"</div><div class=\\"muted\\">Data: "+q(signal.dataPoints.join(", ")||"none")+" · Destinations: "+q(signal.destinationUrls.join(", ")||"none")+"</div></div>")],
      ["Encryption / signing",data.deterministicSurface.encryptionSignals.map((signal)=>"<div class=\\"item\\"><strong>"+q(signal.algorithmHints.join(", ")||"Unknown algorithms")+"</strong><div class=\\"muted\\">Inputs: "+q(signal.inputs.join(", ")||"none")+" · Outputs: "+q(signal.outputs.join(", ")||"none")+" · Destinations: "+q(signal.destinationUrls.join(", ")||"none")+"</div></div>")],
      ["Security findings",data.deterministicSurface.securityFindings.map((finding)=>"<div class=\\"item\\"><strong>["+q(finding.severity)+"] "+q(finding.title)+"</strong><div>"+q(finding.detail)+"</div><div class=\\"muted\\">Remediation: "+q(finding.remediation)+"</div></div>")]
    ];
    byId("surface-sections").innerHTML=sections.map(([title,items])=>"<div><h3>"+q(title)+"</h3>"+(items.length?items.join(""):"<p class=\\"empty\\">No entries.</p>")+"</div>").join("");
  }

  function bindGlobalLinks(){
    document.addEventListener("click",(event)=>{
      const target=event.target.closest("[data-jump-node],[data-jump-artifact],[data-jump-artifact-by-url]");
      if(!target)return;
      event.preventDefault();
      if(target.hasAttribute("data-jump-node")){selectNode(target.getAttribute("data-jump-node"));byId("graph-stage").scrollIntoView({behavior:"smooth",block:"nearest"});}
      if(target.hasAttribute("data-jump-artifact")){selectArtifact(target.getAttribute("data-jump-artifact"));byId("artifact-stage").scrollIntoView({behavior:"smooth",block:"nearest"});}
      if(target.hasAttribute("data-jump-artifact-by-url")){const artifact=data.manifest.find((entry)=>entry.url===target.getAttribute("data-jump-artifact-by-url"));if(artifact){selectArtifact(artifact.id);byId("artifact-stage").scrollIntoView({behavior:"smooth",block:"nearest"});}}
    });
  }

  byId("meta").innerHTML=[["Status",data.summary.reportStatus==="complete"?"<span class=\\"badge-ok\\">complete</span>":"<span class=\\"badge-warn\\">partial</span>"],["Pages",data.summary.pages],["Artifacts",data.summary.artifacts],["Chunks",data.summary.chunks],["REST",data.deterministicSurface.apiEndpoints.length],["GraphQL",data.deterministicSurface.graphQlEndpoints.length],["Auth flows",(data.deterministicSurface.authFlows||[]).length],["Captcha",(data.deterministicSurface.captchaFlows||[]).length],["Fingerprinting",data.deterministicSurface.fingerprintingSignals.length],["Encryption",data.deterministicSurface.encryptionSignals.length],["Risks",data.risks.length],["Libraries",data.notableLibraries.length]].map(([label,value])=>"<div class=\\"metric\\"><strong>"+value+"</strong><span>"+label+"</span></div>").join("");
  byId("overview").innerHTML="<p>"+q(data.overview)+"</p>"+(data.summary.analysisError?"<p class=\\"badge-warn\\">Analysis error: "+q(data.summary.analysisError)+"</p>":"");
  byId("quick-findings").innerHTML=[["Entry points",data.entryPoints.map((entry)=>entry.symbol+": "+entry.description)],["Initialization flow",data.initializationFlow],["Investigation tips",data.investigationTips],["Risks",data.risks]].map(([title,items])=>"<div><strong>"+title+"</strong>"+renderList(items,"No entries")+"</div>").join("");
  byId("dom-surface").innerHTML=data.domSnapshots.length?data.domSnapshots.map((snapshot)=>"<div class=\\"item\\"><strong>"+q(snapshot.url)+"</strong><div class=\\"muted\\">"+q(snapshot.summary)+"</div></div>").join(""):"<p class=\\"empty\\">No DOM snapshots captured.</p>";
  byId("graph-search").addEventListener("input",()=>{renderNodeList(byId("graph-search").value);renderGraph();});
  renderNodeList();renderGraph();renderManifest();renderSurfaceSections();bindGlobalLinks();
  if(data.graphNodes.length){selectNode(data.graphNodes[0].id);}
  if(activeArtifactId){selectArtifact(activeArtifactId);}
`;

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
  <style>${REPORT_STYLE}</style>
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
        <section class="panel" id="graph-stage">
          <h2>Interactive Code Map</h2>
          <div class="row" style="margin-bottom:12px">
            <input id="graph-search" class="search" type="search" placeholder="Filter functions, symbols, entry points">
          </div>
          <div class="graph-shell">
            <div class="graph-stage" id="graph-svg"></div>
            <div class="stack">
              <div class="node-list" id="node-list"></div>
              <div class="graph-detail" id="graph-detail"><p class="empty">Select a node to inspect inbound and outbound relationships.</p></div>
            </div>
          </div>
        </section>
        <section class="panel">
          <h2>API And Flow Surface</h2>
          <div id="surface-sections" class="stack"></div>
        </section>
        <section class="panel" id="artifact-stage">
          <h2>Artifact Manifest</h2>
          <div class="artifact-layout">
            <div class="manifest" id="manifest"></div>
            <div class="artifact-preview" id="artifact-preview"><p class="empty">Select an artifact to inspect raw and formatted previews.</p></div>
          </div>
        </section>
      </main>
    </div>
  </div>
  <script id="mapr-data" type="application/json">${escapeHtml(embeddedData)}</script>
  <script>${REPORT_SCRIPT}</script>
</body>
</html>`;
  }
}
