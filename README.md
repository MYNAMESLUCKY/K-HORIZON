# K-Horizon

K-Horizon is a token-efficient, customizable AI coding assistant extension for VS Code. Built on LangChain's LangGraph, it orchestrates specialized agent profiles to perform multi-file modifications, inline code edits, conversational chat, and ghost-text autocomplete. It supports cloud-hosted model providers, local runners (like Ollama), or any custom OpenAI-compatible endpoint.

## Key Features

*   **Inline Code Edits**: Highlight code, enter instructions, and view streaming, color-coded inline diffs. Accept or revert edits using keyboard shortcuts.
*   **Sidebar Chat**: Talk with an assistant that has access to your workspace. Mention specific files with `@filename` or enable workspace context for similarity-based RAG search.
*   **Workspace Composer**: Execute multi-file modifications across the workspace and review changes side-by-side using VS Code's native diff editor before applying.
*   **Ghost-Text Autocomplete**: Non-intrusive, debounced completion suggestions that can be accepted with the Tab key.
*   **Self-Healing Agent Loop**: Evaluates compiler and test diagnostics to automatically correct errors across up to 3 repair passes.
*   **MCP Support**: Integrates external tool servers using the Model Context Protocol.
*   **Workspace Vector RAG**: Automatically retrieves and attaches relevant code snippets using similarity search on Supabase (pgvector).
*   **Continuous Learning**: Logs mistakes and corrections locally in `.k-horizon/agent-learning.json` to prevent repeating errors.

## Documentation

*   [Setup & Usage Guide](INSTRUCTIONS.md): Prerequisites, installation, and user interface controls.
*   [System Architecture](ARCHITECTURE.md): Design diagrams, module breakdown, and data flows.

## Configuration Reference

Configure the extension by opening VS Code Settings (`Ctrl+,` or `Cmd+,`) and searching for `K-Horizon`:

| Setting ID | Default Value | Description |
| :--- | :--- | :--- |
| `k-horizon.provider` | `"Gemini"` | Primary chat model provider (cloud APIs, Ollama, custom OpenAI-compatible endpoints, etc.). |
| `k-horizon.apiKey` | `""` | API key for the selected provider. |
| `k-horizon.chatModel` | `"gemini-1.5-flash"` | Model ID for Chat, Composer, and Inline Edits. |
| `k-horizon.plannerModel` | `"gemini-1.5-flash"` | Model ID for planning, routing, and tool choices in the agent loop. |
| `k-horizon.coderModel` | `"gemini-1.5-flash"` | Model ID for code generation and file modifications. |
| `k-horizon.autocompleteModel` | `"gemini-1.5-flash"` | Lightweight model ID for inline autocomplete. |
| `k-horizon.enableAutocomplete` | `true` | Toggle ghost-text inline code completions. |
| `k-horizon.supabaseConnectionString`| `""` | Database connection string. Use `SecretStorage` via the Command Palette to avoid storing passwords in plain text. |
| `k-horizon.aicreditsApiKey` | `""` | API Key for embedding model authentication. |
| `k-horizon.useWorkspaceContext` | `true` | Automatically retrieve and inject relevant codebase snippets (RAG) into queries. |
| `k-horizon.autoApprove` | `true` | Automatically approve high-confidence agent actions. |
| `k-horizon.autoCompile` | `false` | Automatically compile the project after edits to check for errors. |
| `k-horizon.autoTest` | `false` | Automatically run unit tests after edits to verify changes. |
| `k-horizon.sandboxMode` | `"None"` | Run shell commands inside a secure Docker container instead of local terminal. |

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
