## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, query the graph instead of grepping raw files: `graphify query "<question>" --budget 1500`, `graphify explain "<node>"`, `graphify path "A" "B"`. GRAPH_REPORT.md is ~15k tokens: do not read it whole, grep it for a community or node name
- The graph does not index `.cjs` natively. The Electron main-process files (`electron/**/*.cjs`) were added through `.js` copies; `graphify update .` skips them, so read those files directly and rebuild with `/graphify . --update` after big main-process changes
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)
