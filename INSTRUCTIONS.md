# K-HORIZON: Setup & Usage Guide

**K-HORIZON** is a lightweight, token-efficient VS Code extension that duplicates the core features of Cursor. It is configured to run cloud or local models, store outline metadata in **Supabase**, and perform semantic vector RAG searches using customizable vector embeddings.

---

## 1. Prerequisites

Before installing the extension, make sure you have:
*   **Node.js** (v18.0.0 or higher) & **npm** installed.
*   **Ollama** running locally with your chosen model installed for semantic codebase outlines (optional fallback to regex is built-in).
*   Your **Supabase database** running (pre-configured to your connection string).
*   An API key / endpoint config for your chosen embedding or LLM provider.

---

## 2. Installation Methods

### Method A: Run in Debug Mode (Recommended for testing)
To run the extension in a temporary test window:
1.  Open VS Code in this project folder.
2.  Press **`F5`** (or go to *Run and Debug* and select **Launch Extension**).
3.  A new window tagged `[Extension Development Host]` will open.
4.  Open any test project inside this new window.

### Method B: Install Permanently in Your VS Code
To install the extension directly into your primary VS Code editor:
1.  Open your terminal in this project directory.
2.  Package the extension into a `.vsix` file by running:
    ```bash
    npx -y @vscode/vsce package
    ```
3.  This generates a file named `k-horizon-1.0.1.vsix` in the root folder.
4.  Open your main VS Code window, open the **Extensions** panel (`Ctrl+Shift+X`), click the **three dots (`...`)** at the top right, select **Install from VSIX...**, and choose the `.vsix` file.

---

## 3. Configuration Setup

Once the extension is running (in Debug Mode or Installed), you must configure your API keys:
1.  Open VS Code Settings (`Ctrl+,` or `Cmd+,`).
2.  Search for **`K-Horizon`**.
3.  Set the following parameters:

| Setting ID | Default Value | Description |
| :--- | :--- | :--- |
| `k-horizon.provider` | `"Gemini"` | Your primary chat model provider (cloud APIs, Ollama, custom OpenAI-compatible endpoints, etc.). |
| `k-horizon.apiKey` | `""` | The API key for your chosen chat provider. |
| `k-horizon.chatModel` | `"gemini-1.5-flash"` | The model ID to use for Chat, Composer, and Inline Edits (can be customized). |
| `k-horizon.supabaseConnectionString` | `""` | PostgreSQL connection string for Supabase vector search, outline caching, and chat history. **Set via SecretStorage** (`K-HORIZON: Set Supabase Connection String` command) — do **NOT** commit this value to source control. |
| `k-horizon.aicreditsApiKey` | `""` | API Key for embedding model authentication. |
| `k-horizon.enableAutocomplete` | `true` | Enable or disable ghost-text inline completions. |

---

## 4. Usage Guide & Keyboard Shortcuts

### 🚀 Inline Code Editing (`Ctrl+Shift+K` / `Cmd+Shift+K`)
*   **How it works**: Select a block of code (or click on a line) and press `Ctrl+Shift+K`. Type your instructions (e.g. "add try-catch block") and hit Enter.
*   **Accepting/Undoing**: The proposed edits stream directly into the file highlighted in light green. 
    *   Press **`Enter`** to accept the changes.
    *   Press **`Escape`** to discard the changes and revert the file.

### 💬 Sidebar Chat (`Ctrl+Shift+L` / `Cmd+Shift+L`)
*   **How it works**: Focuses the K-Horizon AI panel in the Activity Bar. You can chat about your project.
*   **Mentions (`@file`)**: Type **`@`** inside the input area to bring up a list of project files. Click a file or press Enter to lock it as context. Large files are automatically compressed on-demand using your local model and cached in Supabase.
*   **Workspace Vector RAG**: Tick the **Use workspace context** checkbox. When you submit your prompt, the extension embeds your question, runs a cosine-similarity pgvector query in Supabase, and injects the top 5 most relevant code snippets from your repository automatically.
*   **Chat History**: Chat history is persisted in Supabase `chat_history`. It will reload when you open VS Code. Click the **Clear** button (or run `K-Horizon: Clear Chat History` from the command palette) to wipe it.

### 🎼 Workspace Composer (`Ctrl+Shift+I` / `Cmd+Shift+I`)
*   **How it works**: Opens a large Composer tab. Describe workspace-wide modifications (e.g. "add a logger module in src/log.ts and import it in index.ts").
*   **Diff Review**: Composer generates files and proposes edits:
    *   Click on any file in the list to open VS Code's **native side-by-side diff editor** showing the exact differences.
    *   Click **Accept** or **Discard** next to each file, or click **Accept All** / **Discard All** at the top.

### ✍️ Ghost-Text Autocomplete
*   **How it works**: As you write code, the extension automatically queries the model in the background (debounced at 250ms). Suggestions appear as gray "ghost text".
*   **Accepting**: Press **`Tab`** to insert the suggested code.
