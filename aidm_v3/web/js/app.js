/**
 * AIDM v3 Main Application
 */

// Available models cache
let modelsCache = null;

// Session state
let isSessionZero = true;

/**
 * Initialize the application
 */
async function init() {
    setupNavigation();
    setupGamePage();
    setupSettingsPage();

    // Load settings
    await loadSettings();

    // Auto-start Session Zero
    await startSessionZero();
}

/**
 * Setup navigation between pages
 */
function setupNavigation() {
    const navLinks = document.querySelectorAll('.nav-link');
    const pages = document.querySelectorAll('.page');

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const pageName = link.dataset.page;

            // Update active states
            navLinks.forEach(l => l.classList.remove('active'));
            link.classList.add('active');

            pages.forEach(p => p.classList.remove('active'));
            document.getElementById(`${pageName}-page`).classList.add('active');
        });
    });
}

/**
 * Setup game page interactions
 */
function setupGamePage() {
    const input = document.getElementById('player-input');
    const submitBtn = document.getElementById('submit-action');

    // Submit action
    submitBtn.addEventListener('click', () => handlePlayerAction());

    // Enter key to submit
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handlePlayerAction();
        }
    });
}

/**
 * Start Session Zero - the AI initiates the conversation
 * Checks localStorage for existing session and resumes if found
 */
async function startSessionZero() {
    const display = document.getElementById('narrative-display');

    // Check for existing session in localStorage
    const savedSessionId = localStorage.getItem('aidm_session_id');

    if (savedSessionId) {
        // Try to resume existing session
        display.innerHTML = `
            <div class="welcome-message">
                <h2>⏳ Resuming Session...</h2>
                <p>Loading your previous adventure.</p>
            </div>
        `;

        try {
            const resumed = await API.Game.resumeSession(savedSessionId);

            if (resumed && resumed.messages) {
                isSessionZero = resumed.phase !== 'gameplay';

                // Restore conversation history
                display.innerHTML = '';
                for (const msg of resumed.messages) {
                    addNarrativeEntry(msg.content, msg.role === 'user');
                }

                // Update context panel
                const phaseLabel = isSessionZero ? `Session Zero: ${resumed.phase}` : 'Gameplay';
                const ctxArc = document.getElementById('ctx-arc');
                if (ctxArc) ctxArc.textContent = phaseLabel;

                // Update profile sidebar from character draft (handles refresh during generation)
                if (resumed.character_draft?.media_reference) {
                    const ctxProfile = document.getElementById('ctx-profile');
                    if (ctxProfile) ctxProfile.textContent = resumed.character_draft.media_reference;
                }

                console.log('[Session] Resumed session:', savedSessionId);
                return;
            }
        } catch (e) {
            console.log('[Session] Could not resume, starting fresh:', e.message);
            localStorage.removeItem('aidm_session_id');
        }
    }

    // No saved session or resume failed - start fresh
    display.innerHTML = `
        <div class="welcome-message">
            <h2>⏳ Starting Session Zero...</h2>
            <p>The AI Dungeon Master is preparing your adventure.</p>
        </div>
    `;

    try {
        const result = await API.Game.startSession();
        isSessionZero = true;

        // Save session ID to localStorage
        localStorage.setItem('aidm_session_id', result.session_id);
        console.log('[Session] Started new session:', result.session_id);

        // Clear and show the AI's opening message
        display.innerHTML = '';
        addNarrativeEntry(result.opening_message, false);

        // Update context panel to show Session Zero phase
        const ctxArcStart = document.getElementById('ctx-arc');
        if (ctxArcStart) ctxArcStart.textContent = `Session Zero: ${result.phase}`;

        // Add quick-start suggestion buttons
        addQuickStartButtons();

    } catch (error) {
        display.innerHTML = `
            <div class="welcome-message">
                <h2>⚠️ Connection Error</h2>
                <p>${error.message}</p>
                <button onclick="startSessionZero()" class="btn-primary" style="margin-top: 1rem;">
                    🔄 Retry
                </button>
            </div>
        `;
    }
}

/**
 * Add quick-start suggestion buttons below the narrative
 */
function addQuickStartButtons() {
    const display = document.getElementById('narrative-display');

    const suggestions = document.createElement('div');
    suggestions.className = 'quick-suggestions';
    suggestions.innerHTML = `
        <div class="suggestion-label">Quick responses:</div>
        <div class="suggestion-buttons">
            <button class="btn-suggestion" data-response="I want to play in a Hunter x Hunter style world">
                🎯 Hunter x Hunter
            </button>
            <button class="btn-suggestion" data-response="I'm inspired by Solo Leveling">
                ⚔️ Solo Leveling
            </button>
            <button class="btn-suggestion" data-response="Something original, no specific anime">
                ✨ Original
            </button>
            <button class="btn-suggestion" data-response="I want a comedy adventure like Konosuba">
                😂 Comedy (Konosuba)
            </button>
        </div>
    `;

    display.appendChild(suggestions);

    // Add click handlers
    suggestions.querySelectorAll('.btn-suggestion').forEach(btn => {
        btn.addEventListener('click', () => {
            const response = btn.dataset.response;
            document.getElementById('player-input').value = response;
            handlePlayerAction();
            suggestions.remove();
        });
    });
}

/**
 * Handle player action submission
 */
async function handlePlayerAction() {
    const input = document.getElementById('player-input');
    const submitBtn = document.getElementById('submit-action');
    const playerText = input.value.trim();

    if (!playerText) return;

    // Remove quick suggestions if present
    const suggestions = document.querySelector('.quick-suggestions');
    if (suggestions) suggestions.remove();

    // Disable input while processing
    input.disabled = true;
    submitBtn.disabled = true;
    submitBtn.querySelector('.btn-text').style.display = 'none';
    submitBtn.querySelector('.btn-loading').style.display = 'inline';

    // Add player message to display
    addNarrativeEntry(playerText, true);
    input.value = '';

    try {
        let result;

        if (isSessionZero) {
            // Session Zero mode - character creation
            result = await API.Game.sessionTurn(playerText);

            // Check if research is starting - connect to progress stream
            console.log('[App] Full result:', JSON.stringify(result, null, 2));
            console.log('[App] research_task_id:', result.research_task_id);
            console.log('[App] window.researchProgress exists:', !!window.researchProgress);
            if (result.research_task_id && window.researchProgress) {
                console.log('[App] Research task started:', result.research_task_id);
                // Get anime name from character draft
                let animeName = result.character_draft?.media_reference || 'anime';

                // Check for hybrid blend (v3.2)
                if (result.detected_info?.blend_sources && result.detected_info.blend_sources.length > 1) {
                    const [sourceA, sourceB] = result.detected_info.blend_sources;
                    if (sourceA && sourceB) {
                        animeName = `${sourceA} & ${sourceB}`;
                    }
                }

                window.researchProgress.show(animeName);
                window.researchProgress.taskId = result.research_task_id;
                window.researchProgress.connectToStream();
            } else {
                console.log('[App] No research_task_id in response:', result.research_task_id);
            }

            // Add AI response
            addNarrativeEntry(result.response, false);

            // Update context panel with phase
            const ctxArcTurn = document.getElementById('ctx-arc');
            if (ctxArcTurn) ctxArcTurn.textContent = `Session Zero: ${result.phase}`;

            // Update sidebar profile (for cached profiles that don't trigger research progress)
            if (result.character_draft?.media_reference) {
                const profileEl = document.getElementById('ctx-profile');
                if (profileEl) profileEl.textContent = result.character_draft.media_reference;
            }

            // Check if we've transitioned to gameplay
            console.log('[Handoff] Checking transition - phase:', result.phase, 'ready_for_gameplay:', result.ready_for_gameplay);
            if (result.phase === 'gameplay' || result.ready_for_gameplay) {
                isSessionZero = false;
                console.log('[Handoff] Transition confirmed! Phase:', result.phase, 'ready_for_gameplay:', result.ready_for_gameplay);

                // Reload page to fully initialize gameplay mode
                // This ensures all UI elements are properly set up
                console.log('[Handoff] Transitioning to gameplay - reloading in 1.5s...');
                setTimeout(() => {
                    window.location.reload();
                }, 1500);  // Longer delay to ensure backend has saved state
                return;  // Don't continue processing
            }

            // Update debug panel for Session Zero
            updateDebugHUDSessionZero(result);

        } else {
            // Gameplay mode
            console.log('[Gameplay] isSessionZero =', isSessionZero);
            result = await API.Game.processTurn(playerText);
            console.log('[Gameplay] Full result keys:', Object.keys(result));
            console.log('[Gameplay] result.narrative:', result.narrative);
            console.log('[Gameplay] result.response:', result.response);  // Check if wrong field

            // Use narrative for gameplay, fallback to response if empty
            const text = result.narrative || result.response || '';
            console.log('[Gameplay] Final text length:', text.length);

            addNarrativeEntry(text, false);
            updateDebugHUD(result);
            await loadContext();
            await loadAllTrackers();  // Update sidebar trackers
        }

    } catch (error) {
        addNarrativeEntry(`Error: ${error.message}`, false);
    } finally {
        input.disabled = false;
        submitBtn.disabled = false;
        submitBtn.querySelector('.btn-text').style.display = 'inline';
        submitBtn.querySelector('.btn-loading').style.display = 'none';
        input.focus();
    }
}

/**
 * Reset the current session (called from Settings page)
 */


/**
 * Update debug HUD for Session Zero
 */
function updateDebugHUDSessionZero(result) {
    // Safe update helper - silently skip if element doesn't exist
    const safeUpdate = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };

    safeUpdate('dbg-intent', 'Session Zero');
    safeUpdate('dbg-epicness', '-');
    safeUpdate('dbg-outcome', result.phase_complete ? 'Phase Complete' : 'In Progress');
    safeUpdate('dbg-weight', result.phase);
    safeUpdate('dbg-latency', '-');
}

/**
 * Add a narrative entry to the display
 */
function addNarrativeEntry(text, isPlayer) {
    const display = document.getElementById('narrative-display');

    // Remove welcome message if present
    const welcome = display.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    // Guard against null/undefined/empty text
    if (!text || text.trim() === '') {
        console.warn('[addNarrativeEntry] Received empty text:', text);
        text = '_[No response received]_';
    }

    const entry = document.createElement('div');
    entry.className = `narrative-entry ${isPlayer ? 'player' : ''}`;

    if (isPlayer) {
        entry.innerHTML = `<p>${escapeHtml(text)}</p>`;
    } else {
        // Parse markdown output from AI
        try {
            entry.innerHTML = marked.parse(text);
        } catch (e) {
            console.error('[addNarrativeEntry] Markdown parse error:', e);
            entry.innerHTML = `<p>${text}</p>`;
        }
    }

    display.appendChild(entry);
    display.scrollTop = display.scrollHeight;
}

/**
 * Update the debug HUD
 */
function updateDebugHUD(result) {
    // Safe update helper - silently skip if element doesn't exist
    const safeUpdate = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };

    safeUpdate('dbg-intent', result.intent.intent);
    safeUpdate('dbg-epicness', result.intent.declared_epicness.toFixed(2));
    safeUpdate('dbg-outcome', result.outcome.success_level);
    safeUpdate('dbg-weight', result.outcome.narrative_weight);
    safeUpdate('dbg-latency', `${result.latency_ms}ms`);
}

/**
 * Load and display current context
 */
async function loadContext() {
    try {
        const context = await API.Game.getContext();

        // Skip if context panel doesn't exist
        if (!document.getElementById('ctx-profile')) return;

        document.getElementById('ctx-profile').textContent = context.profile_name;
        document.getElementById('ctx-location').textContent = context.location;
        document.getElementById('ctx-character').textContent = context.character_name;
        document.getElementById('ctx-arc').textContent = `${context.arc_phase} (${(context.tension_level * 100).toFixed(0)}%)`;
    } catch (error) {
        console.error('Failed to load context:', error);
    }
}

/**
 * Setup settings page interactions
 */
function setupSettingsPage() {
    const saveModelsBtn = document.getElementById('save-models');
    const resetBtn = document.getElementById('reset-settings');
    const providerSelects = document.querySelectorAll('.provider-select');
    const saveKeyBtns = document.querySelectorAll('.save-key-btn');

    // Tab switching
    const tabs = document.querySelectorAll('.settings-tab');
    const tabContents = document.querySelectorAll('.settings-tab-content');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetTab = tab.dataset.tab;

            // Update tab buttons
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            // Update tab content
            tabContents.forEach(content => {
                content.classList.remove('active');
                if (content.id === `${targetTab}-settings`) {
                    content.classList.add('active');
                }
            });
        });
    });

    // Basic Settings: Update model options when provider changes
    ['fast', 'creative', 'thinking'].forEach(category => {
        const providerSelect = document.getElementById(`${category}-provider`);
        const modelSelect = document.getElementById(`${category}-model`);

        if (providerSelect && modelSelect) {
            providerSelect.addEventListener('change', () => {
                updateBasicModelOptions(category, providerSelect.value);
            });
        }
    });

    // Save model configuration
    if (saveModelsBtn) {
        saveModelsBtn.addEventListener('click', () => {
            saveAdvancedSettings();
        });
    }

    // Reset settings
    if (resetBtn) {
        resetBtn.addEventListener('click', async () => {
            try {
                await API.Settings.reset();
                await loadSettings();
                showStatus('Settings reset to defaults', 'success');
            } catch (error) {
                showStatus(`Error: ${error.message}`, 'error');
            }
        });
    }

    // Update model options when provider changes (for agent-specific selects)
    providerSelects.forEach(select => {
        if (select.dataset.agent) {
            select.addEventListener('change', () => {
                updateModelOptions(select.dataset.agent, select.value);
            });
        }
    });

    // API key save buttons
    saveKeyBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
            const provider = btn.dataset.provider;
            const input = document.getElementById(`${provider}-key-input`);
            const key = input.value.trim();

            if (!key) {
                showStatus('Please enter an API key', 'error');
                return;
            }

            try {
                btn.disabled = true;
                btn.textContent = '...';
                await API.Settings.setKey(provider, key);
                input.value = '';
                await loadApiKeys();
                showStatus(`${provider.charAt(0).toUpperCase() + provider.slice(1)} API key saved!`, 'success');
            } catch (error) {
                showStatus(`Error: ${error.message}`, 'error');
            } finally {
                btn.disabled = false;
                btn.textContent = 'Save';
            }
        });
    });

    // API key clear buttons
    const clearKeyBtns = document.querySelectorAll('.clear-key-btn');
    clearKeyBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
            const provider = btn.dataset.provider;

            if (!confirm(`Are you sure you want to clear the ${provider} API key?`)) {
                return;
            }

            try {
                btn.disabled = true;
                await API.Settings.setKey(provider, '');  // Clear by setting empty string
                await loadApiKeys();
                showStatus(`${provider.charAt(0).toUpperCase() + provider.slice(1)} API key cleared!`, 'success');
            } catch (error) {
                showStatus(`Error: ${error.message}`, 'error');
            } finally {
                btn.disabled = false;
            }
        });
    });

    // Extended thinking toggle - auto-save on change
    const extendedThinkingToggle = document.getElementById('extended-thinking-toggle');
    if (extendedThinkingToggle) {
        extendedThinkingToggle.addEventListener('change', async () => {
            try {
                // Get current settings, update extended_thinking, save
                const settings = await API.Settings.get();
                settings.extended_thinking = extendedThinkingToggle.checked;
                await API.Settings.update(settings);
                showStatus(`Extended thinking ${extendedThinkingToggle.checked ? 'enabled' : 'disabled'}`, 'success');
            } catch (error) {
                showStatus(`Error: ${error.message}`, 'error');
                // Revert toggle on error
                extendedThinkingToggle.checked = !extendedThinkingToggle.checked;
            }
        });
    }
}

/**
 * Load settings and populate UI
 */
async function loadSettings() {
    try {
        // Load available models
        const modelsResponse = await API.Settings.getModels();
        modelsCache = modelsResponse.models;

        // Load current settings
        const settings = await API.Settings.get();
        const agentModels = settings.agent_models || {};

        // Default configs (for base defaults when not configured)
        const FAST_DEFAULT = { provider: 'google', model: 'gemini-3-flash-preview' };
        const CREATIVE_DEFAULT = { provider: 'google', model: 'gemini-3-pro-preview' };

        // === SETTINGS ===
        // Base defaults (these MUST have a value - default to Google if not set)
        populateAgentSetting('base_fast', agentModels.base_fast || FAST_DEFAULT);
        populateAgentSetting('base_thinking', agentModels.base_thinking || CREATIVE_DEFAULT);
        populateAgentSetting('base_creative', agentModels.base_creative || CREATIVE_DEFAULT);

        // Per-agent overrides (null = Use Base Default)
        // Core agents
        populateAgentSetting('intent_classifier', agentModels.intent_classifier);
        populateAgentSetting('outcome_judge', agentModels.outcome_judge);
        populateAgentSetting('key_animator', agentModels.key_animator);

        // Director layer
        populateAgentSetting('director', agentModels.director);
        populateAgentSetting('research', agentModels.research);
        populateAgentSetting('scope', agentModels.scope);

        // Validation & Memory
        populateAgentSetting('validator', agentModels.validator);
        populateAgentSetting('memory_ranker', agentModels.memory_ranker);
        populateAgentSetting('context_selector', agentModels.context_selector);

        // Judgment agents
        populateAgentSetting('combat', agentModels.combat);
        populateAgentSetting('progression', agentModels.progression);
        populateAgentSetting('scale_selector', agentModels.scale_selector);
        populateAgentSetting('npc_reaction', agentModels.npc_reaction);
        populateAgentSetting('sakuga', agentModels.sakuga);
        populateAgentSetting('calibration', agentModels.calibration);

        // NPC Intelligence
        populateAgentSetting('relationship_analyzer', agentModels.relationship_analyzer);

        // Session Zero
        populateAgentSetting('session_zero', agentModels.session_zero);

        // World Building
        populateAgentSetting('world_builder', agentModels.world_builder);

        // Wiki Scraping
        populateAgentSetting('wiki_scout', agentModels.wiki_scout);

        // Extended thinking toggle
        const extendedThinkingToggle = document.getElementById('extended-thinking-toggle');
        if (extendedThinkingToggle) {
            extendedThinkingToggle.checked = settings.extended_thinking || false;
        }

        // Load API keys
        await loadApiKeys();

        // Check for provider misconfigurations
        await checkProviderWarnings();
    } catch (error) {
        console.error('Failed to load settings:', error);
    }
}

/**
 * Load and display API key status
 */
async function loadApiKeys() {
    try {
        const keys = await API.Settings.getKeys();

        ['google', 'anthropic', 'openai'].forEach(provider => {
            const status = keys[provider];
            const badge = document.getElementById(`${provider}-status`);
            const masked = document.getElementById(`${provider}-masked`);

            if (status.configured) {
                badge.textContent = 'Configured';
                badge.classList.add('configured');
                masked.textContent = status.masked;
            } else {
                badge.textContent = 'Not configured';
                badge.classList.remove('configured');
                masked.textContent = '';
            }
        });
    } catch (error) {
        console.error('Failed to load API keys:', error);
    }
}

/**
 * Check for provider misconfigurations and display warnings
 */
async function checkProviderWarnings() {
    try {
        const response = await fetch('/api/settings/validate');
        if (!response.ok) throw new Error('Failed to validate settings');

        const data = await response.json();
        const container = document.getElementById('provider-warnings');

        if (!container) return;

        if (data.warnings && data.warnings.length > 0) {
            // Build warning HTML
            let html = '';
            for (const warning of data.warnings) {
                html += `
                    <div class="provider-warning-item">
                        <span class="provider-warning-icon">⚠️</span>
                        <div class="provider-warning-content">
                            <div class="provider-warning-title">No API key for ${warning.selected_provider}</div>
                            <div class="provider-warning-message">${warning.message}</div>
                            <div class="provider-warning-actions">
                                <button class="btn-small" onclick="document.getElementById('${warning.selected_provider}-key-input').focus(); document.getElementById('${warning.selected_provider}-key-input').scrollIntoView({behavior: 'smooth', block: 'center'});">Add Key</button>
                            </div>
                        </div>
                    </div>
                `;
            }
            container.innerHTML = html;
            container.style.display = 'block';
        } else {
            container.innerHTML = '';
            container.style.display = 'none';
        }
    } catch (error) {
        console.error('Failed to check provider warnings:', error);
    }
}

/**
 * Populate a single agent's settings
 */
function populateAgentSetting(agentName, config) {
    const providerSelect = document.querySelector(`.provider-select[data-agent="${agentName}"]`);
    const modelSelect = document.querySelector(`.model-select[data-agent="${agentName}"]`);

    if (!providerSelect || !modelSelect) return;

    // Check if this is a base default (which must have a value) or a per-agent override (can be blank)
    const isBaseDefault = agentName === 'base_fast' || agentName === 'base_thinking' || agentName === 'base_creative';

    // For per-agent overrides, add blank option to provider if not already there
    if (!isBaseDefault && !providerSelect.querySelector('option[value=""]')) {
        const blankOption = document.createElement('option');
        blankOption.value = '';
        blankOption.textContent = '';
        providerSelect.insertBefore(blankOption, providerSelect.firstChild);
    }

    // Set provider (blank if config is null for per-agent overrides, google for base defaults)
    const provider = config?.provider || (isBaseDefault ? 'google' : '');
    providerSelect.value = provider;

    // Update model options for this provider (empty dropdown if provider is blank)
    updateModelOptions(agentName, provider);

    // Set model (only if we have a model to set)
    const model = config?.model || '';
    if (model && modelSelect.options.length > 0) {
        modelSelect.value = model;
    }

    // If value didn't match any option, ensure first option is selected
    if (modelSelect.options.length > 0 && modelSelect.selectedIndex === -1) {
        modelSelect.selectedIndex = 0;
    }
}

/**
 * Update model dropdown options for an agent
 */
function updateModelOptions(agentName, provider) {
    const modelSelect = document.querySelector(`.model-select[data-agent="${agentName}"]`);
    if (!modelSelect || !modelsCache) return;

    // Base defaults (base_fast, base_thinking, base_creative) don't get the "Use Base Default" option
    const isBaseDefault = agentName === 'base_fast' || agentName === 'base_thinking' || agentName === 'base_creative';

    // If provider is blank (per-agent override using base default), show only "(Use Base Default)"
    if (!provider && !isBaseDefault) {
        modelSelect.innerHTML = '<option value="">(Use Base Default)</option>';
        return;
    }

    const models = modelsCache[provider] || modelsCache['google'] || [];

    let optionsHtml = '';
    if (!isBaseDefault) {
        // Add "Use Base Default" as first option for per-agent overrides
        optionsHtml = '<option value="">(Use Base Default)</option>';
    }

    optionsHtml += models.map(m =>
        `<option value="${m.id}">${m.name} (${m.tier})</option>`
    ).join('');

    modelSelect.innerHTML = optionsHtml;
}

/**
 * Update model dropdown for basic settings categories
 */
function updateBasicModelOptions(category, provider) {
    const modelSelect = document.getElementById(`${category}-model`);
    if (!modelSelect || !modelsCache) return;

    const models = modelsCache[provider] || [];

    // Filter by tier based on category
    let filteredModels = models;
    if (category === 'fast') {
        filteredModels = models.filter(m => m.tier === 'fast' || models.length <= 2);
    } else if (category === 'creative' || category === 'thinking') {
        filteredModels = models.filter(m => m.tier === 'creative' || m.tier === 'premium' || models.length <= 2);
    }

    // If filter results in empty, use all models
    if (filteredModels.length === 0) filteredModels = models;

    modelSelect.innerHTML = filteredModels.map(m =>
        `<option value="${m.id}">${m.name} (${m.tier})</option>`
    ).join('');
}

/**
 * Apply basic settings to all agents
 */
async function applyBasicSettings() {
    const saveBtn = document.getElementById('save-models');
    const originalText = saveBtn.textContent;

    try {
        saveBtn.disabled = true;
        saveBtn.textContent = '⏳ Saving...';

        // Get basic settings values
        const fastProvider = document.getElementById('fast-provider').value;
        const fastModel = document.getElementById('fast-model').value;
        const creativeProvider = document.getElementById('creative-provider').value;
        const creativeModel = document.getElementById('creative-model').value;
        const thinkingProvider = document.getElementById('thinking-provider').value;
        const thinkingModel = document.getElementById('thinking-model').value;

        const extendedThinkingToggle = document.getElementById('extended-thinking-toggle');

        // Build settings object mapping agents to their categories
        const fastAgents = ['intent_classifier', 'outcome_judge', 'validator', 'combat', 'progression',
            'scale_selector', 'npc_reaction', 'sakuga', 'memory_ranker', 'context_selector', 'relationship_analyzer', 'scope'];
        const creativeAgents = ['key_animator', 'calibration'];
        const thinkingAgents = ['director', 'research'];

        const agent_models = {
            // Base defaults (used by fallback for unconfigured agents)
            base_fast: { provider: fastProvider, model: fastModel },
            base_thinking: { provider: thinkingProvider, model: thinkingModel },
        };

        fastAgents.forEach(agent => {
            agent_models[agent] = { provider: fastProvider, model: fastModel };
        });
        creativeAgents.forEach(agent => {
            agent_models[agent] = { provider: creativeProvider, model: creativeModel };
        });
        thinkingAgents.forEach(agent => {
            agent_models[agent] = { provider: thinkingProvider, model: thinkingModel };
        });

        const settings = {
            agent_models,
            debug_mode: true,
            active_profile_id: 'hunterxhunter',
            extended_thinking: extendedThinkingToggle?.checked || false,
        };

        await API.Settings.update(settings);

        // Reload to sync advanced tab
        await loadSettings();

        // Show success
        saveBtn.textContent = '✓ Saved!';
        saveBtn.style.background = 'linear-gradient(135deg, #28a745, #20c997)';

        setTimeout(() => {
            saveBtn.textContent = originalText;
            saveBtn.style.background = '';
            saveBtn.disabled = false;
        }, 1500);

    } catch (error) {
        saveBtn.textContent = '❌ Error';
        setTimeout(() => {
            saveBtn.textContent = originalText;
            saveBtn.disabled = false;
        }, 2000);
        showStatus(`Error: ${error.message}`, 'error');
    }
}

/**
 * Save advanced per-agent settings
 */
async function saveAdvancedSettings() {
    const saveBtn = document.getElementById('save-models');
    const originalText = saveBtn.textContent;

    try {
        saveBtn.disabled = true;
        saveBtn.textContent = '⏳ Saving...';

        const extendedThinkingToggle = document.getElementById('extended-thinking-toggle');

        const settings = {
            agent_models: {
                // Base defaults
                base_fast: getAgentConfig('base_fast'),
                base_thinking: getAgentConfig('base_thinking'),
                base_creative: getAgentConfig('base_creative'),
                // Core agents
                intent_classifier: getAgentConfig('intent_classifier'),
                outcome_judge: getAgentConfig('outcome_judge'),
                key_animator: getAgentConfig('key_animator'),
                // Director layer
                director: getAgentConfig('director'),
                research: getAgentConfig('research'),
                scope: getAgentConfig('scope'),
                // Validation & Memory
                validator: getAgentConfig('validator'),
                memory_ranker: getAgentConfig('memory_ranker'),
                context_selector: getAgentConfig('context_selector'),
                // Judgment agents
                combat: getAgentConfig('combat'),
                progression: getAgentConfig('progression'),
                scale_selector: getAgentConfig('scale_selector'),
                npc_reaction: getAgentConfig('npc_reaction'),
                sakuga: getAgentConfig('sakuga'),
                calibration: getAgentConfig('calibration'),
                // NPC Intelligence
                relationship_analyzer: getAgentConfig('relationship_analyzer'),
                // Session Zero
                session_zero: getAgentConfig('session_zero'),
                // World Building
                world_builder: getAgentConfig('world_builder'),
                // Wiki Scraping
                wiki_scout: getAgentConfig('wiki_scout'),
            },
            debug_mode: true,
            active_profile_id: 'hunterxhunter',
            extended_thinking: extendedThinkingToggle?.checked || false,
        };

        await API.Settings.update(settings);

        // Show success on button
        saveBtn.textContent = '✓ Saved!';
        saveBtn.style.background = 'linear-gradient(135deg, #28a745, #20c997)';

        // Revert after delay
        setTimeout(() => {
            saveBtn.textContent = originalText;
            saveBtn.style.background = '';
            saveBtn.disabled = false;
        }, 1500);

    } catch (error) {
        saveBtn.textContent = '❌ Error';
        setTimeout(() => {
            saveBtn.textContent = originalText;
            saveBtn.disabled = false;
        }, 2000);
        showStatus(`Error: ${error.message}`, 'error');
    }
}

/**
 * Get config for a single agent from UI
 * Returns null if "Use Base Default" is selected (empty model value)
 */
function getAgentConfig(agentName) {
    const providerSelect = document.querySelector(`.provider-select[data-agent="${agentName}"]`);
    const modelSelect = document.querySelector(`.model-select[data-agent="${agentName}"]`);

    const model = modelSelect?.value || '';

    // If model is empty, agent should use base default (return null)
    if (!model) {
        return null;
    }

    return {
        provider: providerSelect?.value || 'google',
        model: model,
    };
}

/**
 * Show status message
 */
function showStatus(message, type) {
    const status = document.getElementById('settings-status');
    status.textContent = message;
    status.className = `status-message ${type}`;

    setTimeout(() => {
        status.textContent = '';
        status.className = 'status-message';
    }, 3000);
}

/**
 * Escape HTML for safe display
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// === NEW: Sidebar Functions ===

/**
 * Toggle collapsible section
 */
function toggleSection(sectionName) {
    const section = document.querySelector(`[data-section="${sectionName}"]`);
    if (!section) return;

    const content = section.querySelector('.section-content');
    const icon = section.querySelector('.collapse-icon');

    if (section.classList.contains('collapsed')) {
        section.classList.remove('collapsed');
        content.style.display = 'block';
        icon.textContent = '▼';
    } else {
        section.classList.add('collapsed');
        content.style.display = 'none';
        icon.textContent = '▶';
    }
}

/**
 * Load character status from API
 */
async function loadCharacterStatus() {
    try {
        const data = await API.apiRequest('/game/character-status');
        if (!data) return;

        // Early return if sidebar elements don't exist (Session Zero mode)
        if (!document.getElementById('char-name')) return;

        // Update character info
        document.getElementById('char-name').textContent = data.name || 'Unknown';
        document.getElementById('char-level').textContent = data.level || 1;
        document.getElementById('char-class').textContent = data.character_class || 'Adventurer';

        // Update HP bar
        const hpPercent = (data.hp_current / data.hp_max) * 100;
        document.getElementById('hp-fill').style.width = `${hpPercent}%`;
        document.getElementById('hp-current').textContent = data.hp_current;
        document.getElementById('hp-max').textContent = data.hp_max;

        // Update MP bar
        const mpPercent = (data.mp_current / data.mp_max) * 100;
        document.getElementById('mp-fill').style.width = `${mpPercent}%`;
        document.getElementById('mp-current').textContent = data.mp_current;
        document.getElementById('mp-max').textContent = data.mp_max;

        // Update SP bar
        const spPercent = (data.sp_current / data.sp_max) * 100;
        document.getElementById('sp-fill').style.width = `${spPercent}%`;
        document.getElementById('sp-current').textContent = data.sp_current;
        document.getElementById('sp-max').textContent = data.sp_max;

        // Update XP bar
        const xpPercent = (data.xp_current / data.xp_to_next) * 100;
        document.getElementById('xp-fill').style.width = `${Math.min(xpPercent, 100)}%`;
        document.getElementById('xp-current').textContent = data.xp_current;
        document.getElementById('xp-max').textContent = data.xp_to_next;

        // Update stats grid
        const statsGrid = document.getElementById('stats-grid');
        statsGrid.innerHTML = '';
        if (data.stats && typeof data.stats === 'object') {
            for (const [name, value] of Object.entries(data.stats)) {
                statsGrid.innerHTML += `
                    <div class="stat-item">
                        <span class="stat-name">${name}</span>
                        <span class="stat-value">${value}</span>
                    </div>
                `;
            }
        }

        // Update power tier
        const powerTier = document.getElementById('power-tier');
        if (powerTier) powerTier.textContent = data.power_tier || 'T10';

    } catch (e) {
        console.log('[Sidebar] Character status not available:', e.message);
    }
}

/**
 * Load NPCs from API
 */
async function loadNPCs() {
    try {
        const data = await API.apiRequest('/game/npcs');
        const container = document.getElementById('npc-list');

        if (!data || !data.npcs || data.npcs.length === 0) {
            container.innerHTML = '<div class="empty-state">No NPCs met yet</div>';
            return;
        }

        container.innerHTML = data.npcs.map(npc => {
            const role = npc.role || 'neutral';
            const affinityClass = npc.affinity >= 20 ? 'positive' : (npc.affinity <= -20 ? 'negative' : 'neutral');
            const affinitySign = npc.affinity >= 0 ? '+' : '';

            return `
                <div class="npc-item">
                    <span class="npc-indicator ${role}"></span>
                    <span class="npc-name">${escapeHtml(npc.name)}</span>
                    <span class="npc-role">(${role})</span>
                    <span class="npc-affinity ${affinityClass}">${affinitySign}${npc.affinity}</span>
                </div>
            `;
        }).join('');

    } catch (e) {
        console.log('[Sidebar] NPCs not available:', e.message);
    }
}

/**
 * Load factions from API
 */
async function loadFactions() {
    try {
        const data = await API.apiRequest('/game/factions');
        const container = document.getElementById('faction-list');

        if (!data || !data.factions || data.factions.length === 0) {
            container.innerHTML = '<div class="empty-state">No factions known</div>';
            return;
        }

        container.innerHTML = data.factions.map(faction => {
            return `
                <div class="faction-item">
                    <span class="faction-name">${escapeHtml(faction.name)}</span>
                    <span class="faction-standing ${faction.relationship_to_pc}">${faction.relationship_to_pc}</span>
                </div>
            `;
        }).join('');

    } catch (e) {
        console.log('[Sidebar] Factions not available:', e.message);
    }
}

/**
 * Load quests from API
 */
async function loadQuests() {
    try {
        const data = await API.apiRequest('/game/quests');
        const container = document.getElementById('quest-list');

        if (!data || !data.quests || data.quests.length === 0) {
            container.innerHTML = '<div class="empty-state">No active quests</div>';
            return;
        }

        container.innerHTML = data.quests.map(quest => {
            return `
                <div class="quest-item">
                    <span class="quest-name">• ${escapeHtml(quest.name)}</span>
                    <span class="quest-status ${quest.status}">${quest.status}</span>
                </div>
            `;
        }).join('');

    } catch (e) {
        console.log('[Sidebar] Quests not available:', e.message);
    }
}

/**
 * Load all sidebar trackers
 */
async function loadAllTrackers() {
    // Only load if we're in gameplay mode
    if (isSessionZero) return;

    await Promise.all([
        loadCharacterStatus(),
        loadNPCs(),
        loadFactions(),
        loadQuests()
    ]);
}

/**
 * Save current session to downloadable file
 */
async function saveSession() {
    const btn = document.getElementById('save-session-btn');
    const originalText = btn.textContent;

    try {
        btn.textContent = '⏳ Saving...';
        btn.disabled = true;

        await API.Game.exportSession();

        btn.textContent = '✅ Saved!';
        setTimeout(() => {
            btn.textContent = originalText;
            btn.disabled = false;
        }, 2000);
    } catch (e) {
        console.error('Save failed:', e);
        btn.textContent = '❌ ' + e.message;
        setTimeout(() => {
            btn.textContent = originalText;
            btn.disabled = false;
        }, 3000);
    }
}

/**
 * Load session from uploaded file
 */
async function loadSession(file) {
    if (!file) return;

    if (!confirm('This will replace your current session. Continue?')) {
        document.getElementById('load-file-input').value = '';
        return;
    }

    const btn = document.getElementById('load-session-btn');
    const originalText = btn.textContent;

    try {
        btn.textContent = '⏳ Loading...';
        btn.disabled = true;

        await API.Game.importSession(file);

        btn.textContent = '✅ Loaded!';

        // Reload the page to pick up new session
        setTimeout(() => {
            window.location.reload();
        }, 1000);
    } catch (e) {
        console.error('Load failed:', e);
        btn.textContent = '❌ ' + e.message;
        setTimeout(() => {
            btn.textContent = originalText;
            btn.disabled = false;
        }, 3000);
    } finally {
        document.getElementById('load-file-input').value = '';
    }
}

/**
 * Reset session (clear all data, start fresh)
 */
async function resetSession() {
    if (!confirm('This will delete ALL session data and start fresh. This cannot be undone!\n\nContinue?')) {
        return;
    }

    const btn = document.getElementById('reset-session-btn');
    const originalText = btn.textContent;

    try {
        btn.textContent = '⏳ Resetting...';
        btn.disabled = true;

        await API.Game.reset();

        btn.textContent = '✅ Reset Complete!';

        // Reload the page to start fresh
        setTimeout(() => {
            window.location.reload();
        }, 1000);
    } catch (e) {
        console.error('Reset failed:', e);
        btn.textContent = '❌ ' + e.message;
        setTimeout(() => {
            btn.textContent = originalText;
            btn.disabled = false;
        }, 3000);
    }
}

// Initialize on load
document.addEventListener('DOMContentLoaded', init);
