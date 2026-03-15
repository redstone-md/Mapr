# Mapr

Mapr is a Bun-native CLI/TUI for reverse-engineering frontend websites and build outputs. It crawls a target site, downloads related code artifacts, formats them for readability, runs a communicating AI swarm over chunked artifact content, and produces a Markdown analysis report with entry points, initialization flow, inferred call graph edges, restored names, investigation tips, and artifact summaries.

## What It Analyzes

- HTML entry pages and linked same-origin pages
- JavaScript bundles and imported chunks
- Service workers and worker scripts
- Stylesheets and manifests
- Referenced WASM modules through binary summaries
- Cross-linked website artifacts discovered from page code
- Optional local lexical RAG for oversized artifacts such as multi-megabyte bundles

## Runtime

- Bun only
- TypeScript in strict mode
- Interactive terminal UX with `@clack/prompts`
- AI analysis through Vercel AI SDK using OpenAI or OpenAI-compatible providers
- Headless CLI mode for automation
- Live swarm progress with agent-level tracking and progress bars

## Workflow

1. Load or configure AI provider settings from `~/.mapr/config.json`
2. Discover models from the provider `/models` endpoint
3. Let the user search and select a model, then save the model context size
4. Crawl the target website and fetch related artifacts
5. Format analyzable content where possible
6. Optionally build a local lexical RAG index for oversized artifacts
7. Run a communicating swarm of analysis agents over chunked artifact content
8. Generate a Markdown report in the current working directory

## Quick Start

```bash
bun install
bun run index.ts
```

If the package is published and Bun is installed locally:

```bash
npx @redstone-md/mapr --help
```

## Headless Examples

```bash
npx @redstone-md/mapr \
  --headless \
  --url http://localhost:5178 \
  --provider-type openai-compatible \
  --provider-name "Local vLLM" \
  --api-key secret \
  --base-url http://localhost:8000/v1 \
  --model qwen2.5-coder \
  --context-size 512000 \
  --local-rag
```

```bash
npx @redstone-md/mapr --list-models --headless --provider-type openai-compatible --api-key secret --base-url http://localhost:8000/v1
```

## Swarm Design

Mapr uses a communicating agent swarm per chunk:

- `scout`: maps artifact surface area and runtime clues
- `runtime`: reconstructs initialization flow and call relationships
- `naming`: restores variable and function names from context
- `security`: identifies risks, persistence, caching, and operator tips
- `synthesizer`: merges the upstream notes into the final chunk analysis

Progress is shown as a task progress bar plus agent/chunk status updates.

## Large Bundle Handling

- Mapr stores the selected model context size and derives a larger chunk budget from it.
- Optional `--local-rag` mode builds a local lexical retrieval index so very large artifacts such as 5 MB bundles can feed more relevant sibling segments into the swarm without forcing the whole file into one prompt.
- Formatting no longer has a hard artifact-size cutoff. If formatting fails, Mapr falls back to raw content instead of skipping by size.

## Output

Each run writes a file named like:

```text
report-example.com-2026-03-15T12-34-56-789Z.md
```

## Disclaimer

- Mapr produces assisted reverse-engineering output, not a formal proof of program behavior.
- AI-generated call graphs, renamed symbols, summaries, and tips are inference-based and may be incomplete or wrong.
- Website analysis may include proprietary or sensitive code. Use Mapr only when you are authorized to inspect the target.
- WASM support is summary-based unless you extend the project with deeper binary lifting or disassembly.

## Contribution Terms

- This project is source-available and closed-license, not open source.
- Contributions are accepted only under the repository owner’s terms.
- By submitting a contribution, you agree that the maintainer may use, modify, relicense, and redistribute your contribution as part of Mapr without compensation.
- Do not submit code unless you have the rights to contribute it.

## License

Use of this project is governed by the custom license in [LICENSE](./LICENSE).
