# Mapr

Mapr is a Bun-native CLI/TUI for reverse-engineering frontend websites and build outputs. It crawls a target site, downloads related code artifacts, formats them for readability, sends chunked artifact content to an AI provider, and produces a Markdown analysis report with entry points, initialization flow, inferred call graph edges, restored names, investigation tips, and artifact summaries.

## What It Analyzes

- HTML entry pages and linked same-origin pages
- JavaScript bundles and imported chunks
- Service workers and worker scripts
- Stylesheets and manifests
- Referenced WASM modules through binary summaries
- Cross-linked website artifacts discovered from page code

## Runtime

- Bun only
- TypeScript in strict mode
- Interactive terminal UX with `@clack/prompts`
- AI analysis through Vercel AI SDK using OpenAI or OpenAI-compatible providers

## Workflow

1. Load or configure AI provider settings from `~/.mapr/config.json`
2. Discover models from the provider `/models` endpoint
3. Let the user search and select a model
4. Crawl the target website and fetch related artifacts
5. Format analyzable content where possible
6. Chunk artifacts for LLM-safe analysis
7. Generate a Markdown report in the current working directory

## Quick Start

```bash
bun install
bun run index.ts
```

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
