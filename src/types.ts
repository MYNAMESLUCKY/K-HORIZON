export interface CustomModelConfig {
  name: string;
  modelId: string;
  baseURL: string;
  apiKey?: string;
  provider?: 'OpenAI' | 'Ollama' | 'Anthropic' | 'Gemini';
}

export interface Settings {
  provider: 'Gemini' | 'Ollama' | 'OpenAI' | 'Anthropic' | 'OpenRouter' | 'Custom' | 'Copilot';
  apiKey: string;
  baseURL: string;
  chatModel: string;
  plannerModel: string;
  coderModel: string;
  autocompleteModel: string;
  visionModel: string;
  enableAutocomplete: boolean;
  maxContextTokens: number;
  systemPrompt: string;
  customModels: CustomModelConfig[];
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface WorkspaceFile {
  filePath: string;
  relativePath: string;
  content?: string;
  summary?: string;
}

export interface DiffBlock {
  searchContent: string;
  replaceContent: string;
}

export interface FileEdit {
  filePath: string;
  relativePath: string;
  originalContent: string;
  proposedContent: string;
  diffs: DiffBlock[];
  status: 'pending' | 'accepted' | 'rejected';
}

export interface AgentProfile {
  key: string;
  name: string;
  systemPrompt: string;
  modelId?: string;
  provider?: string;
  temperature?: number;
}

export interface LineDiffItem {
  type: 'added' | 'removed' | 'normal';
  text: string;
}


