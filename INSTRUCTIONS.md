# Setup and Usage Guide

This guide describes how to build, configure, and use the K-Horizon extension.

## 1. Prerequisites

Before installing the extension, ensure the following are configured:
*   **Node.js**: Version 18.0.0 or higher.
*   **Supabase Database**: A running instance with `pgvector` enabled.
*   **Ollama (Optional)**: Running locally if using local models for code outlining and autocompletion.
*   **Embedding Provider**: An API key or endpoint configured for your chosen embedding model.

## 2. Installation and Build

### Running in Development (Debug Mode)
1. Open the project folder in VS Code.
2. Run `npm install` in the terminal to install dependencies.
3. Press `F5` (or select `Launch Extension` in the Run & Debug panel) to open a new window tagged `[Extension Development Host]`.
4. Open your target workspace inside the host window to test.

### Packaging and Permanent Installation
1. Compile the code:
   ```bash
   npm run compile
   ```
2. Package the extension:
   ```bash
   npx @vscode/vsce package
   ```
   This generates a `k-horizon-1.0.1.vsix` file in the root directory.
3. Open VS Code, open the Extensions panel (`Ctrl+Shift+X`), click the ellipsis (`...`) menu at the top-right, select **Install from VSIX...**, and choose the generated `.vsix` file.

## 3. Configuration

Configure the API keys and endpoints in the VS Code Settings under `K-Horizon`:

| Setting ID | Default Value | Description |
| :--- | :--- | :--- |
| `k-horizon.provider` | `"Gemini"` | Chat model provider (Cloud APIs, Ollama, custom OpenAI-compatible endpoints). |
| `k-horizon.apiKey` | `""` | API key for the selected provider. |
| `k-horizon.chatModel` | `"gemini-1.5-flash"` | The model ID used for Chat, Composer, and Inline Edits. |
| `k-horizon.supabaseConnectionString` | `""` | Database connection string. Use `SecretStorage` via the command palette to avoid committing credentials in plain text. |
| `k-horizon.aicreditsApiKey` | `""` | API Key for embedding model authentication. |
| `k-horizon.enableAutocomplete` | `true` | Enables ghost-text inline completion. |

*Note: Use the command `K-Horizon: Set Supabase Connection String` from the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`) to securely store your database connection string.*

## 4. Usage and Shortcuts

### Inline Edits
*   **Trigger**: Select a block of code (or position your cursor) and press `Ctrl+Shift+K` (macOS: `Cmd+Shift+K`).
*   **Action**: Type your instructions and press Enter. The edits stream directly into the active editor.
*   **Keyboard Controls**:
    *   `Enter`: Accept the suggestion and apply the edits.
    *   `Escape`: Revert the suggestion and discard changes.

### Sidebar Chat
*   **Trigger**: Focus the sidebar view using `Ctrl+Shift+L` (macOS: `Cmd+Shift+L`).
*   **File Context**: Type `@` to select and pin specific workspace files to the chat context. Large files are outlined and cached automatically.
*   **Workspace RAG**: Check "Use workspace context" to embed your query and inject relevant codebase snippets (using pgvector similarity search) into the context.
*   **Chat History**: Saved in Supabase. Run `K-Horizon: Clear Chat History` from the Command Palette to wipe saved conversations.

### Workspace Composer
*   **Trigger**: Open the Composer tab using `Ctrl+Shift+I` (macOS: `Cmd+Shift+I`).
*   **Action**: Describe workspace-wide, multi-file changes (e.g. creating new modules or refactoring cross-file dependencies).
*   **Diff Review**: Select a file in the generated lists to view a side-by-side diff in VS Code. Click Accept/Discard to commit or reject changes.

### Ghost-Text Autocomplete
*   Suggestions appear as gray ghost text in the editor pane.
*   Press `Tab` to accept and insert suggestions.
