(function() {
  const vscode = acquireVsCodeApi();

  const composerInput = document.getElementById('composerInput');
  const composeBtn = document.getElementById('composeBtn');
  const stopBtn = document.getElementById('stopBtn');
  const tagsContainer = document.getElementById('tagsContainer');
  const suggestList = document.getElementById('suggestList');
  const statusIndicator = document.getElementById('statusIndicator');
  const sessionPanel = document.getElementById('sessionPanel');
  const changeList = document.getElementById('changeList');
  const acceptAllBtn = document.getElementById('acceptAllBtn');
  const rejectAllBtn = document.getElementById('rejectAllBtn');
  const attachFileBtn = document.getElementById('attachFileBtn');
  const modelSelector = document.getElementById('modelSelector');
  const composerConsole = document.getElementById('composerConsole');

  let workspaceFiles = [];
  let selectedFiles = [];
  let suggestMode = false;
  let suggestQuery = '';
  let suggestStartIndex = -1;
  let selectedSuggestIndex = 0;
  let filteredSuggestions = [];
  let activeChanges = [];
  let streamedText = '';

  composerInput.focus();

  // Load initial files list
  vscode.postMessage({ command: 'requestWorkspaceFiles' });

  window.addEventListener('message', event => {
    const message = event.data;
    switch (message.type) {
      case 'workspaceFiles':
        workspaceFiles = message.files || [];
        break;

      case 'settingsUpdate':
        updateModelSelector(message.provider, message.chatModel, message.customModels, message.vscodeLMModels);
        break;

      case 'statusUpdate':
        statusIndicator.style.display = 'block';
        statusIndicator.innerHTML = `<span class="streaming">${escapeHTML(message.text)}</span>`;
        break;

      case 'streamStart':
        setStreamingState(message.text || 'Starting composer stream...');
        appendLifecycleMessage(message.text || 'Composer stream started.');
        break;

      case 'streamToken':
        appendStreamToken(message.token || '');
        break;

      case 'streamEnd':
        finishStreamingState(message.text || 'Composer stream completed.');
        appendLifecycleMessage(message.text || 'Composer stream completed.');
        break;

      case 'streamError':
        finishStreamingState(message.error || 'Composer stream failed.', true);
        appendLifecycleMessage(`Error: ${message.error || 'Composer stream failed.'}`);
        break;

      case 'proposedChanges':
        renderProposedChanges(message.changes);
        break;

      case 'diffLinesResponse':
        renderInlineDiff(message.filePath, message.diffLines);
        break;

      case 'changeStatusUpdate':
        updateFileStatus(message.filePath, message.status);
        break;

      case 'composerReset':
        resetComposer();
        break;

      case 'addReferencedFiles':
        message.files.forEach(file => {
          if (!selectedFiles.find(f => f.filePath === file.filePath)) {
            selectedFiles.push(file);
          }
        });
        renderTags();
        break;
    }
  });

  composeBtn.addEventListener('click', compose);
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'stop' });
    });
  }

  if (attachFileBtn) {
    attachFileBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'openFilePicker' });
    });
  }

  composerInput.addEventListener('keydown', e => {
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
        compose();
      }
    }
  });

  composerInput.addEventListener('input', e => {
    const text = composerInput.value;
    const caretPos = composerInput.selectionStart;
    const lastAtIdx = text.lastIndexOf('@', caretPos - 1);
    
    if (lastAtIdx !== -1 && (lastAtIdx === 0 || /\s/.test(text[lastAtIdx - 1]))) {
      const betweenText = text.substring(lastAtIdx + 1, caretPos);
      if (!/\s/.test(betweenText)) {
        suggestMode = true;
        suggestQuery = betweenText.toLowerCase();
        suggestStartIndex = lastAtIdx;
        updateSuggestions();
        return;
      }
    }
    closeSuggestions();
  });

  function updateSuggestions() {
    const virtualTags = [
      { filePath: 'virtual:problems', relativePath: 'Workspace Problems (Diagnostics)', isVirtual: true },
      { filePath: 'virtual:git-diff', relativePath: 'Git Diff (Uncommitted Changes)', isVirtual: true },
      { filePath: 'virtual:workspace', relativePath: 'Workspace Outline Map', isVirtual: true }
    ];

    if (suggestQuery === '') {
      filteredSuggestions = [...virtualTags, ...workspaceFiles.slice(0, 8)];
    } else {
      const matches = [...virtualTags, ...workspaceFiles]
        .filter(f => f.relativePath.toLowerCase().includes(suggestQuery))
        .slice(0, 10);
      filteredSuggestions = matches;
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

    filteredSuggestions.forEach((file, index) => {
      const div = document.createElement('div');
      div.className = `suggest-item ${index === selectedSuggestIndex ? 'selected' : ''}`;
      const fileName = file.isVirtual ? file.relativePath : file.relativePath.split('/').pop().split('\\').pop();
      const pathLabel = file.isVirtual ? 'Virtual Context Provider' : file.relativePath;
      const name = document.createElement('span');
      name.className = 'suggest-item-name';
      name.textContent = fileName;
      if (file.isVirtual) {
        name.style.color = 'var(--vscode-editorGutter-modifiedBackground, #4fc1ff)';
        name.style.fontWeight = 'bold';
      }
      const path = document.createElement('span');
      path.className = 'suggest-item-path';
      path.textContent = pathLabel;
      div.append(name, path);
      div.addEventListener('click', () => selectSuggestion(file));
      suggestList.appendChild(div);
    });
  }

  function selectSuggestion(file) {
    if (!selectedFiles.find(f => f.filePath === file.filePath)) {
      selectedFiles.push(file);
      renderTags();
    }
    const text = composerInput.value;
    const before = text.substring(0, suggestStartIndex);
    const after = text.substring(composerInput.selectionStart);
    composerInput.value = before + after;
    composerInput.focus();
    closeSuggestions();
  }

  function closeSuggestions() {
    suggestMode = false;
    suggestList.style.display = 'none';
  }

  function renderTags() {
    tagsContainer.innerHTML = '';
    selectedFiles.forEach(file => {
      const tag = document.createElement('div');
      tag.className = 'tag' + (file.isVirtual ? ' virtual' : '');
      const fileName = file.isVirtual ? file.relativePath : file.relativePath.split('/').pop().split('\\').pop();
      const label = document.createElement('span');
      label.textContent = fileName;
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'tag-close';
      close.title = 'Remove';
      close.setAttribute('aria-label', `Remove ${fileName}`);
      close.innerHTML = '&times;';
      close.addEventListener('click', () => {
        selectedFiles = selectedFiles.filter(f => f.filePath !== file.filePath);
        renderTags();
      });
      tag.append(label, close);
      tagsContainer.appendChild(tag);
    });
  }

  function compose() {
    const text = composerInput.value.trim();
    if (!text && selectedFiles.length === 0) return;

    const selectedModel = getSelectedModel();
    streamedText = '';
    if (composerConsole) {
      composerConsole.textContent = '';
      composerConsole.style.display = 'block';
    }

    composerInput.disabled = true;
    composeBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'inline-flex';
    statusIndicator.style.display = 'block';
    statusIndicator.innerHTML = '<span class="streaming">Analyzing workspace context...</span>';

    vscode.postMessage({
      command: 'compose',
      prompt: text,
      files: selectedFiles.map(f => f.filePath),
      modelId: selectedModel.modelId,
      provider: selectedModel.provider
    });
  }

  function getSelectedModel() {
    if (!modelSelector || modelSelector.selectedIndex === -1) {
      return { modelId: undefined, provider: undefined };
    }

    const selectedOption = modelSelector.options[modelSelector.selectedIndex];
    return {
      modelId: selectedOption.value || undefined,
      provider: selectedOption.dataset.provider || undefined
    };
  }

  function updateModelSelector(currentProvider, currentChatModel, customModels, vscodeLMModels) {
    if (!modelSelector) return;

    const models = [
      { provider: 'Gemini', name: 'Gemini 1.5 Flash', modelId: 'gemini-1.5-flash' },
      { provider: 'Gemini', name: 'Gemini 1.5 Pro', modelId: 'gemini-1.5-pro' },
      { provider: 'Ollama', name: 'gpt-oss:120b-cloud', modelId: 'gpt-oss:120b-cloud' },
      { provider: 'OpenAI', name: 'GPT-4o', modelId: 'gpt-4o' },
      { provider: 'OpenAI', name: 'GPT-4o Mini', modelId: 'gpt-4o-mini' },
      { provider: 'Anthropic', name: 'Claude 3.5 Sonnet', modelId: 'claude-3-5-sonnet' },
      { provider: 'OpenRouter', name: 'OpenRouter Llama 3', modelId: 'meta-llama/llama-3-8b-instruct:free' }
    ];

    if (Array.isArray(vscodeLMModels)) {
      vscodeLMModels.forEach(model => {
        if (!models.some(existing => existing.provider === 'Copilot' && existing.modelId === model.modelId)) {
          models.push({
            provider: 'Copilot',
            name: `Copilot: ${model.name}`,
            modelId: model.modelId
          });
        }
      });
    }

    if (!models.some(model => model.provider === 'Copilot')) {
      models.push({ provider: 'Copilot', name: 'Copilot GPT-4o', modelId: 'gpt-4o' });
      models.push({ provider: 'Copilot', name: 'Copilot GPT-3.5 Turbo', modelId: 'gpt-3.5-turbo' });
    }

    if (Array.isArray(customModels)) {
      customModels.forEach(customModel => {
        models.push({
          provider: customModel.provider || 'OpenAI',
          name: `Custom: ${customModel.name}`,
          modelId: customModel.modelId
        });
      });
    }

    if (currentProvider === 'Custom' && (!customModels || !customModels.some(cm => cm.modelId === currentChatModel))) {
      models.push({
        provider: 'Custom',
        name: `Custom Model: ${currentChatModel}`,
        modelId: currentChatModel
      });
    }

    modelSelector.innerHTML = '';
    models.forEach(model => {
      const option = document.createElement('option');
      option.value = model.modelId;
      option.dataset.provider = model.provider;
      option.innerText = model.name;
      if (model.modelId === currentChatModel && model.provider === currentProvider) {
        option.selected = true;
      }
      modelSelector.appendChild(option);
    });

    if (modelSelector.selectedIndex === -1) {
      const fallbackIndex = models.findIndex(model => model.modelId === currentChatModel);
      modelSelector.selectedIndex = fallbackIndex >= 0 ? fallbackIndex : 0;
    }
  }

  function appendStreamToken(token) {
    streamedText += token;
    if (!composerConsole) return;

    composerConsole.style.display = 'block';
    composerConsole.textContent = streamedText;
    composerConsole.scrollTop = composerConsole.scrollHeight;
  }

  function appendLifecycleMessage(text) {
    if (!composerConsole || !text) return;

    const line = `[${new Date().toLocaleTimeString()}] ${text}\n`;
    streamedText = streamedText ? `${streamedText}\n${line}` : line;
    composerConsole.style.display = 'block';
    composerConsole.textContent = streamedText;
    composerConsole.scrollTop = composerConsole.scrollHeight;
  }

  function setStreamingState(text) {
    composerInput.disabled = true;
    composeBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'inline-flex';
    statusIndicator.style.display = 'block';
    statusIndicator.innerHTML = `<span class="streaming">${escapeHTML(text)}</span>`;
  }

  function finishStreamingState(text, isError) {
    composerInput.disabled = false;
    composeBtn.disabled = false;
    composeBtn.style.display = 'inline-flex';
    if (stopBtn) stopBtn.style.display = 'none';
    statusIndicator.style.display = 'block';
    statusIndicator.innerHTML = isError
      ? `<span>${escapeHTML(text)}</span>`
      : `<span class="streaming">${escapeHTML(text)}</span>`;
  }

  function renderProposedChanges(changes) {
    activeChanges = changes;
    statusIndicator.style.display = 'none';
    composeBtn.style.display = 'inline-flex';
    if (stopBtn) stopBtn.style.display = 'none';
    sessionPanel.style.display = 'block';
    changeList.innerHTML = '';
    if (composerConsole && !streamedText) {
      composerConsole.style.display = 'none';
    }

    if (changes.length === 0) {
      changeList.innerHTML = '<div style="padding:12px; opacity:0.6;">No changes proposed.</div>';
      return;
    }

    changes.forEach((change, index) => {
      const item = document.createElement('div');
      item.className = 'change-item';
      item.id = `change-${escapeId(change.filePath)}`;
      item.dataset.changeIndex = String(index);
      
      const fileName = change.relativePath.split('/').pop().split('\\').pop();
      const statusLabel = getStatusLabel(change.status);
      
      item.innerHTML = `
        <div style="display:flex; flex-direction:column; width:100%; gap:4px;">
          <div style="display:flex; justify-content:space-between; align-items:center; width:100%;">
            <div class="change-info" role="button" tabindex="0" style="flex-grow:1; display:flex; flex-direction:column;">
              <div style="display:flex; align-items:center; gap:8px;">
                <span class="change-file-name" style="cursor:pointer;">${escapeHTML(fileName)}</span>
                <span class="badge ${change.isNew ? 'new' : 'modified'}">${change.isNew ? 'NEW' : 'MODIFIED'}</span>
                <span class="status-badge" style="font-size:10px; opacity:0.7;">${statusLabel}</span>
              </div>
              <span class="change-file-path" style="cursor:pointer;">${escapeHTML(change.relativePath)}</span>
            </div>
            <div class="change-actions" style="display:flex; gap:6px; flex-shrink:0;">
              <button class="btn-sm toggle-diff-view" type="button" data-action="toggle-diff" style="margin-right:4px;">Show Diff</button>
              <button class="btn-sm accept" type="button" data-action="accept">Accept</button>
              <button class="btn-sm reject" type="button" data-action="reject">Discard</button>
            </div>
          </div>
          <div class="webview-diff-container" id="diff-container-${index}" style="display:none; margin-top:8px;">
            <div class="webview-diff-body" id="diff-body-${index}">
              <div style="padding:10px; opacity:0.5;">Loading diff...</div>
            </div>
          </div>
        </div>
      `;

      const changeInfo = item.querySelector('.change-info');
      changeInfo.addEventListener('click', () => viewDiffByIndex(index));
      changeInfo.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          viewDiffByIndex(index);
        }
      });
      
      const toggleDiffBtn = item.querySelector('[data-action="toggle-diff"]');
      const diffContainer = item.querySelector(`#diff-container-${index}`);
      toggleDiffBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isHidden = diffContainer.style.display === 'none';
        diffContainer.style.display = isHidden ? 'block' : 'none';
        toggleDiffBtn.innerText = isHidden ? 'Hide Diff' : 'Show Diff';
        
        if (isHidden) {
          const diffBody = item.querySelector(`#diff-body-${index}`);
          if (diffBody.innerHTML.includes('Loading diff...')) {
            vscode.postMessage({
              command: 'requestDiffLines',
              filePath: change.filePath,
              originalPath: change.originalPath,
              proposedPath: change.proposedPath
            });
          }
        }
      });

      item.querySelector('[data-action="accept"]').addEventListener('click', (e) => {
        e.stopPropagation();
        acceptChangeByIndex(index);
      });
      item.querySelector('[data-action="reject"]').addEventListener('click', (e) => {
        e.stopPropagation();
        rejectChangeByIndex(index);
      });
      changeList.appendChild(item);
    });
  }

  function renderInlineDiff(filePath, diffLines) {
    const index = activeChanges.findIndex(c => c.filePath === filePath);
    if (index === -1) return;

    const diffBody = document.getElementById(`diff-body-${index}`);
    if (!diffBody) return;

    if (!diffLines || diffLines.length === 0) {
      diffBody.innerHTML = '<div style="padding:10px; opacity:0.5;">No differences.</div>';
      return;
    }

    let html = '';
    diffLines.forEach(line => {
      let lineClass = 'diff-line-normal';
      let prefix = ' ';
      if (line.type === 'added') {
        lineClass = 'diff-line-added';
        prefix = '+';
      } else if (line.type === 'removed') {
        lineClass = 'diff-line-removed';
        prefix = '-';
      }
      html += `
        <div class="diff-line ${lineClass}">
          <span class="diff-line-prefix">${prefix}</span>
          <span class="diff-line-content">${escapeHTML(line.text)}</span>
        </div>
      `;
    });
    diffBody.innerHTML = html;
  }

  function getStatusLabel(status) {
    switch (status) {
      case 'accepted': return '<span style="font-weight:bold; border-bottom:1px solid var(--text-main)">[ACCEPTED]</span>';
      case 'rejected': return '<span style="text-decoration:line-through; opacity:0.5;">[DISCARDED]</span>';
      default: return '<span style="opacity:0.8;">[PENDING]</span>';
    }
  }

  function updateFileStatus(filePath, status) {
    const item = document.getElementById(`change-${escapeId(filePath)}`);
    if (item) {
      const statusBadge = item.querySelector('.status-badge');
      statusBadge.innerHTML = getStatusLabel(status);

      // Disable actions if finalized
      if (status !== 'pending') {
        const actions = item.querySelector('.change-actions');
        actions.style.opacity = '0.4';
        actions.querySelectorAll('button').forEach(b => b.disabled = true);
      }
    }
  }

  function resetComposer() {
    composerInput.disabled = false;
    composeBtn.disabled = false;
    composeBtn.style.display = 'inline-flex';
    if (stopBtn) stopBtn.style.display = 'none';
    composerInput.value = '';
    selectedFiles = [];
    renderTags();
    sessionPanel.style.display = 'none';
    statusIndicator.style.display = 'none';
    changeList.innerHTML = '';
    streamedText = '';
    if (composerConsole) {
      composerConsole.textContent = '';
      composerConsole.style.display = 'none';
    }
  }

  function viewDiffByIndex(index) {
    const change = activeChanges[index];
    if (change) {
      vscode.postMessage({
        command: 'viewDiff',
        filePath: change.filePath,
        originalPath: change.originalPath,
        proposedPath: change.proposedPath
      });
    }
  }

  function acceptChangeByIndex(index) {
    const change = activeChanges[index];
    if (change) {
      vscode.postMessage({ command: 'acceptChange', filePath: change.filePath });
    }
  }

  function rejectChangeByIndex(index) {
    const change = activeChanges[index];
    if (change) {
      vscode.postMessage({ command: 'rejectChange', filePath: change.filePath });
    }
  }

  acceptAllBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'acceptAll' });
  });

  rejectAllBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'discardAll' });
  });

  function escapeHTML(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escapeId(path) {
    return path.replace(/[^a-zA-Z0-9]/g, '_');
  }
})();
