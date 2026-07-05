(function() {
  const vscode = acquireVsCodeApi();
  
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const messagesDiv = document.getElementById('messages');
  const tagsContainer = document.getElementById('tagsContainer');
  const rollbackBtn = document.getElementById('rollbackBtn');
  const suggestList = document.getElementById('suggestList');
  const workspaceCheckbox = document.getElementById('workspaceCheckbox');
  const autoApproveCheckbox = document.getElementById('autoApproveCheckbox');
  const modelSelector = document.getElementById('modelSelector');
  const attachFileBtn = document.getElementById('attachFileBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const roleSelector = document.getElementById('roleSelector');
  const autoCompileCheckbox = document.getElementById('autoCompileCheckbox');
  const autoTestCheckbox = document.getElementById('autoTestCheckbox');
  const stepDebugCheckbox = document.getElementById('stepDebugCheckbox');
  const improvePromptBtn = document.getElementById('improvePromptBtn');

  // Header Elements
  const historyBtn = document.getElementById('historyBtn');
  const compactBtn = document.getElementById('compactBtn');
  const newChatBtn = document.getElementById('newChatBtn');
  const closeDrawerBtn = document.getElementById('closeDrawerBtn');
  const historyDrawer = document.getElementById('historyDrawer');
  const historyList = document.getElementById('historyList');
  const compactBanner = document.getElementById('compactBanner');
  const healthBtn = document.getElementById('healthBtn');
  const healthModal = document.getElementById('healthModal');
  const closeHealthModalBtn = document.getElementById('closeHealthModalBtn');
  const healthGrid = document.getElementById('healthGrid');
  const promptLibraryBtn = document.getElementById('promptLibraryBtn');
  const promptLibraryModal = document.getElementById('promptLibraryModal');
  const closePromptLibraryBtn = document.getElementById('closePromptLibraryBtn');
  const promptTemplateList = document.getElementById('promptTemplateList');
  const promptTemplateName = document.getElementById('promptTemplateName');
  const promptTemplateBody = document.getElementById('promptTemplateBody');
  const savePromptTemplateBtn = document.getElementById('savePromptTemplateBtn');

  // Collapsible elements
  const toolsSection = document.getElementById('toolsSection');
  const tokenHudSection = document.getElementById('tokenHudSection');
  const toolsSectionValue = document.getElementById('toolsSectionValue');

  // Restore collapsible open states from localStorage
  if (toolsSection) {
    const state = localStorage.getItem('k-horizon-toolsSection-open');
    if (state !== null) toolsSection.open = state === 'true';
    toolsSection.addEventListener('toggle', () => {
      localStorage.setItem('k-horizon-toolsSection-open', toolsSection.open);
      updateCollapsibleSummaries();
    });
  }
  if (tokenHudSection) {
    const state = localStorage.getItem('k-horizon-tokenHudSection-open');
    if (state !== null) tokenHudSection.open = state === 'true';
    tokenHudSection.addEventListener('toggle', () => {
      localStorage.setItem('k-horizon-tokenHudSection-open', tokenHudSection.open);
    });
  }

  const activeToolCalls = new Map();
  let workspaceFiles = []; // Loaded from extension
  let selectedFiles = []; // Array of {filePath, relativePath}
  let suggestMode = false;
  let suggestType = '';
  let suggestQuery = '';
  let suggestStartIndex = -1;
  let selectedSuggestIndex = 0;
  let filteredSuggestions = [];
  let currentStreamingBubble = null;
  let currentStreamedRawText = '';
  let currentStreamingBubble2 = null;
  let currentStreamedRawText2 = '';
  let isSplitScreen = false;
  let activeSessionId = 'default';
  let isAgentActive = false;
  let maxContextTokens = 131000;
  let lastHealthSnapshot = null;

  const tabChatBtn = document.getElementById('tabChatBtn');
  const tabArtifactsBtn = document.getElementById('tabArtifactsBtn');
  const chatTabContent = document.getElementById('chatTabContent');
  const artifactsTabContent = document.getElementById('artifactsTabContent');
  const artifactsCountBadge = document.getElementById('artifactsCountBadge');
  const artifactsEmptyState = document.getElementById('artifactsEmptyState');
  const artifactsList = document.getElementById('artifactsList');

  let artifacts = [];

  if (tabChatBtn && tabArtifactsBtn && chatTabContent && artifactsTabContent) {
    tabChatBtn.addEventListener('click', () => {
      tabChatBtn.classList.add('active');
      tabArtifactsBtn.classList.remove('active');
      chatTabContent.style.display = 'flex';
      artifactsTabContent.style.display = 'none';
    });

    tabArtifactsBtn.addEventListener('click', () => {
      tabArtifactsBtn.classList.add('active');
      tabChatBtn.classList.remove('active');
      artifactsTabContent.style.display = 'flex';
      chatTabContent.style.display = 'none';
      renderArtifactsTab();
    });
  }

  // Initialize Agent Loader Spinner
  const agentLoader = document.createElement('div');
  agentLoader.className = 'agent-activity-loader';
  agentLoader.innerHTML = `
    <span class="loader-dot"></span>
    <span class="loader-dot"></span>
    <span class="loader-dot"></span>
    <span class="loader-text">Working…</span>
  `;
  messagesDiv.appendChild(agentLoader);

  // Auto-resize chat input height dynamically
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 180) + 'px';
  });

  // Set focus on input initially
  chatInput.focus();

  // Request initial file list and settings from workspace
  vscode.postMessage({ command: 'requestWorkspaceFiles' });
  vscode.postMessage({ command: 'requestSettings' });
  vscode.postMessage({ command: 'getMcpServers' });

  // --- Lightweight Message Broker for webview-side message dispatch ---
  class MessageBroker {
    constructor() { this._handlers = new Map(); }
    on(type, handler) { this._handlers.set(type, handler); }
    dispatch(message) {
      const handler = this._handlers.get(message.type);
      if (handler) handler(message);
    }
  }

  const broker = new MessageBroker();

  // -- Workspace & Settings handlers --
  broker.on('workspaceFiles', (msg) => { workspaceFiles = msg.files || []; });
  broker.on('settingsUpdate', (msg) => {
    maxContextTokens = msg.maxContextTokens || 131000;
    updateModelSelector(msg.provider, msg.chatModel, msg.customModels, msg.vscodeLMModels);
    updateTokenHUD();
  });
  broker.on('agentProfiles', (msg) => {
    agentProfiles = msg.profiles || [];
    updateRoleSelector();
  });
  broker.on('workspaceHealth', (msg) => {
    lastHealthSnapshot = msg.health;
    renderWorkspaceHealth(msg.health);
  });

  // -- Session handlers --
  broker.on('chatHistory', (msg) => { renderFullHistory(msg.history); });
  broker.on('chatSessions', (msg) => { renderSessionsList(msg.sessions); });
  broker.on('sessionCompacted', () => { showCompactedBanner(); });
  broker.on('clearChat', () => {
    resetChatUI();
    artifacts = [];
    if (artifactsCountBadge) { artifactsCountBadge.innerText = '0'; }
    renderArtifactsTab();
    appendSystemMessage("Chat history cleared.");
  });

  broker.on('improvePromptProgress', (msg) => {
    chatInput.value = msg.text;
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 180) + 'px';
  });

  broker.on('improvePromptComplete', (msg) => {
    chatInput.value = msg.text;
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 180) + 'px';
    if (improvePromptBtn) {
      improvePromptBtn.disabled = false;
      improvePromptBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="m15 4-2 2L5 14l-2 2v3h3l2-2 8-8-2-2zM19 11l2-2M20.5 4.5l-1-1M19 3l-2 2M14 2l1 1"></path>
        </svg>
        <span>Improve</span>
      `;
    }
    chatInput.disabled = false;
    chatInput.focus();
  });

  broker.on('improvePromptError', (msg) => {
    if (improvePromptBtn) {
      improvePromptBtn.disabled = false;
      improvePromptBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="m15 4-2 2L5 14l-2 2v3h3l2-2 8-8-2-2zM19 11l2-2M20.5 4.5l-1-1M19 3l-2 2M14 2l1 1"></path>
        </svg>
        <span>Improve</span>
      `;
    }
    chatInput.disabled = false;
    chatInput.focus();
    appendSystemMessage("Error improving prompt: " + msg.error);
  });

  // -- Stream handlers --
  broker.on('streamStart', (msg) => {
    isAgentActive = true;
    if (rollbackBtn) rollbackBtn.style.display = 'none';
    if (msg.column === 'right') {
      currentStreamedRawText2 = '';
    } else {
      currentStreamedRawText = '';
    }
    appendAssistantMessageStartSplit(msg.column || 'left');
    if (cancelBtn) cancelBtn.style.display = 'flex';
    if (sendBtn) sendBtn.style.display = 'none';
  });
  broker.on('referencesUsed', (msg) => {
    const targetBubble = msg.column === 'right' ? currentStreamingBubble2 : currentStreamingBubble;
    if (targetBubble) {
      renderReferencesInBubble(targetBubble, msg.references);
    }
  });
  broker.on('streamToken', (msg) => {
    if (msg.token !== null && msg.token !== undefined && msg.token !== 'null' && msg.token !== 'undefined') {
      appendAssistantTokenSplit(msg.token, msg.column || 'left');
    }
  });
  broker.on('streamEnd', (msg) => {
    isAgentActive = false;
    agentLoader.style.display = 'none';
    finalizeAssistantMessageSplit(msg.column || 'left');
    chatInput.disabled = false;
    sendBtn.disabled = false;
    if (improvePromptBtn) improvePromptBtn.disabled = false;
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (sendBtn) sendBtn.style.display = 'flex';
    if (rollbackBtn) {
      const hasMessages = messagesDiv.querySelectorAll('.message').length > 1;
      rollbackBtn.style.display = hasMessages ? 'inline-flex' : 'none';
    }
    chatInput.focus();
  });
  broker.on('streamError', (msg) => {
    isAgentActive = false;
    agentLoader.style.display = 'none';
    appendSystemError(msg.error);
    chatInput.disabled = false;
    if (improvePromptBtn) improvePromptBtn.disabled = false;
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (sendBtn) sendBtn.style.display = 'flex';
  });

  // -- Tool handlers --
  broker.on('showChecklistPrompt', (msg) => {
    agentLoader.style.display = 'none';
    renderToolChecklist(msg.toolCalls);
  });
  broker.on('toolCallStarted', (msg) => {
    agentLoader.style.display = 'flex';
    messagesDiv.appendChild(agentLoader);
    scrollToBottom();
    appendToolCard(msg.toolCallId, msg.name, msg.arguments, msg.needsApproval, msg.isStepMode);
  });
  broker.on('toolCallFinished', (msg) => {
    updateToolCardResult(msg.toolCallId, msg.name, msg.result, msg.error);
    if (!msg.error && (msg.name === 'write_file' || msg.name === 'edit_file')) {
      const call = activeToolCalls.get(msg.toolCallId);
      if (call && call.args && call.args.file_path) {
        const filePath = call.args.file_path;
        const fileName = filePath.split('/').pop().split('\\').pop();
        const content = call.args.content || call.args.replacement_content || '';
        const existingIdx = artifacts.findIndex(art => art.filePath === filePath);
        if (existingIdx >= 0) {
          artifacts[existingIdx].content = content;
        } else {
          artifacts.push({ filePath, fileName, content });
        }
        if (artifactsCountBadge) {
          artifactsCountBadge.innerText = String(artifacts.length);
        }
      }
    }
  });

  // -- File & MCP handlers --
  broker.on('addReferencedFiles', (msg) => {
    msg.files.forEach(file => {
      if (!selectedFiles.find(f => f.filePath === file.filePath)) {
        selectedFiles.push(file);
      }
    });
    renderTags();
  });
  broker.on('mcpServersList', (msg) => {
    renderMcpServers(msg.servers, msg.error, msg.success);
  });

  // Handle messages from the extension host
  window.addEventListener('message', event => {
    broker.dispatch(event.data);
  });

  // Event listener for sending message
  sendBtn.addEventListener('click', sendMessage);
  if (rollbackBtn) {
    rollbackBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'rollback' });
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      isAgentActive = false;
      vscode.postMessage({ command: 'cancelAgent' });
      if (cancelBtn) cancelBtn.style.display = 'none';
      if (sendBtn) sendBtn.style.display = 'flex';
      chatInput.disabled = false;
      sendBtn.disabled = false;
      if (improvePromptBtn) improvePromptBtn.disabled = false;
      chatInput.focus();
    });
  }

  if (improvePromptBtn) {
    improvePromptBtn.addEventListener('click', () => {
      const draftPrompt = chatInput.value.trim();
      if (!draftPrompt) return;

      improvePromptBtn.disabled = true;
      improvePromptBtn.innerHTML = `
        <svg class="spinner" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="animation: spin 1s linear infinite;">
          <line x1="12" y1="2" x2="12" y2="6"></line>
          <line x1="12" y1="18" x2="12" y2="22"></line>
          <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line>
          <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line>
          <line x1="2" y1="12" x2="6" y2="12"></line>
          <line x1="18" y1="12" x2="22" y2="12"></line>
          <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line>
          <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line>
        </svg>
        <span>Improving...</span>
      `;
      chatInput.disabled = true;

      vscode.postMessage({
        command: 'improvePrompt',
        prompt: draftPrompt
      });
    });
  }

  if (attachFileBtn) {
    attachFileBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'openFilePicker' });
    });
  }

  // toggleChatSettingsBtn and chatSettingsPanel removed

  // History Drawer Controls
  historyBtn.addEventListener('click', () => {
    historyDrawer.classList.toggle('open');
    if (historyDrawer.classList.contains('open')) {
      vscode.postMessage({ command: 'loadChatSessions' });
    }
  });

  closeDrawerBtn.addEventListener('click', () => {
    historyDrawer.classList.remove('open');
  });

  newChatBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'newChat' });
    resetChatUI();
  });

  compactBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'compactSession' });
  });

  if (healthBtn && healthModal) {
    healthBtn.addEventListener('click', () => {
      healthModal.style.display = 'block';
      if (healthGrid) {
        healthGrid.innerHTML = '<div class="feature-empty">Checking workspace health...</div>';
      }
      vscode.postMessage({ command: 'requestWorkspaceHealth' });
    });
  }

  if (closeHealthModalBtn && healthModal) {
    closeHealthModalBtn.addEventListener('click', () => {
      healthModal.style.display = 'none';
    });
  }

  if (promptLibraryBtn && promptLibraryModal) {
    promptLibraryBtn.addEventListener('click', () => {
      renderPromptLibrary();
      promptLibraryModal.style.display = 'block';
    });
  }

  if (closePromptLibraryBtn && promptLibraryModal) {
    closePromptLibraryBtn.addEventListener('click', () => {
      promptLibraryModal.style.display = 'none';
    });
  }

  if (savePromptTemplateBtn) {
    savePromptTemplateBtn.addEventListener('click', () => {
      const name = promptTemplateName ? promptTemplateName.value.trim() : '';
      const body = promptTemplateBody ? promptTemplateBody.value.trim() : '';
      if (!name || !body) return;

      const templates = getPromptTemplates();
      const existingIndex = templates.findIndex(t => t.name.toLowerCase() === name.toLowerCase());
      const template = { id: `custom-${Date.now()}`, name, body, custom: true };
      if (existingIndex >= 0) {
        templates[existingIndex] = { ...templates[existingIndex], ...template };
      } else {
        templates.push(template);
      }
      savePromptTemplates(templates);
      promptTemplateName.value = '';
      promptTemplateBody.value = '';
      renderPromptLibrary();
    });
  }

  chatInput.addEventListener('keydown', e => {
    if (suggestMode) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedSuggestIndex = (selectedSuggestIndex + 1) % filteredSuggestions.length;
        renderSuggestions();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedSuggestIndex = (selectedSuggestIndex - 1 + filteredSuggestions.length) % filteredSuggestions.length;
        renderSuggestions();
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (filteredSuggestions[selectedSuggestIndex]) {
          selectSuggestion(filteredSuggestions[selectedSuggestIndex]);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeSuggestions();
      }
    } else {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    }
  });

  chatInput.addEventListener('input', e => {
    const text = chatInput.value;
    const caretPos = chatInput.selectionStart;
    
    // Check if user typed '@'
    const lastAtIdx = text.lastIndexOf('@', caretPos - 1);
    // Check if user typed '/'
    const lastSlashIdx = text.lastIndexOf('/', caretPos - 1);
    
    if (lastAtIdx !== -1 && (lastAtIdx === 0 || /\s/.test(text[lastAtIdx - 1]))) {
      const betweenText = text.substring(lastAtIdx + 1, caretPos);
      if (!/\s/.test(betweenText)) {
        suggestMode = true;
        suggestType = '@';
        suggestQuery = betweenText.toLowerCase();
        suggestStartIndex = lastAtIdx;
        updateSuggestions();
        return;
      }
    }
    
    if (lastSlashIdx !== -1 && (lastSlashIdx === 0 || /\s/.test(text[lastSlashIdx - 1]))) {
      const betweenText = text.substring(lastSlashIdx + 1, caretPos);
      if (!/\s/.test(betweenText)) {
        suggestMode = true;
        suggestType = '/';
        suggestQuery = betweenText.toLowerCase();
        suggestStartIndex = lastSlashIdx;
        updateSuggestions();
        return;
      }
    }
    
    closeSuggestions();
  });

  function fuzzyMatch(text, query) {
    let textIdx = 0;
    let queryIdx = 0;
    let score = 0;
    let consecutiveMatches = 0;
    
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    
    const index = lowerText.indexOf(lowerQuery);
    if (index !== -1) {
      score += 100 - index;
      return { matches: true, score };
    }
    
    while (textIdx < lowerText.length && queryIdx < lowerQuery.length) {
      if (lowerText[textIdx] === lowerQuery[queryIdx]) {
        queryIdx++;
        consecutiveMatches++;
        score += 10 + consecutiveMatches * 5;
      } else {
        consecutiveMatches = 0;
      }
      textIdx++;
    }
    
    return { matches: queryIdx === lowerQuery.length, score };
  }

  function updateSuggestions() {
    if (suggestType === '@') {
      const virtualTags = [
        { filePath: 'virtual:problems', relativePath: 'Workspace Problems (Diagnostics)', isVirtual: true },
        { filePath: 'virtual:git-diff', relativePath: 'Git Diff (Uncommitted Changes)', isVirtual: true },
        { filePath: 'virtual:workspace', relativePath: 'Workspace Outline Map', isVirtual: true }
      ];

      if (suggestQuery === '') {
        filteredSuggestions = [...virtualTags, ...workspaceFiles.slice(0, 8)];
      } else {
        const matches = [...virtualTags, ...workspaceFiles]
          .map(f => {
            const res = fuzzyMatch(f.relativePath, suggestQuery);
            return { file: f, score: res.score, matches: res.matches };
          })
          .filter(item => item.matches)
          .sort((a, b) => b.score - a.score)
          .map(item => item.file);
        
        filteredSuggestions = matches.slice(0, 10);
      }
    } else if (suggestType === '/') {
      const commands = [
        { name: '/explain', desc: 'Explain how the active code works' },
        { name: '/tests', desc: 'Generate unit tests for active file' },
        { name: '/fix', desc: 'Identify and fix bugs or linter issues' },
        { name: '/refactor', desc: 'Suggest design refactoring' },
        { name: '/document', desc: 'Add JSDoc documentation comments' },
        { name: '/help', desc: 'Show K-Horizon system help and commands' },
        { name: '/clear', desc: 'Clear chat history and reset session' }
      ];
      if (suggestQuery === '') {
        filteredSuggestions = commands;
      } else {
        filteredSuggestions = commands.filter(c => c.name.toLowerCase().includes('/' + suggestQuery));
      }
    }

    if (filteredSuggestions.length > 0) {
      selectedSuggestIndex = 0;
      renderSuggestions();
    } else {
      closeSuggestions();
    }
  }

  function renderSuggestions() {
    suggestList.innerHTML = '';
    suggestList.style.display = 'block';

    filteredSuggestions.forEach((item, index) => {
      const div = document.createElement('div');
      div.className = `suggest-item ${index === selectedSuggestIndex ? 'selected' : ''}`;
      
      if (suggestType === '@') {
        const fileName = item.isVirtual ? item.relativePath : item.relativePath.split('/').pop().split('\\').pop();
        const pathLabel = item.isVirtual ? 'Virtual Context Provider' : item.relativePath;
        const jsonSafeItem = encodeURIComponent(JSON.stringify(item));
        const pinBtn = item.isVirtual ? '' : `<button class="suggest-item-pin" title="Pin file" aria-label="Pin file" onclick="event.stopPropagation(); pinFile('${jsonSafeItem}')">Pin</button>`;
        div.innerHTML = `
          <span class="suggest-item-name" style="${item.isVirtual ? 'color: var(--vscode-editorGutter-modifiedBackground, #4fc1ff); font-weight: bold;' : ''}">${fileName}</span>
          <span class="suggest-item-path">${pathLabel}</span>
          ${pinBtn}
        `;
        div.addEventListener('click', () => selectSuggestion(item));
      } else if (suggestType === '/') {
        div.innerHTML = `
          <span class="suggest-item-name">${item.name}</span>
          <span class="suggest-item-path">${item.desc}</span>
        `;
        div.addEventListener('click', () => selectSuggestion(item));
      }

      suggestList.appendChild(div);
    });
  }

  function selectSuggestion(item) {
    if (suggestType === '@') {
      if (!selectedFiles.find(f => f.filePath === item.filePath)) {
        selectedFiles.push(item);
        renderTags();
      }
      const text = chatInput.value;
      const before = text.substring(0, suggestStartIndex);
      const after = text.substring(chatInput.selectionStart);
      chatInput.value = before + after;
    } else if (suggestType === '/') {
      const text = chatInput.value;
      const before = text.substring(0, suggestStartIndex);
      const after = text.substring(chatInput.selectionStart);
      chatInput.value = before + item.name + ' ' + after;
    }
    chatInput.focus();
    closeSuggestions();
  }

  function closeSuggestions() {
    suggestMode = false;
    suggestType = '';
    suggestList.style.display = 'none';
    filteredSuggestions = [];
  }

  function renderTags() {
    tagsContainer.innerHTML = '';
    selectedFiles.forEach(file => {
      const tag = document.createElement('div');
      tag.className = 'tag' + (file.isVirtual ? ' virtual' : '');
      const fileName = file.isVirtual ? file.relativePath : file.relativePath.split('/').pop().split('\\').pop();
      
      tag.innerHTML = `
        <span>${escapeHTML(fileName)}</span>
        <button type="button" class="tag-close" data-path="${escapeHTML(file.filePath)}" aria-label="Remove ${escapeHTML(fileName)}">x</button>
      `;
      
      tag.querySelector('.tag-close').addEventListener('click', e => {
        const path = e.target.getAttribute('data-path');
        selectedFiles = selectedFiles.filter(f => f.filePath !== path);
        renderTags();
      });

      tagsContainer.appendChild(tag);
    });
  }

  const defaultPromptTemplates = [
    {
      id: 'explain-active',
      name: 'Explain Active File',
      body: '/explain Focus on architecture, data flow, and risky edge cases.'
    },
    {
      id: 'generate-tests',
      name: 'Generate Tests',
      body: '/tests Add meaningful tests for the active file, including edge cases and failure paths.'
    },
    {
      id: 'security-review',
      name: 'Security Review',
      body: 'Review the selected code for security issues, unsafe data handling, injection risks, and missing validation. Recommend specific fixes.'
    },
    {
      id: 'refactor-plan',
      name: 'Refactor Plan',
      body: '/refactor Propose a small, safe refactor plan first, then show the exact code changes.'
    }
  ];

  function getPromptTemplates() {
    try {
      const saved = JSON.parse(localStorage.getItem('k-horizon-prompt-templates') || '[]');
      return [...defaultPromptTemplates, ...saved.filter(t => t && t.name && t.body)];
    } catch (e) {
      return defaultPromptTemplates;
    }
  }

  function savePromptTemplates(templates) {
    const customTemplates = templates.filter(t => t.custom);
    localStorage.setItem('k-horizon-prompt-templates', JSON.stringify(customTemplates));
  }

  function renderPromptLibrary() {
    if (!promptTemplateList) return;

    const templates = getPromptTemplates();
    promptTemplateList.innerHTML = '';
    templates.forEach(template => {
      const item = document.createElement('div');
      item.className = 'prompt-template-item';
      item.innerHTML = `
        <div>
          <div class="prompt-template-name">${escapeHTML(template.name)}</div>
          <div class="prompt-template-body">${escapeHTML(template.body)}</div>
        </div>
        <div class="prompt-template-actions">
          <button class="btn-sm" type="button" data-action="use">Use</button>
          ${template.custom ? '<button class="btn-sm reject" type="button" data-action="delete">Delete</button>' : ''}
        </div>
      `;

      item.querySelector('[data-action="use"]').addEventListener('click', () => {
        chatInput.value = template.body;
        chatInput.focus();
        chatInput.dispatchEvent(new Event('input'));
        promptLibraryModal.style.display = 'none';
      });

      const deleteBtn = item.querySelector('[data-action="delete"]');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
          const next = getPromptTemplates().filter(t => t.id !== template.id);
          savePromptTemplates(next);
          renderPromptLibrary();
        });
      }

      promptTemplateList.appendChild(item);
    });
  }

  function renderWorkspaceHealth(health) {
    if (!healthGrid || !health) return;

    const connectedMcp = (health.mcpServers || []).filter(s => s.status === 'Connected').length;
    const mcpLabel = `${connectedMcp}/${(health.mcpServers || []).length} connected`;
    const cards = [
      { label: 'Model', value: `${health.provider || 'Unknown'} / ${health.chatModel || 'Unset'}`, state: health.hasApiKey ? 'ok' : 'warn', note: health.hasApiKey ? 'Provider credentials look ready.' : 'API key may be missing.' },
      { label: 'Autocomplete', value: health.autocompleteEnabled ? 'Enabled' : 'Disabled', state: health.autocompleteEnabled ? 'ok' : 'neutral', note: 'Ghost-text completion toggle.' },
      { label: 'Workspace Files', value: String(health.workspaceFileCount || 0), state: 'neutral', note: 'Files available for context search.' },
      { label: 'Diagnostics', value: `${health.errorCount || 0} errors, ${health.warningCount || 0} warnings`, state: health.errorCount ? 'error' : (health.warningCount ? 'warn' : 'ok'), note: `${health.diagnosticCount || 0} total VS Code diagnostics.` },
      { label: 'RAG Database', value: health.hasSupabaseConnection ? 'Configured' : 'Missing', state: health.hasSupabaseConnection ? 'ok' : 'warn', note: 'Supabase connection for history and vector search.' },
      { label: 'Embeddings', value: health.hasEmbeddingKey ? 'Configured' : 'Missing', state: health.hasEmbeddingKey ? 'ok' : 'warn', note: 'aicredits.in key for semantic retrieval.' },
      { label: 'Git', value: health.gitAvailable ? 'Repository detected' : 'Not detected', state: health.gitAvailable ? 'ok' : 'neutral', note: 'Used for diff context and change awareness.' },
      { label: 'MCP Servers', value: mcpLabel, state: connectedMcp ? 'ok' : 'neutral', note: 'External tool connections available to the agent.' }
    ];

    healthGrid.innerHTML = cards.map(card => `
      <div class="health-card ${card.state}">
        <div class="health-card-top">
          <span>${escapeHTML(card.label)}</span>
          <span class="health-state-dot"></span>
        </div>
        <div class="health-card-value">${escapeHTML(card.value)}</div>
        <div class="health-card-note">${escapeHTML(card.note)}</div>
      </div>
    `).join('');
  }

  function sendMessage() {
    const text = chatInput.value.trim();
    if (!text && selectedFiles.length === 0) return;

    if (text.startsWith('/clear')) {
      vscode.postMessage({ command: 'newChat' });
      resetChatUI();
      return;
    }

    const userVisibleText = text;
    let promptToSend = text;

    if (text.startsWith('/explain')) {
      promptToSend = 'Please analyze the active code file and explain its functionality step-by-step. ' + text.substring(8).trim();
    } else if (text.startsWith('/tests')) {
      promptToSend = 'Please generate comprehensive unit tests for the active code file. ' + text.substring(6).trim();
    } else if (text.startsWith('/fix')) {
      promptToSend = 'Please review the active code selection, identify any potential bugs or security risks, and propose fixes. ' + text.substring(4).trim();
    } else if (text.startsWith('/refactor')) {
      promptToSend = 'Please refactor the following code to improve its design patterns, cleanliness, readability, and performance. Provide the complete refactored code. ' + text.substring(9).trim();
    } else if (text.startsWith('/document')) {
      promptToSend = 'Please add JSDoc comments or docstrings to the functions and classes in the following code. Do not change the implementation logic. ' + text.substring(9).trim();
    }

    // Estimate input tokens (chars / 4)
    const estimatedTokens = Math.ceil((userVisibleText.length + selectedFiles.reduce((acc, f) => acc + f.relativePath.length, 0)) / 4);

    // Append User Message to UI
    appendUserMessage(userVisibleText, selectedFiles, estimatedTokens);

    // Disable inputs and show stop button immediately
    chatInput.value = '';
    chatInput.style.height = 'auto'; // Reset auto-resize height
    chatInput.disabled = true;
    if (improvePromptBtn) improvePromptBtn.disabled = true;
    if (cancelBtn) cancelBtn.style.display = 'flex';
    if (sendBtn) sendBtn.style.display = 'none';

    // Send payload to extension backend
    vscode.postMessage({
      command: 'sendMessage',
      prompt: promptToSend,
      files: selectedFiles.map(f => f.filePath),
      pinnedFiles: pinnedFiles.map(f => f.filePath),
      useWorkspaceContext: workspaceCheckbox ? workspaceCheckbox.checked : false,
      autoApprove: autoApproveCheckbox ? autoApproveCheckbox.checked : true,
      role: roleSelector ? roleSelector.value : 'developer',
      autoCompile: autoCompileCheckbox ? autoCompileCheckbox.checked : false,
      autoTest: autoTestCheckbox ? autoTestCheckbox.checked : false,
      stepDebug: stepDebugCheckbox ? stepDebugCheckbox.checked : false,
      isSplitScreen: isSplitScreen,
      modelId2: modelSelector2 ? modelSelector2.value : null,
      provider2: modelSelector2 && modelSelector2.selectedIndex !== -1 ? modelSelector2.options[modelSelector2.selectedIndex].dataset.provider : null
    });

    selectedFiles = [];
    renderTags();
    closeSuggestions();
  }

  const USER_AVATAR = `
    <div class="avatar-header">
      <div class="avatar-icon">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
          <circle cx="12" cy="7" r="4"></circle>
        </svg>
      </div>
      <span class="avatar-name">USER</span>
    </div>
  `;

  const ASSISTANT_AVATAR = `
    <div class="avatar-header">
      <div class="avatar-icon" style="color: #ffffff;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2L14 10L22 12L14 14L12 22L10 14L2 12L10 10Z"></path>
        </svg>
      </div>
      <span class="avatar-name">K-HORIZON</span>
    </div>
  `;

  function extractReferencesFromContent(content) {
    if (!content) return [];
    const refs = [];
    const fileRegex = /File:\s+`([^`]+)`/g;
    const activeRegex = /Current Editor Active File\s+\(`([^`]+)`\):/g;
    const matchRegex = /in\s+`([^`]+)`\s+---/g;
    
    let match;
    while ((match = fileRegex.exec(content)) !== null) {
      if (!refs.includes(match[1])) refs.push(match[1]);
    }
    while ((match = activeRegex.exec(content)) !== null) {
      if (!refs.includes(match[1])) refs.push(match[1]);
    }
    while ((match = matchRegex.exec(content)) !== null) {
      if (!refs.includes(match[1])) refs.push(match[1]);
    }
    
    return refs.map(relativePath => ({
      filePath: relativePath,
      relativePath: relativePath
    }));
  }

  function renderFullHistory(history) {
    if (rollbackBtn) {
      rollbackBtn.style.display = history.length > 0 ? 'inline-flex' : 'none';
    }
    messagesDiv.innerHTML = '';
    messagesDiv.appendChild(agentLoader);
    agentLoader.style.display = 'none';
    if (history.length === 0) {
      appendSystemMessage("Start a new conversation thread!");
      return;
    }

    let lastUserReferences = [];
    history.forEach(m => {
      const { outputText } = extractOutputAndThinking(m.content);
      const estimatedTokens = Math.ceil(outputText.length / 4);
      if (m.role === 'user') {
        lastUserReferences = extractReferencesFromContent(m.content);
        // Strip RAG prefix context blocks from UI displays if any
        let cleanText = outputText;
        const ragIndex = outputText.indexOf('User Request:\n');
        if (ragIndex !== -1) {
          cleanText = outputText.substring(ragIndex + 13);
        }
        appendUserMessage(cleanText, [], estimatedTokens);
      } else if (m.role === 'assistant') {
        // Strip tool call XML from saved history before rendering
        const cleanOutput = stripToolCalls(outputText);
        appendAssistantMessage(cleanOutput, estimatedTokens, lastUserReferences);
        lastUserReferences = [];
      }
    });
    scrollToBottom();
  }

  function renderSessionsList(sessions) {
    historyList.innerHTML = '';
    if (sessions.length === 0) {
      historyList.innerHTML = '<div style="padding:8px; opacity:0.5; font-size:11px;">No past chats found.</div>';
      return;
    }

    sessions.forEach(session => {
      const div = document.createElement('div');
      div.className = `history-item ${session.active ? 'active' : ''}`;
      div.style.display = 'flex';
      div.style.justifyContent = 'space-between';
      div.style.alignItems = 'center';
      
      const titleSpan = document.createElement('span');
      titleSpan.innerText = session.title || 'Conversation Thread';
      titleSpan.title = session.title;
      titleSpan.style.flex = '1';
      titleSpan.style.overflow = 'hidden';
      titleSpan.style.textOverflow = 'ellipsis';
      titleSpan.style.whiteSpace = 'nowrap';
      
      div.appendChild(titleSpan);
      
      div.addEventListener('click', () => {
        activeSessionId = session.id;
        historyDrawer.classList.remove('open');
        vscode.postMessage({ command: 'switchSession', sessionId: session.id });
      });

      const delBtn = document.createElement('span');
      delBtn.innerText = '✕';
      delBtn.title = 'Delete Chat';
      delBtn.style.padding = '2px 6px';
      delBtn.style.fontSize = '10px';
      delBtn.style.cursor = 'pointer';
      delBtn.style.opacity = '0.5';
      delBtn.style.marginLeft = '8px';
      
      delBtn.addEventListener('mouseenter', () => delBtn.style.opacity = '1');
      delBtn.addEventListener('mouseleave', () => {
        delBtn.style.opacity = '0.5';
        // Reset confirm state on mouse leave
        if (delBtn.dataset.confirming === 'true') {
          delBtn.innerText = '✕';
          delBtn.style.color = '';
          delBtn.dataset.confirming = 'false';
        }
      });
      
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (delBtn.dataset.confirming === 'true') {
          // Second click = confirmed, send delete
          vscode.postMessage({ command: 'deleteSession', sessionId: session.id });
          delBtn.innerText = '...';
          delBtn.dataset.confirming = 'false';
        } else {
          // First click = show confirmation
          delBtn.innerText = 'Delete?';
          delBtn.style.color = '#f44336';
          delBtn.style.opacity = '1';
          delBtn.dataset.confirming = 'true';
          // Auto-reset after 3 seconds
          setTimeout(() => {
            if (delBtn.dataset.confirming === 'true') {
              delBtn.innerText = '✕';
              delBtn.style.color = '';
              delBtn.style.opacity = '0.5';
              delBtn.dataset.confirming = 'false';
            }
          }, 3000);
        }
      });
      
      div.appendChild(delBtn);
      historyList.appendChild(div);
    });
  }

  function showCompactedBanner() {
    compactBanner.style.display = 'flex';
    setTimeout(() => {
      compactBanner.style.display = 'none';
    }, 4000);
  }

  function appendUserMessage(text, files, tokens) {
    const div = document.createElement('div');
    div.className = 'message user';
    
    let html = USER_AVATAR;
    html += `<div class="message-content">${escapeHTML(text)}`;
    if (files.length > 0) {
      html += '<div style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap;">';
      files.forEach(f => {
        const name = f.relativePath.split('/').pop().split('\\').pop();
        html += `<span class="tag" style="pointer-events:none; font-size:10px;">@${name}</span>`;
      });
      html += '</div>';
    }
    html += '</div>';

    // Add Token count indicator
    html += `
      <div class="token-badge">
        <span>⚡ estimated: ${tokens} tokens</span>
      </div>
    `;

    div.innerHTML = html;
    messagesDiv.appendChild(div);
    scrollToBottom();
    updateTokenHUD();
  }

  function appendAssistantMessageStart() {
    const div = document.createElement('div');
    div.className = 'message assistant streaming';
    div.innerHTML = ASSISTANT_AVATAR + '<div class="message-content"></div>';
    messagesDiv.appendChild(div);
    currentStreamingBubble = div;
    scrollToBottom();
  }

  function appendAssistantToken(token) {
    if (token === null || token === undefined || token === 'null' || token === 'undefined') return;
    if (currentStreamingBubble) {
      currentStreamedRawText += token;
      const { thinkingText, outputText, isThinking } = extractOutputAndThinking(currentStreamedRawText);
      
      let html = renderThinkingHTML(thinkingText, isThinking);
      html += parseMarkdown(outputText);
      
      const contentDiv = currentStreamingBubble.querySelector('.message-content');
      if (contentDiv) {
        contentDiv.innerHTML = html;
      }
      scrollToBottom();
    }
  }

  function finalizeAssistantMessage() {
    if (currentStreamingBubble) {
      currentStreamingBubble.classList.remove('streaming');
      
      const { thinkingText, outputText } = extractOutputAndThinking(currentStreamedRawText);
      const estimatedTokens = Math.ceil(outputText.length / 4);

      // Render parsed markdown
      const contentDiv = currentStreamingBubble.querySelector('.message-content');
      if (contentDiv) {
        contentDiv.innerHTML = renderThinkingHTML(thinkingText, false) + parseMarkdown(outputText);
      }

      // Add Token count footer badge and feedback buttons
      const footerDiv = document.createElement('div');
      footerDiv.style.marginTop = '8px';
      footerDiv.innerHTML = `
        <div class="token-badge" style="border-top: 1px solid rgba(255,255,255,0.05); padding-top:4px;">
          <span>⚡ estimated: ${estimatedTokens} tokens</span>
        </div>
        <div class="feedback-container">
          <button class="feedback-btn" title="Helpful" onclick="toggleFeedback(this, 'like')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path>
            </svg>
          </button>
          <button class="feedback-btn" title="Not Helpful" onclick="toggleFeedback(this, 'dislike')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"></path>
            </svg>
          </button>
        </div>
      `;
      currentStreamingBubble.appendChild(footerDiv);
      currentStreamingBubble = null;
      scrollToBottom();
    }
    
    // Re-enable inputs
    chatInput.disabled = false;
    sendBtn.disabled = false;
    chatInput.focus();
  }

  function appendAssistantMessage(content, tokens, references) {
    const div = document.createElement('div');
    div.className = 'message assistant';
    
    div.innerHTML = ASSISTANT_AVATAR;
    
    if (references && references.length > 0) {
      setTimeout(() => {
        renderReferencesInBubble(div, references);
      }, 0);
    }

    const { thinkingText, outputText } = extractOutputAndThinking(content);
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.innerHTML = renderThinkingHTML(thinkingText, false) + parseMarkdown(outputText);
    div.appendChild(contentDiv);

    const footerDiv = document.createElement('div');
    footerDiv.style.marginTop = '8px';
    footerDiv.innerHTML = `
      <div class="token-badge" style="border-top: 1px solid rgba(255,255,255,0.05); padding-top:4px;">
        <span>⚡ estimated: ${tokens} tokens</span>
      </div>
      <div class="feedback-container">
        <button class="feedback-btn" title="Helpful" onclick="toggleFeedback(this, 'like')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path>
          </svg>
        </button>
        <button class="feedback-btn" title="Not Helpful" onclick="toggleFeedback(this, 'dislike')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"></path>
          </svg>
        </button>
      </div>
    `;
    div.appendChild(footerDiv);

    messagesDiv.appendChild(div);
    scrollToBottom();
    updateTokenHUD();
  }

  function appendSystemError(error) {
    const div = document.createElement('div');
    div.className = 'message assistant';
    div.innerHTML = `<span style="font-weight: 600; border: 1px solid var(--border-light); padding: 3px 8px; display: inline-block; margin: 2px 0; border-radius: 4px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">[[ ERROR: ${escapeHTML(error)} ]]</span>`;
    messagesDiv.appendChild(div);
    scrollToBottom();

    chatInput.disabled = false;
    sendBtn.disabled = false;
  }

  function appendSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'message assistant';
    div.style.opacity = '0.7';
    div.innerHTML = `<em style="display:inline-block; max-width:100%; padding:2px 0;">${escapeHTML(text)}</em>`;
    messagesDiv.appendChild(div);
    scrollToBottom();
  }

  function resetChatUI() {
    if (rollbackBtn) rollbackBtn.style.display = 'none';
    messagesDiv.innerHTML = '';
    messagesDiv.appendChild(agentLoader);
    agentLoader.style.display = 'none';

    chatInput.disabled = false;
    sendBtn.disabled = false;
    chatInput.value = '';
    chatInput.style.height = 'auto'; // Reset auto-resize height
    selectedFiles = [];
    pinnedFiles = [];
    renderPinnedFiles();
    renderTags();
    closeSuggestions();
    scrollToBottom();
  }

  function scrollToBottom() {
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }

  function escapeHTML(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Strips <tool_call>...</tool_call> XML blocks from text so they don't render
   * as raw code with Copy/Run/New File buttons in the chat UI.
   */
  function stripToolCalls(text) {
    if (!text) return '';
    // Remove complete tool_call blocks
    let cleaned = text.replace(/<tool_call\s+name=["'][^"']*["']\s*>[\s\S]*?<\/tool_call>/g, '');
    // Remove incomplete/partial tool_call blocks (still streaming)
    cleaned = cleaned.replace(/<tool_call\s+name=["'][^"']*["']\s*>[\s\S]*$/g, '');
    // Remove tool_result blocks
    cleaned = cleaned.replace(/<tool_result\s+name=["'][^"']*["']\s*>[\s\S]*?<\/tool_result>/g, '');
    // Clean up excessive blank lines left behind
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    return cleaned.trim();
  }

  // Custom Markdown to HTML regex parser with integrated Copy/Apply/Run/New File code block widgets
  function parseMarkdown(text) {
    let parsed = text;

    // Fenced Code blocks
    parsed = parsed.replace(/```([a-zA-Z0-9_\-+]*)\n([\s\S]*?)```/g, (match, lang, code) => {
      const codeLines = code.trim().split('\n');
      const lineCount = codeLines.length;
      const cleanCode = escapeHTML(code.trim());
      const jsonSafeCode = encodeURIComponent(code.trim());
      const cleanLang = (lang || 'code').trim();
      const isLong = lineCount > 10; // Collapse code blocks longer than 10 lines
      
      return `
        <div class="code-block-container ${isLong ? 'collapsible collapsed' : ''}">
          <div class="code-block-header">
            <span>${cleanLang} (${lineCount} lines)</span>
            <div class="code-block-actions">
              <button class="code-block-btn" onclick="copyCode(this, '${jsonSafeCode}')">Copy</button>
              <button class="code-block-btn" onclick="insertAtCursor('${jsonSafeCode}')">Insert</button>
              <button class="code-block-btn" onclick="applyCode('${jsonSafeCode}')">Apply</button>
              <button class="code-block-btn" onclick="runInTerminal('${jsonSafeCode}')">Run</button>
              <button class="code-block-btn" onclick="createNewFile('${jsonSafeCode}', '${cleanLang}')">New File</button>
            </div>
          </div>
          <div class="code-scroll-container">
            <pre><code class="language-${lang}">${cleanCode}</code></pre>
          </div>
          ${isLong ? `<div class="code-expand-overlay" onclick="toggleCodeBlock(this)"><span>▼ Expand Code (${lineCount} lines)</span></div>` : ''}
        </div>
      `;
    });

    // Inline code
    parsed = parsed.replace(/`([^`\n]+)`/g, '<code>$1</code>');

    // Bold
    parsed = parsed.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Line breaks
    parsed = parsed.replace(/\n/g, '<br/>');

    return parsed;
  }

  // Model selector change handler
  if (modelSelector) {
    modelSelector.addEventListener('change', () => {
      const selectedOption = modelSelector.options[modelSelector.selectedIndex];
      const modelId = selectedOption.value;
      const provider = selectedOption.dataset.provider;
      vscode.postMessage({
        command: 'updateActiveModel',
        modelId: modelId,
        provider: provider
      });
      updateCollapsibleSummaries();
    });
  }

  // Role selector change handler
  if (roleSelector) {
    roleSelector.addEventListener('change', () => {
      updateCollapsibleSummaries();
    });
  }

  function updateModelSelector(currentProvider, currentChatModel, customModels, vscodeLMModels) {
    if (!modelSelector) return;
    
    const defaultModels = [
      { provider: 'Gemini', name: 'Gemini 1.5 Flash', modelId: 'gemini-1.5-flash' },
      { provider: 'Gemini', name: 'Gemini 1.5 Pro', modelId: 'gemini-1.5-pro' },
      { provider: 'Ollama', name: 'gpt-oss:120b-cloud', modelId: 'gpt-oss:120b-cloud' },
      { provider: 'OpenAI', name: 'GPT-4o', modelId: 'gpt-4o' },
      { provider: 'OpenAI', name: 'GPT-4o Mini', modelId: 'gpt-4o-mini' },
      { provider: 'Anthropic', name: 'Claude 3.5 Sonnet', modelId: 'claude-3-5-sonnet' },
      { provider: 'OpenRouter', name: 'OpenRouter Llama 3', modelId: 'meta-llama/llama-3-8b-instruct:free' }
    ];

    // Append VS Code Language Models if available
    if (vscodeLMModels && Array.isArray(vscodeLMModels)) {
      vscodeLMModels.forEach(m => {
        if (!defaultModels.some(dm => dm.modelId === m.modelId)) {
          defaultModels.push({
            provider: 'Copilot',
            name: `Copilot: ${m.name}`,
            modelId: m.modelId
          });
        }
      });
    }

    // Default fallback Copilot options if none returned
    if (!defaultModels.some(dm => dm.provider === 'Copilot')) {
      defaultModels.push({ provider: 'Copilot', name: 'Copilot GPT-4o', modelId: 'gpt-4o' });
      defaultModels.push({ provider: 'Copilot', name: 'Copilot GPT-3.5 Turbo', modelId: 'gpt-3.5-turbo' });
    }

    // Append custom models
    if (customModels && Array.isArray(customModels)) {
      customModels.forEach(cm => {
        defaultModels.push({
          provider: cm.provider || 'OpenAI',
          name: `Custom: ${cm.name}`,
          modelId: cm.modelId
        });
      });
    }

    modelSelector.innerHTML = '';
    if (modelSelector2) modelSelector2.innerHTML = '';
    
    // Add default Custom model option if no custom model list matches
    if (currentProvider === 'Custom' && (!customModels || !customModels.some(cm => cm.modelId === currentChatModel))) {
      defaultModels.push({
        provider: 'Custom',
        name: `Custom Model: ${currentChatModel}`,
        modelId: currentChatModel
      });
    }

    defaultModels.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.modelId;
      opt.dataset.provider = m.provider;
      opt.innerText = m.name;
      if (m.modelId === currentChatModel) {
        opt.selected = true;
      }
      modelSelector.appendChild(opt);

      if (modelSelector2) {
        const opt2 = document.createElement('option');
        opt2.value = m.modelId;
        opt2.dataset.provider = m.provider;
        opt2.innerText = m.name;
        if (m.modelId === currentChatModel) {
          opt2.selected = true;
        }
        modelSelector2.appendChild(opt2);
      }
    });
    updateCollapsibleSummaries();
  }

  function extractOutputAndThinking(text) {
    if (!text) return { thinkingText: '', outputText: '', isThinking: false };
    let thinkingText = '';
    let outputText = '';
    const thinkStartIdx = text.indexOf('<think>');
    if (thinkStartIdx !== -1) {
      const thinkEndIdx = text.indexOf('</think>');
      if (thinkEndIdx !== -1) {
        thinkingText = text.substring(thinkStartIdx + 7, thinkEndIdx);
        outputText = text.substring(0, thinkStartIdx) + text.substring(thinkEndIdx + 8);
      } else {
        thinkingText = text.substring(thinkStartIdx + 7);
        outputText = text.substring(0, thinkStartIdx);
      }
    } else {
      outputText = text;
    }
    return {
      thinkingText: thinkingText.trim(),
      outputText: outputText,
      isThinking: thinkStartIdx !== -1 && text.indexOf('</think>') === -1
    };
  }

  function renderThinkingHTML(thinkingText, isThinking) {
    if (!thinkingText) return '';
    return `
      <div class="reasoning-box">
        <div class="reasoning-header" onclick="const content = this.nextElementSibling; content.style.display = content.style.display === 'none' ? 'block' : 'none';">
          <span>🧠 Reasoning Process</span>
          <span style="font-size: 10px; font-weight: normal;">${isThinking ? '⚡ (thinking...)' : '▼ Click to expand'}</span>
        </div>
        <div class="reasoning-content" style="display: ${isThinking ? 'block' : 'none'};">${escapeHTML(thinkingText)}</div>
      </div>
    `;
  }

  // Global functions exposed to inline onclick attributes
  window.copyCode = function(button, encodedCode) {
    const code = decodeURIComponent(encodedCode);
    navigator.clipboard.writeText(code).then(() => {
      const originalHtml = button.innerHTML;
      button.innerText = 'Copied!';
      setTimeout(() => button.innerHTML = originalHtml, 1500);
    });
  };

  window.applyCode = function(encodedCode) {
    const code = decodeURIComponent(encodedCode);
    vscode.postMessage({ command: 'applyCodeBlock', code });
  };

  window.runInTerminal = function(encodedCode) {
    const code = decodeURIComponent(encodedCode);
    vscode.postMessage({ command: 'insertTerminal', code });
  };

  window.createNewFile = function(encodedCode, language) {
    const code = decodeURIComponent(encodedCode);
    vscode.postMessage({ command: 'createNewFile', code, language });
  };

  window.submitQuickAction = function(cmd) {
    if (cmd) {
      chatInput.value = cmd;
      sendMessage();
    }
  };

  window.toggleFeedback = function(button, type) {
    const wasActive = button.classList.contains('active');
    const container = button.closest('.feedback-container');
    if (container) {
      container.querySelectorAll('.feedback-btn').forEach(btn => btn.classList.remove('active'));
    }
    if (!wasActive) {
      button.classList.add('active');
    }
  };

  window.openReference = function(encodedPath) {
    const filePath = decodeURIComponent(encodedPath);
    vscode.postMessage({ command: 'openFile', filePath });
  };

  function renderReferencesInBubble(bubble, references) {
    if (!references || references.length === 0) return;
    if (bubble.querySelector('.context-accordion')) return;

    const accordion = document.createElement('div');
    accordion.className = 'context-accordion';

    let refListHtml = '';
    references.forEach(ref => {
      const name = ref.relativePath.split('/').pop().split('\\').pop();
      refListHtml += `
        <li class="context-ref-item" onclick="openReference('${encodeURIComponent(ref.filePath)}')">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right: 4px;">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
          <span class="context-ref-name">${escapeHTML(name)}</span>
          <span class="context-ref-path">${escapeHTML(ref.relativePath)}</span>
        </li>
      `;
    });

    accordion.innerHTML = `
      <details>
        <summary>
          <span class="accordion-arrow">▶</span>
          <span>Used ${references.length} reference${references.length > 1 ? 's' : ''}</span>
        </summary>
        <ul>
          ${refListHtml}
        </ul>
      </details>
    `;

    const avatarHeader = bubble.querySelector('.avatar-header');
    if (avatarHeader) {
      avatarHeader.insertAdjacentElement('afterend', accordion);
    } else {
      bubble.insertBefore(accordion, bubble.firstChild);
    }
  }

  function appendToolCard(toolCallId, name, args, needsApproval, isStepMode) {
    // Finalize current streaming bubble before showing tool card
    if (currentStreamingBubble) {
      finalizeAssistantMessageSplit('left');
    }

    const div = document.createElement('div');
    div.className = 'tool-card';
    div.id = `tool-card-${toolCallId}`;

    // Pick appropriate icon for tool type
    const toolIcons = {
      'write_file': '📝', 'edit_file': '✏️', 'read_file': '📖',
      'delete_file': '🗑️', 'list_dir': '📂', 'run_command': '▶️',
      'grep_search': '🔍', 'web_search': '🌐', 'fetch_webpage': '🌍'
    };
    const icon = toolIcons[name] || '⚙️';

    // Build compact args display — for file ops show path prominently
    let argsDisplay = '';
    if ((name === 'write_file' || name === 'edit_file' || name === 'read_file' || name === 'delete_file') && args.file_path) {
      const fileName = args.file_path.split('/').pop().split('\\').pop();
      argsDisplay = `<div style="display:flex; align-items:center; gap:6px; margin-bottom:4px; flex-wrap:wrap;">
        <span style="font-size:11px; font-weight:600; color:var(--vscode-textLink-foreground, #3794ff);">${escapeHTML(fileName)}</span>
        <span style="font-size:9px; opacity:0.6;">${escapeHTML(args.file_path)}</span>
      </div>`;
      // For write_file, don't dump the full content — just show line count
      if (name === 'write_file' && args.content) {
        const lineCount = args.content.split('\n').length;
        argsDisplay += `<span style="font-size:10px; opacity:0.7;">Writing ${lineCount} lines</span>`;
      } else if (name === 'edit_file' && args.target_content) {
        argsDisplay += `<span style="font-size:10px; opacity:0.7;">Replacing ${args.target_content.split('\n').length} lines → ${(args.replacement_content || '').split('\n').length} lines</span>`;
      }
    } else if (name === 'run_command' && args.command) {
      argsDisplay = `<code style="font-size:10px; padding:2px 6px; background:rgba(255,255,255,0.05); border-radius:3px; display:inline-block; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHTML(args.command)}</code>`;
    } else if (name === 'grep_search' && args.query) {
      argsDisplay = `<span style="font-size:10px;">Search: <code>${escapeHTML(args.query)}</code></span>`;
    } else {
      const argsString = JSON.stringify(args, null, 2);
      argsDisplay = `
        <details class="tool-mini-details">
          <summary>Show args</summary>
          <pre class="tool-args-pre">${escapeHTML(argsString)}</pre>
        </details>
      `;
    }
    
    activeToolCalls.set(toolCallId, { name, args });
    
    let diffBtn = '';
    if (needsApproval && !isStepMode && (name === 'write_file' || name === 'edit_file')) {
      diffBtn = `<button class="tool-diff-btn" onclick="viewSidebarDiff('${toolCallId}')" style="background:var(--vscode-button-secondaryBackground, #3a3d41); color:var(--vscode-button-secondaryForeground, #ffffff); border:1px solid var(--vscode-button-border, transparent); margin-right: 6px; padding: 4px 10px; border-radius: 2px; cursor: pointer; font-size: 11px;">View Diff</button>`;
    }

    div.innerHTML = `
      <div class="tool-card-header">
        <div class="tool-card-header-left">
          <span class="tool-icon">${icon}</span>
          <span class="tool-title">${escapeHTML(name)}</span>
        </div>
        <span class="tool-status-badge ${needsApproval ? 'pending' : 'running'}">${needsApproval ? 'pending approval' : 'running'}</span>
      </div>
      <div class="tool-card-body">
        ${argsDisplay}
      </div>
      ${needsApproval ? (isStepMode ? renderStepDebugForm(toolCallId, name, args) : `
        <div class="tool-card-actions" id="actions-${toolCallId}">
          ${diffBtn}
          <button class="tool-approve-btn" onclick="respondToToolApproval('${toolCallId}', true)">Approve</button>
          <button class="tool-reject-btn" onclick="respondToToolApproval('${toolCallId}', false)">Reject</button>
        </div>
      `) : ''}
    `;

    messagesDiv.appendChild(div);
    scrollToBottom();
  }

  window.respondToToolApproval = function(toolCallId, approved) {
    const actionsDiv = document.getElementById(`actions-${toolCallId}`);
    const card = document.getElementById(`tool-card-${toolCallId}`);
    if (actionsDiv) {
      actionsDiv.style.display = 'none';
    }
    if (card) {
      const badge = card.querySelector('.tool-status-badge');
      if (badge) {
        if (approved) {
          badge.className = 'tool-status-badge running';
          badge.innerText = 'running';
        } else {
          badge.className = 'tool-status-badge error';
          badge.innerText = 'rejected';
        }
      }
    }
    vscode.postMessage({
      command: 'toolApprovalResponse',
      toolCallId: toolCallId,
      approved: approved
    });
  };

  function updateToolCardResult(toolCallId, toolName, result, error) {
    const card = document.getElementById(`tool-card-${toolCallId}`);
    if (!card) return;

    const badge = card.querySelector('.tool-status-badge');
    const displayResult = error || result || 'Success.';
    const resultIsError = !!error || /^Error[:\s]/i.test(displayResult) || /\[COMMAND FAILED\]/i.test(displayResult);
    if (badge) {
      if (resultIsError) {
        badge.className = 'tool-status-badge error';
        badge.innerText = 'error';
      } else {
        badge.className = 'tool-status-badge success';
        badge.innerText = 'success';
      }
    }

    const resDiv = document.createElement('div');
    resDiv.className = 'tool-result-container';
    
    const isDiff = displayResult.includes('[DIFF]');
    const isFileSuccess = !resultIsError && (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'delete_file');
    let detailsHTML = '';
    
    if (isDiff) {
      const pathParts = displayResult.split('[DIFF_PATHS]');
      const hasPaths = pathParts.length > 1;
      const mainContent = pathParts[0].trim();
      
      const diffParts = mainContent.split('[DIFF]');
      const diffText = diffParts[1] ? diffParts[1].trim() : '';
      
      let originalPath = '';
      let proposedPath = '';
      if (hasPaths) {
        const paths = pathParts[1].trim().split('|');
        originalPath = paths[0];
        proposedPath = paths[1];
      }
      
      detailsHTML = `
        <div class="diff-card">
          <div class="diff-card-header">
            <span>Inline File Changes</span>
            ${hasPaths ? `<button class="code-block-btn" onclick="viewSideBySideDiff('${encodeURIComponent(originalPath)}', '${encodeURIComponent(proposedPath)}')">View Diff</button>` : '<span>diff</span>'}
          </div>
          <pre class="diff-card-pre">${formatDiffHTML(diffText)}</pre>
        </div>
      `;
    } else if (isFileSuccess) {
      // Extract file path from result for clickable "Open File" link
      const filePathMatch = displayResult.match(/(?:Wrote to|Edited|Deleted) file:\s*(.+)/i);
      const filePath = filePathMatch ? filePathMatch[1].trim() : '';
      detailsHTML = `
        <div style="display:flex; align-items:center; gap:8px; padding:4px 0; font-size:10px;">
          <span style="color: var(--vscode-testing-iconPassed, #73c991);">✓ ${escapeHTML(displayResult.split('\n')[0])}</span>
          ${filePath ? `<button class="code-block-btn" onclick="openReference('${encodeURIComponent(filePath)}')">Open File</button>` : ''}
        </div>
      `;
    } else {
      const preview = displayResult.length > 120 ? `${displayResult.slice(0, 120)}…` : displayResult;
      detailsHTML = `
        <details class="tool-result-details" ${resultIsError ? 'open' : ''}>
          <summary style="font-size:10px; cursor:pointer;">${escapeHTML(resultIsError ? 'Error output' : preview)}</summary>
          <pre class="tool-result-pre">${escapeHTML(displayResult)}</pre>
        </details>
      `;
    }
    
    resDiv.innerHTML = detailsHTML;
    card.appendChild(resDiv);
    
    scrollToBottom();
  }

  window.viewSideBySideDiff = function(encodedOriginal, encodedProposed) {
    const originalPath = decodeURIComponent(encodedOriginal);
    const proposedPath = decodeURIComponent(encodedProposed);
    vscode.postMessage({
      command: 'viewSideBySideDiff',
      originalPath: originalPath,
      proposedPath: proposedPath
    });
  };

  function formatDiffHTML(diffText) {
    const lines = diffText.split('\n');
    let html = '';
    lines.forEach(line => {
      if (line.startsWith('- ')) {
        html += `<span class="diff-line removed">${escapeHTML(line)}</span>`;
      } else if (line.startsWith('+ ')) {
        html += `<span class="diff-line added">${escapeHTML(line)}</span>`;
      } else {
        html += `<span class="diff-line normal">${escapeHTML(line)}</span>`;
      }
    });
    return html;
  }

  window.toggleCodeBlock = function(overlay) {
    const container = overlay.closest('.code-block-container');
    if (container) {
      const isCollapsed = container.classList.contains('collapsed');
      if (isCollapsed) {
        container.classList.remove('collapsed');
        overlay.innerHTML = '<span>▲ Collapse Code</span>';
        overlay.style.position = 'relative';
        overlay.style.background = 'none';
        overlay.style.height = 'auto';
        overlay.style.padding = '4px 0';
      } else {
        container.classList.add('collapsed');
        const linesMatch = container.querySelector('.code-block-header span').innerText.match(/\d+/);
        const lines = linesMatch ? linesMatch[0] : '';
        overlay.innerHTML = `<span>▼ Expand Code ${lines ? `(${lines} lines)` : ''}</span>`;
        overlay.style.position = 'absolute';
        overlay.style.background = 'linear-gradient(rgba(11, 11, 11, 0), rgba(11, 11, 11, 0.95))';
        overlay.style.height = '40px';
        overlay.style.paddingBottom = '8px';
      }
    }
  };

  // --- NEW FEATURES IMPLEMENTATION ---

  // 1. Context Pinning State & Logic
  let pinnedFiles = [];
  
  function renderPinnedFiles() {
    const pinnedContainer = document.getElementById('pinnedContainer');
    const pinnedList = document.getElementById('pinnedList');
    if (!pinnedContainer || !pinnedList) return;
    
    if (pinnedFiles.length === 0) {
      pinnedContainer.style.display = 'none';
      pinnedList.innerHTML = '';
      return;
    }
    
    pinnedContainer.style.display = 'flex';
    pinnedList.innerHTML = '';
    
    pinnedFiles.forEach(file => {
      const name = file.relativePath.split('/').pop().split('\\').pop();
      const tag = document.createElement('span');
      tag.className = 'pinned-tag';
      tag.innerHTML = `
        <span>${escapeHTML(name)}</span>
        <span class="pinned-tag-close" onclick="unpinFile('${encodeURIComponent(file.filePath)}')">✕</span>
      `;
      pinnedList.appendChild(tag);
    });
  }
  
  window.pinFile = function(encodedItem) {
    const item = JSON.parse(decodeURIComponent(encodedItem));
    if (!pinnedFiles.find(f => f.filePath === item.filePath)) {
      pinnedFiles.push(item);
      renderPinnedFiles();
    }
    closeSuggestions();
  };
  
  window.unpinFile = function(filePath) {
    const targetPath = decodeURIComponent(filePath);
    pinnedFiles = pinnedFiles.filter(f => f.filePath !== targetPath);
    renderPinnedFiles();
  };

  // 2. Split Screen & Dual Streaming
  const splitBtn = document.getElementById('splitBtn');
  const modelSelector2 = document.getElementById('modelSelector2');

  if (splitBtn) {
    splitBtn.addEventListener('click', () => {
      isSplitScreen = !isSplitScreen;
      const panel = document.querySelector('.panel');
      if (isSplitScreen) {
        panel.classList.add('split-active');
        splitBtn.classList.add('active');
        if (modelSelector2) modelSelector2.style.display = 'block';
        
        // Split messagesDiv into left/right columns
        const originalContent = messagesDiv.innerHTML;
        messagesDiv.innerHTML = `
          <div class="messages-split-wrapper">
            <div class="messages-split-column" id="messagesLeftCol">
              <div class="messages-split-column-title">Model 1 (Active)</div>
              <div class="split-messages-container" id="messagesLeft" style="display: flex; flex-direction: column; gap: 16px;"></div>
            </div>
            <div class="messages-split-column" id="messagesRightCol">
              <div class="messages-split-column-title">Model 2 (Compare)</div>
              <div class="split-messages-container" id="messagesRight" style="display: flex; flex-direction: column; gap: 16px;"></div>
            </div>
          </div>
        `;
        const leftMessages = document.getElementById('messagesLeft');
        if (leftMessages) leftMessages.innerHTML = originalContent;
      } else {
        panel.classList.remove('split-active');
        splitBtn.classList.remove('active');
        if (modelSelector2) modelSelector2.style.display = 'none';
        
        const leftMessages = document.getElementById('messagesLeft');
        const content = leftMessages ? leftMessages.innerHTML : '';
        messagesDiv.innerHTML = content;
      }
      scrollToBottom();
    });
  }

  function getMessageContainer(column) {
    if (isSplitScreen) {
      if (column === 'right') {
        return document.getElementById('messagesRight');
      } else {
        return document.getElementById('messagesLeft');
      }
    }
    return messagesDiv;
  }

  function appendAssistantMessageStartSplit(column) {
    const container = getMessageContainer(column);
    if (!container) return;
    const div = document.createElement('div');
    div.className = `message assistant streaming ${column === 'right' ? 'right-stream' : 'left-stream'}`;
    div.innerHTML = ASSISTANT_AVATAR + '<div class="message-content"></div>';
    container.appendChild(div);
    if (column === 'right') {
      currentStreamingBubble2 = div;
    } else {
      currentStreamingBubble = div;
    }
    scrollToBottom();
  }

  function appendAssistantTokenSplit(token, column) {
    let bubble = column === 'right' ? currentStreamingBubble2 : currentStreamingBubble;
    
    // Auto-create a new bubble if none exists (e.g., after tool cards finished)
    if (!bubble) {
      // Reset accumulated text for a fresh bubble
      if (column === 'right') {
        currentStreamedRawText2 = '';
      } else {
        currentStreamedRawText = '';
      }
      appendAssistantMessageStartSplit(column);
      bubble = column === 'right' ? currentStreamingBubble2 : currentStreamingBubble;
    }
    
    if (bubble) {
      if (column === 'right') {
        currentStreamedRawText2 += token;
      } else {
        currentStreamedRawText += token;
      }
      const rawText = column === 'right' ? currentStreamedRawText2 : currentStreamedRawText;
      const { thinkingText, outputText, isThinking } = extractOutputAndThinking(rawText);
      
      // Strip tool call XML before rendering so raw code doesn't show with Copy/Run buttons
      const cleanOutput = stripToolCalls(outputText);
      
      let html = renderThinkingHTML(thinkingText, isThinking);
      html += parseMarkdown(cleanOutput);
      
      const contentDiv = bubble.querySelector('.message-content');
      if (contentDiv) {
        contentDiv.innerHTML = html;
      }
      scrollToBottom();
    }
  }

  function finalizeAssistantMessageSplit(column) {
    const bubble = column === 'right' ? currentStreamingBubble2 : currentStreamingBubble;
    if (bubble) {
      bubble.classList.remove('streaming');
      const rawText = column === 'right' ? currentStreamedRawText2 : currentStreamedRawText;
      const { thinkingText, outputText } = extractOutputAndThinking(rawText);
      // Strip tool call XML from final rendered output
      const cleanOutput = stripToolCalls(outputText);
      const estimatedTokens = Math.ceil(cleanOutput.length / 4);

      const contentDiv = bubble.querySelector('.message-content');
      if (contentDiv) {
        contentDiv.innerHTML = renderThinkingHTML(thinkingText, false) + parseMarkdown(cleanOutput);
      }

      // Only add footer if there's actual content to show
      if (cleanOutput.trim().length > 0) {
        const footerDiv = document.createElement('div');
        footerDiv.style.marginTop = '8px';
        footerDiv.innerHTML = `
          <div class="token-badge" style="border-top: 1px solid rgba(255,255,255,0.05); padding-top:4px;">
            <span>⚡ estimated: ${estimatedTokens} tokens</span>
          </div>
        `;
        bubble.appendChild(footerDiv);
      } else {
        // If the entire bubble was just tool calls with no text, remove the empty bubble
        bubble.remove();
      }
      
      if (column === 'right') {
        currentStreamingBubble2 = null;
      } else {
        currentStreamingBubble = null;
      }
      scrollToBottom();
      updateTokenHUD();
    }
    
    if (!currentStreamingBubble && !currentStreamingBubble2) {
      if (!isAgentActive) {
        agentLoader.style.display = 'none';
        chatInput.disabled = false;
        sendBtn.disabled = false;
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (sendBtn) sendBtn.style.display = 'flex';
        chatInput.focus();
      } else {
        agentLoader.style.display = 'flex';
        messagesDiv.appendChild(agentLoader); // Ensure loader is at the bottom
        scrollToBottom();
      }
    }
  }

  // 3. Interactive Step Debugger UI
  function renderStepDebugForm(toolCallId, name, args) {
    let inputsHtml = '';
    Object.keys(args).forEach(key => {
      const val = args[key] || '';
      inputsHtml += `
        <div class="step-debug-param">
          <label style="color: var(--vscode-editorGutter-modifiedBackground);">${escapeHTML(key)}</label>
          <textarea id="param-${toolCallId}-${key}" rows="${val.split('\n').length > 3 ? 6 : 2}">${escapeHTML(val)}</textarea>
        </div>
      `;
    });
    
    return `
      <div class="step-debug-card" id="step-debug-${toolCallId}">
        <span style="font-weight: bold; font-size: 10px; color: var(--vscode-charts-orange);">🔧 Step Debug Mode Active</span>
        ${inputsHtml}
        
        <div id="mock-section-${toolCallId}" style="display:none; flex-direction:column; gap:4px; margin-top:4px;">
          <label style="font-size: 9px; font-weight: bold; opacity:0.8;">Mocked Output to Send back to Model:</label>
          <textarea id="mock-value-${toolCallId}" rows="3" placeholder="e.g. Success: Mocked tool output."></textarea>
        </div>

        <div class="tool-card-actions" style="margin-top: 6px; display: flex; gap: 4px;">
          <button class="tool-approve-btn" style="flex: 1;" onclick="submitStepDebug('${toolCallId}', '${name}', 'run')">Execute</button>
          <button class="tool-reject-btn" style="flex: 1;" onclick="submitStepDebug('${toolCallId}', '${name}', 'skip')">Skip</button>
          <button class="tool-approve-btn" style="background: var(--vscode-charts-purple, #8b5cf6); border-color: var(--vscode-charts-purple, #8b5cf6); color: white; flex: 1;" onclick="toggleMockSection('${toolCallId}')" id="mock-btn-${toolCallId}">Mock</button>
        </div>
      </div>
    `;
  }

  window.toggleMockSection = function(toolCallId) {
    const section = document.getElementById(`mock-section-${toolCallId}`);
    const btn = document.getElementById(`mock-btn-${toolCallId}`);
    if (section) {
      if (section.style.display === 'none') {
        section.style.display = 'flex';
        btn.innerText = 'Send Mock';
      } else {
        submitStepDebug(toolCallId, '', 'mock');
      }
    }
  };

  window.submitStepDebug = function(toolCallId, name, action) {
    const card = document.getElementById(`tool-card-${toolCallId}`);
    if (card) {
      const actions = card.querySelector('.tool-card-actions');
      if (actions) actions.style.display = 'none';
      const debugCard = document.getElementById(`step-debug-${toolCallId}`);
      if (debugCard) debugCard.style.opacity = '0.6';
    }
    
    if (action === 'run') {
      const textareas = document.querySelectorAll(`[id^="param-${toolCallId}-"]`);
      const editedArgs = {};
      textareas.forEach(ta => {
        const key = ta.id.substring(`param-${toolCallId}-`.length);
        editedArgs[key] = ta.value;
      });
      
      vscode.postMessage({
        command: 'toolApprovalResponse',
        toolCallId: toolCallId,
        approved: true,
        arguments: editedArgs
      });
    } else if (action === 'skip') {
      vscode.postMessage({
        command: 'toolApprovalResponse',
        toolCallId: toolCallId,
        approved: false,
        skipped: true
      });
    } else if (action === 'mock') {
      const mockTa = document.getElementById(`mock-value-${toolCallId}`);
      const mockValue = mockTa ? mockTa.value : 'Success: Mocked output.';
      vscode.postMessage({
        command: 'toolApprovalResponse',
        toolCallId: toolCallId,
        approved: false,
        mocked: true,
        mockValue: mockValue
      });
    }
  };

  // 4. Custom Roles Profiles CRUD modal
  let agentProfiles = [];
  const manageProfilesBtn = document.getElementById('manageProfilesBtn');
  const profilesModal = document.getElementById('profilesModal');
  const closeModalBtn = document.getElementById('closeModalBtn');
  const addNewProfileBtn = document.getElementById('addNewProfileBtn');
  const profileForm = document.getElementById('profileForm');
  const modalProfilesList = document.getElementById('modalProfilesList');
  const saveProfileBtn = document.getElementById('saveProfileBtn');
  const deleteProfileBtn = document.getElementById('deleteProfileBtn');
  
  const profileKeyInput = document.getElementById('profileKey');
  const profileNameInput = document.getElementById('profileName');
  const profilePromptInput = document.getElementById('profilePrompt');
  const profileModelSelect = document.getElementById('profileModel');
  const profileTempInput = document.getElementById('profileTemp');
  const editProfileIndexInput = document.getElementById('editProfileIndex');

  if (manageProfilesBtn && profilesModal) {
    manageProfilesBtn.addEventListener('click', () => {
      profilesModal.style.display = 'block';
      populateProfileModelSelect();
      renderModalProfilesList();
      if (profileForm) profileForm.style.display = 'none';
    });
  }
  
  if (closeModalBtn && profilesModal) {
    closeModalBtn.addEventListener('click', () => {
      profilesModal.style.display = 'none';
    });
  }

  function populateProfileModelSelect() {
    if (!profileModelSelect || !modelSelector) return;
    profileModelSelect.innerHTML = '<option value="">(Use default model)</option>';
    Array.from(modelSelector.options).forEach(opt => {
      const copy = document.createElement('option');
      copy.value = opt.value;
      copy.innerText = opt.innerText;
      profileModelSelect.appendChild(copy);
    });
  }

  function renderModalProfilesList() {
    if (!modalProfilesList) return;
    modalProfilesList.innerHTML = '';
    
    if (agentProfiles.length === 0) {
      modalProfilesList.innerHTML = '<div class="modal-empty">No custom roles.</div>';
      return;
    }
    
    agentProfiles.forEach((p, idx) => {
      const item = document.createElement('div');
      item.className = 'modal-list-item';
      item.innerHTML = `
        <span>${escapeHTML(p.name)} (${escapeHTML(p.key)})</span>
        <button class="icon-btn" onclick="editProfile(${idx})" title="Edit role" aria-label="Edit role">Edit</button>
      `;
      modalProfilesList.appendChild(item);
    });
  }

  window.editProfile = function(idx) {
    const p = agentProfiles[idx];
    if (!p) return;
    
    if (profileForm) profileForm.style.display = 'flex';
    editProfileIndexInput.value = idx.toString();
    profileKeyInput.value = p.key;
    profileKeyInput.disabled = true;
    profileNameInput.value = p.name;
    profilePromptInput.value = p.systemPrompt;
    profileModelSelect.value = p.modelId || '';
    profileTempInput.value = p.temperature !== undefined ? p.temperature : '';
    
    if (deleteProfileBtn) deleteProfileBtn.style.display = 'block';
    document.getElementById('formTitle').innerText = 'Edit Custom Role';
  };
  
  if (addNewProfileBtn) {
    addNewProfileBtn.addEventListener('click', () => {
      if (profileForm) profileForm.style.display = 'flex';
      editProfileIndexInput.value = '-1';
      profileKeyInput.value = '';
      profileKeyInput.disabled = false;
      profileNameInput.value = '';
      profilePromptInput.value = '';
      profileModelSelect.value = '';
      profileTempInput.value = '';
      
      if (deleteProfileBtn) deleteProfileBtn.style.display = 'none';
      document.getElementById('formTitle').innerText = 'Create Custom Role';
    });
  }

  if (saveProfileBtn) {
    saveProfileBtn.addEventListener('click', () => {
      const idx = parseInt(editProfileIndexInput.value);
      const key = profileKeyInput.value.trim().toLowerCase();
      const name = profileNameInput.value.trim();
      const systemPrompt = profilePromptInput.value.trim();
      const modelId = profileModelSelect.value;
      const temperature = profileTempInput.value ? parseFloat(profileTempInput.value) : undefined;
      
      if (!key || !name || !systemPrompt) {
        // alert() doesn't work in webviews, silently reject
        return;
      }
      
      if (['developer', 'security', 'tester', 'refactorer'].includes(key)) {
        return;
      }
      
      const newProfile = { key, name, systemPrompt, modelId, temperature };
      
      if (idx === -1) {
        if (agentProfiles.some(p => p.key === key)) {
          return;
        }
        agentProfiles.push(newProfile);
      } else {
        agentProfiles[idx] = newProfile;
      }
      
      vscode.postMessage({
        command: 'saveAgentProfiles',
        profiles: agentProfiles
      });
      
      updateRoleSelector();
      renderModalProfilesList();
      if (profileForm) profileForm.style.display = 'none';
    });
  }
  
  if (deleteProfileBtn) {
    deleteProfileBtn.addEventListener('click', () => {
      const idx = parseInt(editProfileIndexInput.value);
      if (idx >= 0 && idx < agentProfiles.length) {
        agentProfiles.splice(idx, 1);
        vscode.postMessage({
          command: 'saveAgentProfiles',
          profiles: agentProfiles
        });
        updateRoleSelector();
        renderModalProfilesList();
        if (profileForm) profileForm.style.display = 'none';
      }
    });
  }

  function updateRoleSelector() {
    if (!roleSelector) return;
    roleSelector.innerHTML = `
      <option value="developer">Developer</option>
      <option value="security">Security</option>
      <option value="tester">Tester</option>
      <option value="refactorer">Refactor</option>
    `;
    
    agentProfiles.forEach(p => {
      if (!['developer', 'security', 'tester', 'refactorer'].includes(p.key)) {
        const opt = document.createElement('option');
        opt.value = p.key;
        opt.innerText = p.name;
        roleSelector.appendChild(opt);
      }
    });
    updateCollapsibleSummaries();
  }

  // --- MCP Setup ---
  const mcpSettingsBtn = document.getElementById('mcpSettingsBtn');
  const mcpModal = document.getElementById('mcpModal');
  const closeMcpModalBtn = document.getElementById('closeMcpModalBtn');
  const mcpServersList = document.getElementById('mcpServersList');
  const mcpNameInput = document.getElementById('mcpName');
  const mcpCommandInput = document.getElementById('mcpCommand');
  const mcpArgsInput = document.getElementById('mcpArgs');
  const saveMcpBtn = document.getElementById('saveMcpBtn');
  const mcpPreset = document.getElementById('mcpPreset');
  const mcpEnvInput = document.getElementById('mcpEnv');

  if (mcpPreset) {
    mcpPreset.addEventListener('change', () => {
      const val = mcpPreset.value;
      if (val === 'stitch') {
        mcpNameInput.value = 'stitch-server';
        mcpCommandInput.value = 'npx';
        mcpArgsInput.value = '["-y", "@_davideast/stitch-mcp"]';
        mcpEnvInput.value = '{\n  "GOOGLE_API_KEY": "YOUR_API_KEY_HERE",\n  "STITCH_PROJECT_ID": "YOUR_PROJECT_ID_HERE"\n}';
      } else if (val === 'playwright') {
        mcpNameInput.value = 'playwright-server';
        mcpCommandInput.value = 'npx';
        mcpArgsInput.value = '["-y", "@modelcontextprotocol/server-playwright"]';
        mcpEnvInput.value = '';
      } else if (val === 'github') {
        mcpNameInput.value = 'github-server';
        mcpCommandInput.value = 'npx';
        mcpArgsInput.value = '["-y", "@modelcontextprotocol/server-github"]';
        mcpEnvInput.value = '{\n  "GITHUB_PERSONAL_ACCESS_TOKEN": "YOUR_TOKEN_HERE"\n}';
      } else if (val === 'postgres') {
        mcpNameInput.value = 'postgres-server';
        mcpCommandInput.value = 'npx';
        mcpArgsInput.value = '["-y", "@modelcontextprotocol/server-postgres", "--connection-string", "postgresql://localhost:5432/mydb"]';
        mcpEnvInput.value = '';
      } else if (val === 'filesystem') {
        mcpNameInput.value = 'filesystem-server';
        mcpCommandInput.value = 'npx';
        mcpArgsInput.value = '["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allow"]';
        mcpEnvInput.value = '';
      }
    });
  }

  if (mcpSettingsBtn) {
    mcpSettingsBtn.addEventListener('click', () => {
      mcpModal.style.display = 'block';
      vscode.postMessage({ command: 'getMcpServers' });
    });
  }

  if (closeMcpModalBtn) {
    closeMcpModalBtn.addEventListener('click', () => {
      mcpModal.style.display = 'none';
    });
  }

  window.addEventListener('click', e => {
    if (e.target === mcpModal) {
      mcpModal.style.display = 'none';
    }
    if (e.target === healthModal) {
      healthModal.style.display = 'none';
    }
    if (e.target === promptLibraryModal) {
      promptLibraryModal.style.display = 'none';
    }
  });

  function showMcpValidationError(message) {
    if (!mcpServersList) return;
    const existing = document.getElementById('mcpValidationError');
    if (existing) existing.remove();
    const errDiv = document.createElement('div');
    errDiv.id = 'mcpValidationError';
    errDiv.className = 'form-error';
    errDiv.innerText = message;
    mcpServersList.prepend(errDiv);
  }

  if (saveMcpBtn) {
    saveMcpBtn.addEventListener('click', () => {
      const name = mcpNameInput.value.trim();
      const commandText = mcpCommandInput.value.trim();
      const rawArgs = mcpArgsInput.value.trim();
      const rawEnv = mcpEnvInput ? mcpEnvInput.value.trim() : '';

      if (!name || !commandText) {
        showMcpValidationError('Server name and command are required.');
        return;
      }

      let args = [];
      if (rawArgs) {
        try {
          args = JSON.parse(rawArgs);
          if (!Array.isArray(args)) {
            showMcpValidationError('Arguments must be a valid JSON array of strings.');
            return;
          }
        } catch (err) {
          showMcpValidationError('Failed to parse arguments as a JSON array. Use a format like: ["arg1", "arg2"].');
          return;
        }
      }

      let env = undefined;
      if (rawEnv) {
        try {
          env = JSON.parse(rawEnv);
          if (typeof env !== 'object' || Array.isArray(env)) {
            showMcpValidationError('Environment variables must be a valid JSON object.');
            return;
          }
        } catch (err) {
          showMcpValidationError('Failed to parse environment variables as a JSON object. Use a format like: {"KEY": "VALUE"}.');
          return;
        }
      }

      vscode.postMessage({ command: 'addMcpServer', name, commandText, args, env });
      
      // Clear inputs
      mcpNameInput.value = '';
      mcpCommandInput.value = '';
      mcpArgsInput.value = '';
      if (mcpEnvInput) mcpEnvInput.value = '';
      if (mcpPreset) mcpPreset.value = '';
    });
  }

  function renderMcpServers(servers, error, success) {
    mcpServersList.innerHTML = '';
    
    // Update active connection indicator in the header bar
    const indicator = document.getElementById('mcpActiveIndicator');
    if (indicator) {
      if (!servers || servers.length === 0) {
        indicator.style.background = '#9aa0a6'; // gray
        indicator.style.setProperty('--glow-color', 'transparent');
      } else {
        const hasError = servers.some(s => s.status === 'Error');
        const hasConnecting = servers.some(s => s.status === 'Connecting');
        const hasConnected = servers.some(s => s.status === 'Connected');

        if (hasError) {
          indicator.style.background = '#ea4335'; // red
          indicator.style.setProperty('--glow-color', '#ea4335');
        } else if (hasConnecting) {
          indicator.style.background = '#fbbc05'; // yellow
          indicator.style.setProperty('--glow-color', '#fbbc05');
        } else if (hasConnected) {
          indicator.style.background = '#34a853'; // green
          indicator.style.setProperty('--glow-color', '#34a853');
        } else {
          indicator.style.background = '#9aa0a6';
          indicator.style.setProperty('--glow-color', 'transparent');
        }
      }
    }

    if (error) {
      const errDiv = document.createElement('div');
      errDiv.style.color = '#ea4335';
      errDiv.style.fontSize = '11px';
      errDiv.style.marginBottom = '6px';
      errDiv.innerText = `Error: ${error}`;
      mcpServersList.appendChild(errDiv);
    }
    if (!servers || servers.length === 0) {
      mcpServersList.innerHTML += '<div style="opacity:0.5; font-size:11px;">No MCP servers connected.</div>';
    } else {
      servers.forEach(server => {
        const item = document.createElement('div');
        item.className = 'mcp-server-card';

        const info = document.createElement('div');
        info.className = 'mcp-server-info';

        const statusColors = {
          'Connected': '#34a853',
          'Connecting': '#fbbc05',
          'Disconnected': '#9aa0a6',
          'Error': '#ea4335'
        };
        const statusColor = statusColors[server.status] || '#9aa0a6';

        info.innerHTML = `
          <div style="font-weight:bold; font-size:11px; display:flex; align-items:center; gap:6px;">
            <span>${escapeHTML(server.name)}</span>
            <span class="mcp-status-dot" style="background:${statusColor}; --glow-color:${statusColor};" title="${server.status}"></span>
            <span style="font-size:8px; opacity:0.6; font-weight:normal;">(${server.status})</span>
          </div>
          <div style="font-size:9px; opacity:0.6; font-family:monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:280px;">
            ${escapeHTML(server.command)} ${escapeHTML(JSON.stringify(server.args))}
          </div>
          ${server.error ? `<div style="color:#ea4335; font-size:9px; white-space:normal; word-break:break-all; max-width:280px;">${escapeHTML(server.error)}</div>` : ''}
        `;

        const actions = document.createElement('div');
        actions.style.display = 'flex';
        actions.style.alignItems = 'center';
        actions.style.gap = '6px';

        if (server.status === 'Error' || server.status === 'Disconnected') {
          const restartBtn = document.createElement('button');
          restartBtn.innerText = '↻';
          restartBtn.style.background = 'none';
          restartBtn.style.border = 'none';
          restartBtn.style.color = '#34a853';
          restartBtn.style.cursor = 'pointer';
          restartBtn.style.fontSize = '14px';
          restartBtn.style.padding = '4px';
          restartBtn.title = 'Restart/Reconnect Server';
          restartBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'restartMcpServer', name: server.name });
          });
          actions.appendChild(restartBtn);
        }

        const delBtn = document.createElement('button');
        delBtn.innerText = '✕';
        delBtn.style.background = 'none';
        delBtn.style.border = 'none';
        delBtn.style.color = '#ea4335';
        delBtn.style.cursor = 'pointer';
        delBtn.style.fontSize = '12px';
        delBtn.style.padding = '4px';
        delBtn.addEventListener('click', () => {
          vscode.postMessage({ command: 'deleteMcpServer', name: server.name });
        });
        actions.appendChild(delBtn);

        item.appendChild(info);
        item.appendChild(actions);
        mcpServersList.appendChild(item);
      });
    }
  }

  window.insertAtCursor = function(encodedCode) {
    const code = decodeURIComponent(encodedCode);
    vscode.postMessage({ command: 'insertCode', code });
  };

  function updateTokenHUD() {
    const hudTokenLabel = document.getElementById('hudTokenLabel');
    const hudTokenFill = document.getElementById('hudTokenFill');
    if (!hudTokenLabel || !hudTokenFill) return;

    let totalTokens = 0;
    const badges = document.querySelectorAll('.token-badge span');
    badges.forEach(b => {
      const txt = b.innerText;
      const match = txt.match(/estimated:\s*(\d+)/i);
      if (match) {
        totalTokens += parseInt(match[1]);
      }
    });

    hudTokenLabel.innerText = `${totalTokens.toLocaleString()} / ${maxContextTokens.toLocaleString()} estimated tokens`;
    const percentage = Math.min(100, (totalTokens / maxContextTokens) * 100);
    hudTokenFill.style.width = `${percentage}%`;

    const hudTokenSummary = document.getElementById('hudTokenSummary');
    if (hudTokenSummary) {
      hudTokenSummary.innerText = `${Math.round(percentage)}%`;
    }

    if (percentage > 85) {
      hudTokenFill.style.background = '#ea4335';
    } else if (percentage > 60) {
      hudTokenFill.style.background = '#fbbc05';
    } else {
      hudTokenFill.style.background = 'linear-gradient(90deg, var(--vscode-editorGutter-modifiedBackground, #4fc1ff), var(--vscode-charts-blue, #1d4ed8))';
    }
  }

  // --- Draggable Resizer ---
  const drawerResizer = document.getElementById('drawerResizer');
  let isResizing = false;
  
  if (drawerResizer && historyDrawer) {
    drawerResizer.addEventListener('mousedown', (e) => {
      isResizing = true;
      document.body.style.userSelect = 'none';
      drawerResizer.classList.add('resizing');
    });

    window.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const newWidth = Math.max(150, Math.min(e.clientX, 450));
      historyDrawer.style.width = `${newWidth}px`;
    });

    window.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        document.body.style.userSelect = '';
        drawerResizer.classList.remove('resizing');
      }
    });
  }

  window.viewSidebarDiff = function(toolCallId) {
    const call = activeToolCalls.get(toolCallId);
    if (call) {
      vscode.postMessage({
        command: 'viewSidebarDiff',
        name: call.name,
        args: call.args
      });
    }
  };

  function renderToolChecklist(toolCalls) {
    if (currentStreamingBubble) {
      finalizeAssistantMessageSplit('left');
    }

    const card = document.createElement('div');
    card.className = 'checklist-card';

    let itemsHtml = '';
    toolCalls.forEach((call, index) => {
      const toolIcons = {
        'write_file': '📝', 'edit_file': '✏️', 'read_file': '📖',
        'delete_file': '🗑️', 'list_dir': '📂', 'run_command': '▶️',
        'grep_search': '🔍', 'web_search': '🌐', 'fetch_webpage': '🌍'
      };
      const icon = toolIcons[call.name] || '⚙️';
      
      let inputHtml = '';
      if (call.name === 'run_command') {
        inputHtml = `<input type="text" class="checklist-arg-input" data-key="command" value="${escapeHTML(call.arguments.command)}" title="Command to execute" />`;
      } else if (call.name === 'write_file' || call.name === 'edit_file' || call.name === 'delete_file' || call.name === 'read_file') {
        inputHtml = `<input type="text" class="checklist-arg-input" data-key="file_path" value="${escapeHTML(call.arguments.file_path)}" title="File path" />`;
      } else if (call.name === 'grep_search') {
        inputHtml = `<input type="text" class="checklist-arg-input" data-key="query" value="${escapeHTML(call.arguments.query)}" title="Search Query" />`;
      } else {
        inputHtml = `<pre class="tool-args-pre" style="margin:0; font-size:10px;">${escapeHTML(JSON.stringify(call.arguments))}</pre>`;
      }

      itemsHtml += `
        <div class="checklist-item" data-index="${index}">
          <input type="checkbox" class="checklist-checkbox" checked title="Toggle approval of this tool" />
          <div class="checklist-content">
            <div style="display:flex; align-items:center; gap:6px;">
              <span class="tool-icon">${icon}</span>
              <span class="checklist-tool-name">${escapeHTML(call.name)}</span>
            </div>
            <div style="margin-top:4px;">
              ${inputHtml}
            </div>
          </div>
          <div class="checklist-controls">
            <button class="checklist-ctrl-btn move-up" type="button" title="Move Up">▲</button>
            <button class="checklist-ctrl-btn move-down" type="button" title="Move Down">▼</button>
            <button class="checklist-ctrl-btn delete" type="button" title="Delete Task">×</button>
          </div>
        </div>
      `;
    });

    card.innerHTML = `
      <div class="checklist-title">
        <span>📋 Planned Actions (${toolCalls.length})</span>
      </div>
      <div class="checklist-items">
        ${itemsHtml}
      </div>
      <div class="checklist-actions">
        <button class="btn-sm reject" id="cancelPlanBtn" type="button" style="background:#5a5a5a; color:#fff;">Cancel</button>
        <button class="btn-sm accept" id="executePlanBtn" type="button">Run</button>
      </div>
    `;

    const itemsContainer = card.querySelector('.checklist-items');
    
    card.addEventListener('click', (e) => {
      const target = e.target;
      const itemEl = target.closest('.checklist-item');
      if (!itemEl) return;

      if (target.classList.contains('delete')) {
        itemEl.remove();
        updateChecklistBadgeCount();
      } else if (target.classList.contains('move-up')) {
        const prev = itemEl.previousElementSibling;
        if (prev) {
          itemsContainer.insertBefore(itemEl, prev);
        }
      } else if (target.classList.contains('move-down')) {
        const next = itemEl.nextElementSibling;
        if (next) {
          itemsContainer.insertBefore(next, itemEl);
        }
      }
    });

    function updateChecklistBadgeCount() {
      const count = card.querySelectorAll('.checklist-item').length;
      const titleSpan = card.querySelector('.checklist-title span');
      if (titleSpan) {
        titleSpan.innerText = `📋 Planned Agent Actions (${count})`;
      }
    }

    card.querySelector('#executePlanBtn').addEventListener('click', () => {
      const approvedCalls = [];
      const itemEls = card.querySelectorAll('.checklist-item');
      
      itemEls.forEach(el => {
        const checkbox = el.querySelector('.checklist-checkbox');
        if (checkbox && checkbox.checked) {
          const originalIndex = parseInt(el.dataset.index);
          const originalCall = toolCalls[originalIndex];
          
          const newArgs = { ...originalCall.arguments };
          const inputs = el.querySelectorAll('.checklist-arg-input');
          inputs.forEach(input => {
            const key = input.dataset.key;
            if (key) {
              newArgs[key] = input.value;
            }
          });
          
          approvedCalls.push({
            name: originalCall.name,
            arguments: newArgs
          });
        }
      });

      const actionsDiv = card.querySelector('.checklist-actions');
      if (actionsDiv) actionsDiv.style.display = 'none';
      card.querySelectorAll('.checklist-checkbox, .checklist-arg-input').forEach(el => el.disabled = true);
      card.querySelectorAll('.checklist-controls').forEach(el => el.style.display = 'none');
      
      vscode.postMessage({
        command: 'toolChecklistResponse',
        approvedCalls: approvedCalls
      });
    });

    card.querySelector('#cancelPlanBtn').addEventListener('click', () => {
      const actionsDiv = card.querySelector('.checklist-actions');
      if (actionsDiv) actionsDiv.style.display = 'none';
      card.querySelectorAll('.checklist-checkbox, .checklist-arg-input').forEach(el => el.disabled = true);
      card.querySelectorAll('.checklist-controls').forEach(el => el.style.display = 'none');
      
      vscode.postMessage({
        command: 'toolChecklistResponse',
        approvedCalls: null
      });
    });

    messagesDiv.appendChild(card);
    scrollToBottom();
  }

  function renderArtifactsTab() {
    if (!artifactsList) return;
    artifactsList.innerHTML = '';
    if (artifacts.length === 0) {
      if (artifactsEmptyState) artifactsEmptyState.style.display = 'block';
      return;
    }

    if (artifactsEmptyState) artifactsEmptyState.style.display = 'none';

    artifacts.forEach((art, index) => {
      const item = document.createElement('div');
      item.className = 'checklist-item';
      item.style.flexDirection = 'column';
      item.style.alignItems = 'stretch';
      item.style.padding = '10px';
      item.style.gap = '8px';

      item.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; width:100%;">
          <div style="display:flex; flex-direction:column; gap:2px; flex:1; min-width:0;">
            <span style="font-size:12px; font-weight:bold; color:var(--text-main, #e1e1e1); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHTML(art.fileName)}</span>
            <span style="font-size:9px; opacity:0.6; font-family:var(--font-mono, monospace); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHTML(art.filePath)}</span>
          </div>
          <div style="display:flex; gap:6px; flex-shrink:0;">
            <button class="btn-sm copy-btn" onclick="copyArtifactContent(${index}, this)" title="Copy content to clipboard" style="font-size:10px; padding:2px 6px;">Copy</button>
            <button class="btn-sm" onclick="openArtifactInEditor('${encodeURIComponent(art.filePath)}')" title="Open file in editor" style="font-size:10px; padding:2px 6px; background:var(--button-bg, #007acc); color:#fff; border-color:var(--button-bg, #007acc);">Open</button>
          </div>
        </div>
        <details style="border-top:1px solid rgba(255,255,255,0.05); margin-top:4px; padding-top:6px;">
          <summary style="font-size:10px; opacity:0.7; cursor:pointer; list-style:none; display:flex; align-items:center; gap:4px;">
            <span>▶</span> Show Code Preview (${art.content.split('\n').length} lines)
          </summary>
          <pre style="margin:6px 0 0 0; background:rgba(0,0,0,0.3); padding:8px; border-radius:4px; font-size:10px; overflow-x:auto; font-family:var(--font-mono, monospace); max-height:150px; white-space:pre-wrap; word-break:break-all;">${escapeHTML(art.content)}</pre>
        </details>
      `;

      const summary = item.querySelector('summary');
      const arrow = summary.querySelector('span');
      item.querySelector('details').addEventListener('toggle', (e) => {
        arrow.innerText = e.target.open ? '▼' : '▶';
      });

      artifactsList.appendChild(item);
    });
  }

  window.copyArtifactContent = function(index, btn) {
    const art = artifacts[index];
    if (art) {
      navigator.clipboard.writeText(art.content);
      const originalText = btn.innerText;
      btn.innerText = 'Copied!';
      setTimeout(() => { btn.innerText = originalText; }, 2000);
    }
  };

  window.openArtifactInEditor = function(encodedPath) {
    const filePath = decodeURIComponent(encodedPath);
    vscode.postMessage({ command: 'openFile', filePath: filePath });
  };

  function updateCollapsibleSummaries() {
    const toolsSectionValue = document.getElementById('toolsSectionValue');
    
    if (toolsSectionValue) {
      if (toolsSection && !toolsSection.open) {
        const activeMcpDot = document.getElementById('mcpActiveIndicator');
        const mcpStatus = activeMcpDot && activeMcpDot.classList.contains('active') ? 'MCP Connected' : 'MCP Setup';
        const selectedRoleName = roleSelector && roleSelector.selectedIndex !== -1
          ? roleSelector.options[roleSelector.selectedIndex].text
          : 'Developer';
        toolsSectionValue.innerText = `${selectedRoleName} | ${mcpStatus}`;
      } else {
        toolsSectionValue.innerText = '';
      }
    }
  }
})();
