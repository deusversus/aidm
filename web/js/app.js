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

            // Load data for the page
            loadPageData(pageName);
        });
    });
}

/**
 * Load data for a specific page on navigation
 */
function loadPageData(pageName) {
    switch (pageName) {
        case 'inventory': loadInventory(); break;
        case 'skills': loadAbilities(); break;
        case 'journal': loadJournal(); break;
        case 'map': loadLocations(); break;
        case 'quests': loadQuests(); break;
    }
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
                isSessionZero = (resumed.phase || '').toLowerCase() !== 'gameplay';

                // Replay messages — backend annotates each with turn_number
                display.innerHTML = '';
                const pMaps = resumed.portrait_maps || {};
                const fallbackMap = pMaps["-1"] || pMaps[-1] || null;  // Python int -1 → JSON string "-1"

                for (const msg of resumed.messages) {
                    // Skip sentinel messages
                    if (msg.role === 'user' && msg.content?.trim() === '[BEGIN]') continue;
                    if (msg.role === 'user' && msg.content?.trim() === '[opening scene — the story begins]') continue;

                    const turnNum = msg.turn_number ?? 0;
                    const isPlayer = msg.role === 'user';
                    const turnMap = !isPlayer ? (pMaps[turnNum] || fallbackMap) : null;
                    addNarrativeEntry(msg.content, isPlayer, turnMap, turnNum);
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

                // Load sidebar data and media for gameplay sessions
                if (!isSessionZero) {
                    console.log('[DEBUG] Resume: isSessionZero is false, calling loadAllTrackers');
                    loadContext().catch(e => console.warn('[Resume] Context load failed:', e));
                    loadAllTrackers().catch(e => console.warn('[Resume] Tracker load failed:', e));

                    // Re-inject cutscene media at correct turn positions
                    if (resumed.campaign_media_uuid) {
                        reloadAllMedia(resumed.campaign_media_uuid, resumed.turn_number || 0)
                            .catch(e => console.warn('[Resume] Media reload failed:', e));
                    }
                }

                return;
            }
        } catch (e) {
            console.log('[Session] Could not resume, starting fresh:', e.message);
            localStorage.removeItem('aidm_session_id');
        }
    }

    // No saved session or resume failed - check server for latest session before starting fresh
    try {
        const latest = await API.Game.getLatestSession();
        if (latest && latest.session_id) {
            console.log('[Session] Found latest session on server, resuming:', latest.session_id);
            localStorage.setItem('aidm_session_id', latest.session_id);
            API.Game.currentSessionId = latest.session_id;
            return startSessionZero();
        }
    } catch (e) {
        console.log('[Session] No latest session found, starting fresh:', e.message);
    }

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

                // Check for multi-title array (franchise-entry detection)
                if (result.detected_info?.media_references && result.detected_info.media_references.length > 1) {
                    animeName = result.detected_info.media_references.join(', ');
                }
                // Check for hybrid blend (v3.2)
                else if (result.detected_info?.blend_sources && result.detected_info.blend_sources.length > 1) {
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

            // Check if we've transitioned to gameplay
            console.log('[Handoff] Checking transition - phase:', result.phase, 'ready_for_gameplay:', result.ready_for_gameplay);
            const isHandoff = (result.phase || '').toLowerCase() === 'gameplay' || result.ready_for_gameplay;

            // Show closing message only if this is NOT a handoff (on handoff, opening scene replaces it)
            if (!isHandoff) {
                addNarrativeEntry(result.response, false);
            }

            // Update context panel with phase
            const ctxArcTurn = document.getElementById('ctx-arc');
            if (ctxArcTurn) ctxArcTurn.textContent = `Session Zero: ${result.phase}`;

            // Update sidebar profile (for cached profiles that don't trigger research progress)
            if (result.character_draft?.media_reference) {
                const profileEl = document.getElementById('ctx-profile');
                if (profileEl) profileEl.textContent = result.character_draft.media_reference;
            }

            if (isHandoff) {
                isSessionZero = false;
                console.log('[Handoff] Transition confirmed! Phase:', result.phase, 'ready_for_gameplay:', result.ready_for_gameplay);

                // Display the server-side stitched opening scene (no reload needed)
                if (result.opening_scene) {
                    // Insert scene break divider
                    const divider = document.createElement('div');
                    divider.className = 'scene-break';
                    divider.innerHTML = '<span>— The Adventure Begins —</span>';
                    document.getElementById('narrative-display').appendChild(divider);

                    addNarrativeEntry(result.opening_scene, false, result.opening_portrait_map);
                    console.log('[Handoff] Opening scene displayed inline (' + result.opening_scene.length + ' chars)');
                }

                // Show handoff warnings (gap follow-up prompt or non-blocking notices)
                if (result.gap_follow_up_prompt) {
                    const followUpEl = document.createElement('div');
                    followUpEl.className = 'handoff-followup';
                    followUpEl.innerHTML = `<span class="handoff-followup-icon">📝</span><span>${escapeHtml(result.gap_follow_up_prompt)}</span>`;
                    document.getElementById('narrative-display').appendChild(followUpEl);
                } else if (result.handoff_warnings && result.handoff_warnings.length > 0 && result.handoff_status === 'degraded') {
                    const warningsEl = document.createElement('div');
                    warningsEl.className = 'handoff-warnings';
                    warningsEl.innerHTML = '<span class="handoff-warnings-icon">ℹ️</span><ul>' +
                        result.handoff_warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('') +
                        '</ul>';
                    document.getElementById('narrative-display').appendChild(warningsEl);
                }
                if (result.compiler_task_id) {
                    console.log('[Handoff] Compiler task ID:', result.compiler_task_id, '| status:', result.handoff_status);
                }

                // Update context panel
                const ctxArcHandoff = document.getElementById('ctx-arc');
                if (ctxArcHandoff) ctxArcHandoff.textContent = 'Gameplay';

                // Load gameplay UI state
                try {
                    await loadContext();
                    await loadAllTrackers();
                } catch (e) {
                    console.warn('[Handoff] Tracker load failed (non-critical):', e);
                }
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

            addNarrativeEntry(text, false, result.portrait_map, result.turn_number);

            // Retroactively tag the user message entry we added earlier
            const allEntries = document.querySelectorAll('.narrative-entry');
            if (allEntries.length >= 2) {
                const userEntry = allEntries[allEntries.length - 2];
                if (userEntry && userEntry.classList.contains('player') && result.turn_number != null) {
                    userEntry.dataset.turn = result.turn_number;
                }
            }
            updateDebugHUD(result);
            // Run independently — loadContext failure must not block sidebar
            loadContext().catch(e => console.warn('[Turn] Context load failed:', e));
            loadAllTrackers().catch(e => console.warn('[Turn] Tracker load failed:', e));

            // Start media polling if turn_number + media UUID provided
            const mediaId = result.campaign_media_uuid || result.campaign_id;
            if (result.turn_number != null && mediaId != null) {
                pollForTurnMedia(mediaId, result.turn_number);
                // On first gameplay turn, also poll for turn 0 media (handoff cutscenes)
                if (result.turn_number === 1) {
                    pollForTurnMedia(mediaId, 0);
                }
                // Poll for non-turn media (portraits, models, locations)
                pollForLatestMedia(mediaId);
            }
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
function addNarrativeEntry(text, isPlayer, portraitMap, turnNumber) {
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

    // Tag with turn number for media threading
    if (turnNumber != null) {
        entry.dataset.turn = turnNumber;
    }

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

        // Inject portrait chips next to NPC names if portrait_map is provided
        if (portraitMap && Object.keys(portraitMap).length > 0) {
            const strongElements = entry.querySelectorAll('strong');
            strongElements.forEach(el => {
                const name = el.textContent.trim();
                if (portraitMap[name]) {
                    const chip = document.createElement('img');
                    chip.className = 'npc-portrait-chip';
                    chip.src = portraitMap[name];
                    chip.alt = name;
                    chip.title = name;
                    chip.onerror = () => chip.remove();  // Remove if image fails to load
                    el.parentNode.insertBefore(chip, el);
                }
            });
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

    // Media generation toggle - auto-save on change
    const mediaEnabledToggle = document.getElementById('media-enabled-toggle');
    if (mediaEnabledToggle) {
        mediaEnabledToggle.addEventListener('change', async () => {
            try {
                const settings = await API.Settings.get();
                settings.media_enabled = mediaEnabledToggle.checked;
                await API.Settings.update(settings);
                showStatus(`Media generation ${mediaEnabledToggle.checked ? 'enabled' : 'disabled'}`, 'success');
            } catch (error) {
                showStatus(`Error: ${error.message}`, 'error');
                mediaEnabledToggle.checked = !mediaEnabledToggle.checked;
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
        const CREATIVE_DEFAULT = { provider: 'google', model: 'gemini-3.1-pro-preview' };

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

        // Judgment agents
        populateAgentSetting('combat', agentModels.combat);
        populateAgentSetting('progression', agentModels.progression);
        populateAgentSetting('scale_selector', agentModels.scale_selector);

        // NPC Intelligence
        populateAgentSetting('relationship_analyzer', agentModels.relationship_analyzer);

        // Session Zero & Profile
        populateAgentSetting('session_zero', agentModels.session_zero);
        populateAgentSetting('profile_merge', agentModels.profile_merge);

        // Session Zero Compiler
        populateAgentSetting('sz_extractor', agentModels.sz_extractor);
        populateAgentSetting('sz_entity_resolver', agentModels.sz_entity_resolver);
        populateAgentSetting('sz_gap_analyzer', agentModels.sz_gap_analyzer);
        populateAgentSetting('sz_handoff', agentModels.sz_handoff);

        // World Building & Research Support
        populateAgentSetting('world_builder', agentModels.world_builder);
        populateAgentSetting('wiki_scout', agentModels.wiki_scout);
        populateAgentSetting('compactor', agentModels.compactor);

        // Narrative Pacing
        populateAgentSetting('pacing', agentModels.pacing);
        populateAgentSetting('recap', agentModels.recap);

        // Post-Narrative Production
        populateAgentSetting('production', agentModels.production);
        populateAgentSetting('beat_extractor', agentModels.beat_extractor);

        // Intent Resolution
        populateAgentSetting('intent_resolution', agentModels.intent_resolution);

        // Extended thinking toggle
        const extendedThinkingToggle = document.getElementById('extended-thinking-toggle');
        if (extendedThinkingToggle) {
            extendedThinkingToggle.checked = settings.extended_thinking || false;
        }

        // Media generation settings
        const mediaToggle = document.getElementById('media-enabled-toggle');
        if (mediaToggle) {
            mediaToggle.checked = settings.media_enabled || false;
        }
        const mediaBudget = document.getElementById('media-budget');
        if (mediaBudget) {
            mediaBudget.value = settings.media_budget_per_session_usd || 2.00;
        }
        const mediaBudgetToggle = document.getElementById('media-budget-toggle');
        if (mediaBudgetToggle) {
            mediaBudgetToggle.checked = settings.media_budget_enabled || false;
            const budgetAmount = document.getElementById('media-budget-amount');
            if (budgetAmount) budgetAmount.style.display = mediaBudgetToggle.checked ? 'flex' : 'none';
        }
        const mediaImageModel = document.getElementById('media-image-model');
        if (mediaImageModel) {
            mediaImageModel.textContent = settings.media_image_model || 'gemini-3-pro-image-preview';
        }
        const mediaVideoModel = document.getElementById('media-video-model');
        if (mediaVideoModel) {
            mediaVideoModel.textContent = settings.media_video_model || 'veo-3.1-generate-preview';
        }
        const mediaAutoplay = document.getElementById('media-autoplay-toggle');
        if (mediaAutoplay) {
            mediaAutoplay.checked = settings.media_auto_play !== false;  // default true
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

        // Copilot connection status
        const copilotStatus = keys.copilot;
        if (copilotStatus) {
            const badge = document.getElementById('copilot-status');
            const masked = document.getElementById('copilot-masked');
            const connectBtn = document.getElementById('copilot-connect-btn');
            const disconnectBtn = document.getElementById('copilot-disconnect-btn');
            const expiryWarning = document.getElementById('copilot-expiry-warning');

            if (copilotStatus.configured) {
                if (badge) { badge.textContent = 'Connected'; badge.classList.add('configured'); }
                if (masked) masked.textContent = copilotStatus.masked;
                if (connectBtn) connectBtn.style.display = 'none';
                if (disconnectBtn) disconnectBtn.style.display = '';

                // Check token expiry and show proactive warning if needed
                try {
                    const health = await API.Settings.copilotStatus();
                    if (expiryWarning) {
                        if (health.is_expired) {
                            expiryWarning.textContent = 'GitHub authorization has expired — please reconnect.';
                            expiryWarning.style.display = '';
                            if (badge) { badge.textContent = 'Expired'; badge.classList.remove('configured'); }
                        } else if (health.is_expiring_soon) {
                            const mins = Math.round(health.remaining_seconds / 60);
                            expiryWarning.textContent = `GitHub authorization expires in ~${mins} min — reconnect soon to avoid interruption.`;
                            expiryWarning.style.display = '';
                        } else {
                            expiryWarning.style.display = 'none';
                        }
                    }
                } catch (_) { /* non-fatal */ }
            } else {
                if (badge) { badge.textContent = 'Not connected'; badge.classList.remove('configured'); }
                if (masked) masked.textContent = '';
                if (connectBtn) connectBtn.style.display = '';
                if (disconnectBtn) disconnectBtn.style.display = 'none';
                if (expiryWarning) expiryWarning.style.display = 'none';
            }
        }
    } catch (error) {
        console.error('Failed to load API keys:', error);
    }
}

/**
 * Check for provider misconfigurations and display warnings
 */
// ── GitHub Copilot OAuth ──────────────────────────────────────────────────────

let _copilotPollTimer = null;
let _copilotPollIntervalMs = 5000;  // tracks current poll interval, grows on slow_down

/**
 * Start the GitHub Copilot device OAuth flow and show the auth modal.
 */
async function connectCopilot() {
    const connectBtn = document.getElementById('copilot-connect-btn');
    if (connectBtn) { connectBtn.disabled = true; connectBtn.textContent = '⏳ Starting...'; }

    try {
        const data = await API.Settings.startCopilotAuth();

        // Fill the modal
        const modal = document.getElementById('copilot-auth-modal');
        const codeEl = document.getElementById('copilot-user-code');
        const urlEl = document.getElementById('copilot-verify-url');
        const msgEl = document.getElementById('copilot-auth-msg');

        if (codeEl) codeEl.textContent = data.user_code;
        if (urlEl) { urlEl.href = data.verification_uri; urlEl.textContent = data.verification_uri.replace('https://', ''); }
        if (msgEl) msgEl.textContent = 'Waiting for authorization...';
        if (modal) { modal.style.display = 'flex'; }

        // Use recursive setTimeout instead of setInterval so polls never overlap.
        // GitHub's device flow spec requires waiting for each response before
        // sending the next request — concurrent polls trigger slow_down errors.
        _copilotPollIntervalMs = Math.max((data.interval || 5) * 1000, 5000);
        _copilotPollTimer = setTimeout(_pollCopilotAuth, _copilotPollIntervalMs);

    } catch (err) {
        showStatus(`Copilot auth error: ${err.message}`, 'error');
    } finally {
        if (connectBtn) { connectBtn.disabled = false; connectBtn.textContent = '🔗 Connect with GitHub'; }
    }
}

async function _pollCopilotAuth() {
    _copilotPollTimer = null;  // timer has fired; we own control now
    try {
        const result = await API.Settings.pollCopilotAuth();

        if (result.status === 'pending') {
            // Honor GitHub's slow_down interval if the server relayed one
            if (result.next_interval) {
                _copilotPollIntervalMs = result.next_interval * 1000;
            }
            // Schedule next poll only AFTER this one is fully done (no overlap)
            _copilotPollTimer = setTimeout(_pollCopilotAuth, _copilotPollIntervalMs);
            return;
        }

        // Done (complete / expired / error) — timer not rescheduled, modal closes
        const modal = document.getElementById('copilot-auth-modal');
        if (modal) modal.style.display = 'none';

        if (result.status === 'complete') {
            await loadApiKeys();
            await loadSettings();
            showStatus('GitHub Copilot connected! Fetching available models...', 'success');
            // Background model fetch on the server takes ~5-15 s; refresh once more
            // so the dropdowns show the live model list without a manual page reload.
            setTimeout(async () => {
                await loadSettings();
                showStatus('GitHub Copilot connected!', 'success');
            }, 12000);
        } else {
            showStatus(`Copilot auth failed: ${result.message || result.status}`, 'error');
        }
    } catch (err) {
        const modal = document.getElementById('copilot-auth-modal');
        if (modal) modal.style.display = 'none';
        showStatus(`Copilot polling error: ${err.message}`, 'error');
    }
}

/**
 * Cancel the in-progress Copilot auth modal without disconnecting.
 */
function cancelCopilotAuth() {
    if (_copilotPollTimer) { clearTimeout(_copilotPollTimer); _copilotPollTimer = null; }
    const modal = document.getElementById('copilot-auth-modal');
    if (modal) modal.style.display = 'none';
}

/**
 * Disconnect GitHub Copilot.
 */
async function disconnectCopilot() {
    if (!confirm('Disconnect GitHub Copilot? You can reconnect at any time.')) return;
    try {
        await API.Settings.disconnectCopilot();
        await loadApiKeys();
        showStatus('GitHub Copilot disconnected.', 'success');
    } catch (err) {
        showStatus(`Error: ${err.message}`, 'error');
    }
}

// ─────────────────────────────────────────────────────────────────────────────

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
 * Save advanced per-agent settings
 */
async function saveAdvancedSettings() {
    const saveBtn = document.getElementById('save-models');
    const originalText = saveBtn.textContent;

    try {
        saveBtn.disabled = true;
        saveBtn.textContent = '⏳ Saving...';

        const extendedThinkingToggle = document.getElementById('extended-thinking-toggle');

        const mediaToggle = document.getElementById('media-enabled-toggle');
        const mediaBudget = document.getElementById('media-budget');

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
                // Judgment agents
                combat: getAgentConfig('combat'),
                progression: getAgentConfig('progression'),
                scale_selector: getAgentConfig('scale_selector'),
                // NPC Intelligence
                relationship_analyzer: getAgentConfig('relationship_analyzer'),
                // Session Zero & Profile
                session_zero: getAgentConfig('session_zero'),
                profile_merge: getAgentConfig('profile_merge'),
                // Session Zero Compiler
                sz_extractor: getAgentConfig('sz_extractor'),
                sz_entity_resolver: getAgentConfig('sz_entity_resolver'),
                sz_gap_analyzer: getAgentConfig('sz_gap_analyzer'),
                sz_handoff: getAgentConfig('sz_handoff'),
                // World Building & Research Support
                world_builder: getAgentConfig('world_builder'),
                wiki_scout: getAgentConfig('wiki_scout'),
                compactor: getAgentConfig('compactor'),
                // Narrative Pacing
                pacing: getAgentConfig('pacing'),
                recap: getAgentConfig('recap'),
                // Post-Narrative Production
                production: getAgentConfig('production'),
                beat_extractor: getAgentConfig('beat_extractor'),
                // Intent Resolution
                intent_resolution: getAgentConfig('intent_resolution'),
            },
            debug_mode: true,
            extended_thinking: extendedThinkingToggle?.checked || false,
            media_enabled: mediaToggle?.checked || false,
            media_budget_enabled: document.getElementById('media-budget-toggle')?.checked || false,
            media_budget_per_session_usd: parseFloat(mediaBudget?.value) || 2.00,
            media_image_model: document.getElementById('media-image-model')?.textContent || 'gemini-3-pro-image-preview',
            media_video_model: document.getElementById('media-video-model')?.textContent || 'veo-3.1-generate-preview',
            media_auto_play: document.getElementById('media-autoplay-toggle')?.checked !== false,
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
 * Build display stats from base stats + optional Layer 2 presentation map.
 * Returns array of [name, displayValue] pairs ready for rendering.
 *
 * Layer 2 handles: aliases (1:1 rename, composites), display scaling,
 * hidden stats, meta-resources (LUK), and display ordering.
 * When presentation is null/undefined, returns raw base stats.
 */
function buildDisplayStats(baseStats, presentation) {
    if (!presentation) {
        return Object.entries(baseStats);
    }

    const aliases = presentation.aliases || {};
    const hidden = new Set(presentation.hidden || []);
    const meta = presentation.meta_resources || {};
    const scale = presentation.display_scale || null;
    const order = presentation.display_order || null;

    // Compute aliased stats
    const result = {};
    const aliasedBaseKeys = new Set(); // track which base keys are consumed by aliases

    for (const [aliasName, config] of Object.entries(aliases)) {
        const bases = config.base || [];
        const method = config.method || 'direct';
        bases.forEach(k => aliasedBaseKeys.add(k));

        let value;
        const baseValues = bases.map(k => baseStats[k] || 0);

        switch (method) {
            case 'direct':
                value = baseValues[0] || 0;
                break;
            case 'max':
                value = Math.max(...baseValues);
                break;
            case 'avg':
                value = Math.round(baseValues.reduce((a, b) => a + b, 0) / baseValues.length);
                break;
            case 'primary':
                // First base is primary, others contribute modifier (value/2 - 5, d20 style)
                value = (baseValues[0] || 0) + Math.floor(((baseValues[1] || 10) - 10) / 2);
                break;
            default:
                value = baseValues[0] || 0;
        }

        result[aliasName] = value;
    }

    // Include non-aliased, non-hidden base stats
    for (const [key, value] of Object.entries(baseStats)) {
        if (!aliasedBaseKeys.has(key) && !hidden.has(key)) {
            result[key] = value;
        }
    }

    // Apply display scaling
    if (scale) {
        const mult = scale.multiplier || 1;
        const offset = scale.offset || 0;
        for (const key of Object.keys(result)) {
            result[key] = Math.round(result[key] * mult + offset);
        }
    }

    // Build entries array
    let entries = Object.entries(result);

    // Append meta-resources (LUK etc.)
    for (const [name, config] of Object.entries(meta)) {
        const pool = config.pool_per_session;
        const displayVal = pool ? `${config.value} (${pool}pts)` : config.value;
        entries.push([name, displayVal]);
    }

    // Apply display ordering if specified
    if (order) {
        const orderMap = {};
        order.forEach((name, i) => { orderMap[name] = i; });
        entries.sort((a, b) => {
            const ai = orderMap[a[0]] ?? 999;
            const bi = orderMap[b[0]] ?? 999;
            return ai - bi;
        });
    }

    return entries;
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

        // Update stats grid (Layer 2 aware)
        const statsGrid = document.getElementById('stats-grid');
        statsGrid.innerHTML = '';
        if (data.stats && typeof data.stats === 'object') {
            const displayStats = buildDisplayStats(data.stats, data.stat_presentation);
            for (const [name, value] of displayStats) {
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
    console.log('[DEBUG] loadNPCs() called');
    try {
        const data = await API.apiRequest('/game/npcs');
        console.log('[DEBUG] loadNPCs response:', data);
        const container = document.getElementById('npc-list');

        if (!data || !data.npcs || data.npcs.length === 0) {
            container.innerHTML = '<div class="empty-state">No NPCs met yet</div>';
            return;
        }

        container.innerHTML = data.npcs.map(npc => {
            const role = npc.role || 'neutral';
            const affinityClass = npc.affinity >= 20 ? 'positive' : (npc.affinity <= -20 ? 'negative' : 'neutral');
            const affinitySign = npc.affinity >= 0 ? '+' : '';
            const portraitHtml = npc.portrait_url
                ? `<img class="npc-sidebar-portrait" src="${npc.portrait_url}" alt="${escapeHtml(npc.name)}" onerror="this.style.display='none'">`
                : '<span class="npc-indicator ' + role + '"></span>';

            return `
                <div class="npc-item">
                    ${portraitHtml}
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
                    <span class="quest-name">• ${escapeHtml(quest.title)}</span>
                    <span class="quest-status ${quest.status}">${quest.status}</span>
                </div>
            `;
        }).join('');

    } catch (e) {
        console.log('[Sidebar] Quests not available:', e.message);
    }
}

/**
 * Retry wrapper — retries once after a delay on failure
 */
async function withRetry(fn, delayMs = 2000) {
    try {
        return await fn();
    } catch (e) {
        await new Promise(r => setTimeout(r, delayMs));
        return await fn();
    }
}

/**
 * Load all sidebar trackers
 */
async function loadAllTrackers() {
    console.log('[DEBUG] loadAllTrackers() called, isSessionZero =', isSessionZero);
    await Promise.all([
        withRetry(loadCharacterStatus),
        withRetry(loadNPCs),
        withRetry(loadFactions),
        withRetry(loadQuests)
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

        // Clear stored session ID so reload starts fresh
        localStorage.removeItem('aidm_session_id');
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
// === Phase 3: Data Page Load Functions ===

// Item type icons
const ITEM_TYPE_ICONS = {
    weapon: '⚔️', armor: '🛡️', consumable: '🧪', key: '🔑',
    material: '🔧', miscellaneous: '📦'
};

// Ability type icons
const ABILITY_TYPE_ICONS = {
    active: '⚡', passive: '🔮', ultimate: '💥', special: '✨', unknown: '❓'
};

// Location type icons
const LOCATION_TYPE_ICONS = {
    city: '🏙️', town: '🏘️', village: '🏡', dungeon: '🏚️', wilderness: '🌲',
    fortress: '🏰', shrine: '⛩️', ruins: '🏛️', cave: '🕳️', coast: '🏖️',
    mountain: '⛰️', forest: '🌳', desert: '🏜️', building: '🏢', interior: '🚪',
    unknown: '📍'
};

/**
 * Load and render inventory
 */
async function loadInventory() {
    const grid = document.getElementById('inventory-grid');
    const countEl = document.getElementById('inventory-count');
    try {
        const data = await API.Game.getInventory();
        countEl.textContent = `${data.total_items} item${data.total_items !== 1 ? 's' : ''}`;

        if (!data.items || data.items.length === 0) {
            grid.innerHTML = `<div class="empty-state-page">
                <span class="empty-icon">🎒</span>
                <p>No items yet</p>
                <p class="empty-hint">Items will appear here as you discover them in your adventure.</p>
            </div>`;
            return;
        }

        grid.innerHTML = data.items.map(item => {
            const icon = ITEM_TYPE_ICONS[item.type] || '📦';
            const typeClass = item.type || 'miscellaneous';
            const qty = item.quantity > 1 ? `<span class="quantity-badge">×${item.quantity}</span>` : '';
            const source = item.source ? `<span class="type-badge miscellaneous">${item.source}</span>` : '';
            return `<div class="data-card">
                <div class="data-card-header">
                    <span class="data-card-name">${icon} ${escapeHtml(item.name)}</span>
                    ${qty}
                </div>
                ${item.description ? `<p class="data-card-desc">${escapeHtml(item.description)}</p>` : ''}
                <div class="data-card-meta">
                    <span class="type-badge ${typeClass}">${item.type}</span>
                    ${source}
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        console.error('Failed to load inventory:', e);
        countEl.textContent = '0 items';
        grid.innerHTML = `<div class="empty-state-page">
            <span class="empty-icon">🎒</span>
            <p>No items yet</p>
            <p class="empty-hint">Start an adventure to discover items.</p>
        </div>`;
    }
}

/**
 * Load and render abilities
 */
async function loadAbilities() {
    const grid = document.getElementById('skills-grid');
    const countEl = document.getElementById('skills-count');
    try {
        const data = await API.Game.getAbilities();
        countEl.textContent = `${data.total_abilities} abilit${data.total_abilities !== 1 ? 'ies' : 'y'}`;

        if (!data.abilities || data.abilities.length === 0) {
            grid.innerHTML = `<div class="empty-state-page">
                <span class="empty-icon">⚔️</span>
                <p>No abilities yet</p>
                <p class="empty-hint">Abilities will appear here as your character grows.</p>
            </div>`;
            return;
        }

        grid.innerHTML = data.abilities.map(ability => {
            const icon = ABILITY_TYPE_ICONS[ability.type] || '❓';
            const typeClass = ability.type || 'unknown';
            const levelTag = ability.level_acquired
                ? `<span class="type-badge miscellaneous">Lv ${ability.level_acquired}</span>`
                : '';
            return `<div class="data-card">
                <div class="data-card-header">
                    <span class="data-card-name">${icon} ${escapeHtml(ability.name)}</span>
                </div>
                ${ability.description ? `<p class="data-card-desc">${escapeHtml(ability.description)}</p>` : ''}
                <div class="data-card-meta">
                    <span class="type-badge ${typeClass}">${ability.type}</span>
                    ${levelTag}
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        console.error('Failed to load abilities:', e);
        countEl.textContent = '0 abilities';
        grid.innerHTML = `<div class="empty-state-page">
            <span class="empty-icon">⚔️</span>
            <p>No abilities yet</p>
            <p class="empty-hint">Abilities will unlock as your character grows.</p>
        </div>`;
    }
}

/**
 * Journal state
 */
let journalCurrentPage = 1;
let journalExpandedTurn = null;
const JOURNAL_PER_PAGE = 20;

/**
 * Load and render journal entries
 */
async function loadJournal(page = null, expandTurn = null) {
    if (page !== null) journalCurrentPage = page;
    if (expandTurn !== undefined) journalExpandedTurn = expandTurn;

    const container = document.getElementById('journal-entries');
    const countEl = document.getElementById('journal-count');
    const pagination = document.getElementById('journal-pagination');

    try {
        const data = await API.Game.getJournal(
            journalCurrentPage, JOURNAL_PER_PAGE, journalExpandedTurn
        );
        countEl.textContent = `${data.total_entries} entr${data.total_entries !== 1 ? 'ies' : 'y'}`;

        if (!data.entries || data.entries.length === 0) {
            container.innerHTML = `<div class="empty-state-page">
                <span class="empty-icon">📖</span>
                <p>No journal entries yet</p>
                <p class="empty-hint">Your adventure will be chronicled here as you play.</p>
            </div>`;
            pagination.style.display = 'none';
            return;
        }

        container.innerHTML = data.entries.map(entry => {
            const isExpanded = data.expanded_turn !== null && entry.turn === data.expanded_turn;
            const heatClass = entry.heat !== null
                ? (entry.heat > 0.7 ? 'high' : entry.heat > 0.4 ? 'medium' : 'low')
                : '';
            const heatLabel = entry.heat !== null
                ? `<span class="journal-heat ${heatClass}">${entry.heat > 0.7 ? '🔥' : entry.heat > 0.4 ? '⚡' : '❄️'} ${Math.round(entry.heat * 100)}%</span>`
                : '';

            return `<div class="journal-entry ${isExpanded ? 'journal-expanded' : ''}"
                        onclick="toggleJournalEntry(${entry.turn})">
                <div class="journal-entry-header">
                    ${entry.turn ? `<span class="journal-turn">Turn ${entry.turn}</span>` : ''}
                    ${heatLabel}
                </div>
                <div class="journal-content">${escapeHtml(entry.content)}</div>
            </div>`;
        }).join('');

        // Pagination
        const totalPages = Math.ceil(data.total_entries / JOURNAL_PER_PAGE);
        if (totalPages > 1) {
            pagination.style.display = 'flex';
            document.getElementById('journal-page-info').textContent = `Page ${data.page} of ${totalPages}`;
            document.getElementById('journal-prev').disabled = data.page <= 1;
            document.getElementById('journal-next').disabled = data.page >= totalPages;

            document.getElementById('journal-prev').onclick = () => loadJournal(data.page - 1, null);
            document.getElementById('journal-next').onclick = () => loadJournal(data.page + 1, null);
        } else {
            pagination.style.display = 'none';
        }
    } catch (e) {
        console.error('Failed to load journal:', e);
        countEl.textContent = '0 entries';
        container.innerHTML = `<div class="empty-state-page">
            <span class="empty-icon">📖</span>
            <p>No journal entries yet</p>
            <p class="empty-hint">Your adventure will be chronicled here as you play.</p>
        </div>`;
        pagination.style.display = 'none';
    }
}

/**
 * Toggle expanded journal entry
 */
function toggleJournalEntry(turn) {
    const newExpand = journalExpandedTurn === turn ? null : turn;
    loadJournal(null, newExpand);
}

/**
 * Load and render locations
 */
async function loadLocations() {
    const grid = document.getElementById('locations-grid');
    const countEl = document.getElementById('locations-count');
    try {
        const data = await API.Game.getLocations();
        countEl.textContent = `${data.total_locations} discovered`;

        if (!data.locations || data.locations.length === 0) {
            grid.innerHTML = `<div class="empty-state-page">
                <span class="empty-icon">🗺️</span>
                <p>No locations discovered yet</p>
                <p class="empty-hint">As you explore, discovered locations will be catalogued here.</p>
            </div>`;
            return;
        }

        // Current location first, then alphabetical
        const sorted = [...data.locations].sort((a, b) => {
            if (a.is_current && !b.is_current) return -1;
            if (!a.is_current && b.is_current) return 1;
            return a.name.localeCompare(b.name);
        });

        grid.innerHTML = sorted.map(loc => {
            const typeIcon = LOCATION_TYPE_ICONS[loc.location_type] || LOCATION_TYPE_ICONS.unknown;
            const currentClass = loc.is_current ? 'current' : '';

            // Build expandable details
            let details = '';
            if (loc.atmosphere) details += `<div class="location-detail-item"><strong>Atmosphere:</strong> ${escapeHtml(loc.atmosphere)}</div>`;
            if (loc.current_state && loc.current_state !== 'intact') details += `<div class="location-detail-item"><strong>State:</strong> ${escapeHtml(loc.current_state)}</div>`;
            if (loc.known_npcs && loc.known_npcs.length > 0) details += `<div class="location-detail-item"><strong>NPCs:</strong> ${loc.known_npcs.map(n => escapeHtml(n)).join(', ')}</div>`;
            if (loc.connected_locations && loc.connected_locations.length > 0) {
                const connections = loc.connected_locations.map(c => escapeHtml(typeof c === 'string' ? c : c.name || c.location || JSON.stringify(c))).join(', ');
                details += `<div class="location-detail-item"><strong>Connects to:</strong> ${connections}</div>`;
            }
            if (loc.notable_events && loc.notable_events.length > 0) details += `<div class="location-detail-item"><strong>Events:</strong> ${loc.notable_events.map(e => escapeHtml(e)).join('; ')}</div>`;

            return `<div class="location-card ${currentClass}" onclick="this.classList.toggle('expanded')">
                <div class="location-name">${typeIcon} ${escapeHtml(loc.name)}</div>
                ${loc.location_type ? `<div class="location-type">${escapeHtml(loc.location_type)}</div>` : ''}
                ${loc.description ? `<div class="location-desc">${escapeHtml(loc.description)}</div>` : ''}
                <div class="location-stats">
                    <span>Visited: ${loc.times_visited}×</span>
                    ${loc.discovered_turn ? `<span>Discovered: Turn ${loc.discovered_turn}</span>` : ''}
                </div>
                ${details ? `<div class="location-details">${details}</div>` : ''}
            </div>`;
        }).join('');
    } catch (e) {
        console.error('Failed to load locations:', e);
        countEl.textContent = '0 discovered';
        grid.innerHTML = `<div class="empty-state-page">
            <span class="empty-icon">🗺️</span>
            <p>No locations discovered yet</p>
            <p class="empty-hint">Explore the world to discover new places.</p>
        </div>`;
    }
}

/**
 * Load and render quest tracker
 */
async function loadQuests() {
    const list = document.getElementById('quests-list');
    const activeCountEl = document.getElementById('quests-active-count');
    const completedCountEl = document.getElementById('quests-completed-count');
    const arcBanner = document.getElementById('quest-arc-banner');
    const arcName = document.getElementById('quest-arc-name');

    try {
        const data = await API.Game.getQuestTracker();
        activeCountEl.textContent = `${data.total_active} active`;
        completedCountEl.textContent = `${data.total_completed} completed`;

        // Arc banner
        if (data.current_arc) {
            arcBanner.style.display = 'flex';
            arcName.textContent = data.current_arc;
        } else {
            arcBanner.style.display = 'none';
        }

        if (!data.quests || data.quests.length === 0) {
            list.innerHTML = `<div class="empty-state-page">
                <span class="empty-icon">📜</span>
                <p>No quests yet</p>
                <p class="empty-hint">Quests will appear here as they are assigned by the Director.</p>
            </div>`;
            return;
        }

        // Active quests first, then completed, then failed
        const order = { active: 0, completed: 1, failed: 2 };
        const sorted = [...data.quests].sort((a, b) => (order[a.status] || 0) - (order[b.status] || 0));

        list.innerHTML = sorted.map(quest => {
            const objectives = (quest.objectives || []).map(obj =>
                `<li class="quest-objective ${obj.completed ? 'completed' : ''}">
                    <span class="quest-checkbox">${obj.completed ? '✓' : ''}</span>
                    <span>${escapeHtml(obj.description)}</span>
                </li>`
            ).join('');

            // Meta info
            let metaItems = [];
            if (quest.source) metaItems.push(`Source: ${escapeHtml(quest.source)}`);
            if (quest.created_turn) metaItems.push(`Started: Turn ${quest.created_turn}`);
            if (quest.completed_turn) metaItems.push(`Completed: Turn ${quest.completed_turn}`);
            if (quest.related_npcs && quest.related_npcs.length > 0) metaItems.push(`NPCs: ${quest.related_npcs.map(n => escapeHtml(n)).join(', ')}`);
            if (quest.related_locations && quest.related_locations.length > 0) metaItems.push(`Locations: ${quest.related_locations.map(l => escapeHtml(l)).join(', ')}`);
            const meta = metaItems.length > 0 ? `<div class="quest-meta">${metaItems.map(m => `<span>${m}</span>`).join('')}</div>` : '';

            return `<div class="quest-card ${quest.status}" onclick="this.classList.toggle('expanded')">
                <div class="quest-card-header">
                    <span class="quest-title">
                        ${escapeHtml(quest.title)}
                        <span class="quest-type-badge ${quest.quest_type}">${quest.quest_type}</span>
                    </span>
                    <span class="quest-status-badge ${quest.status}">${quest.status}</span>
                </div>
                ${quest.description ? `<p class="quest-desc">${escapeHtml(quest.description)}</p>` : ''}
                ${meta}
                ${objectives ? `<ul class="quest-objectives">${objectives}</ul>` : ''}
            </div>`;
        }).join('');
    } catch (e) {
        console.error('Failed to load quests:', e);
        activeCountEl.textContent = '0 active';
        completedCountEl.textContent = '0 completed';
        arcBanner.style.display = 'none';
        list.innerHTML = `<div class="empty-state-page">
            <span class="empty-icon">📜</span>
            <p>No quests yet</p>
            <p class="empty-hint">Quests will appear as your story unfolds.</p>
        </div>`;
    }
}

/**
 * Escape HTML entities
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

// Initialize on load
document.addEventListener('DOMContentLoaded', init);


// =========================================================================
// Media Cutscene Display — Phase 5/6
// =========================================================================

// Only these cutscene types appear as inline media in chat.
// Portraits → portrait_maps chips. Models → sidebar/gallery only.
const CHAT_MEDIA_TYPES = new Set([
    'location_reveal', 'character_intro', 'emotional_peak',
    'power_awakening', 'arc_transition', 'dramatic_moment',
    'battle_scene', 'climax', 'opening_scene'
]);

/**
 * Poll for media generated during a turn (fire-and-forget cutscenes).
 * Polls every 10s for up to 2 minutes.
 */
function pollForTurnMedia(campaignId, turnNumber, maxAttempts = 12) {
    let attempt = 0;
    const interval = setInterval(async () => {
        attempt++;
        try {
            const resp = await fetch(`/api/game/turn/${campaignId}/${turnNumber}/media`);
            if (!resp.ok) return;
            const data = await resp.json();
            if (data.assets && data.assets.length > 0) {
                data.assets.forEach(asset => {
                    if ((asset.status === 'complete' || asset.status === 'partial')
                        && CHAT_MEDIA_TYPES.has(asset.cutscene_type)) {
                        injectCutsceneInline(asset);
                    } else if (asset.status === 'complete' && !CHAT_MEDIA_TYPES.has(asset.cutscene_type)) {
                        console.warn(`[Media] Unknown cutscene type '${asset.cutscene_type}' — not displayed inline`);
                    }
                });
                clearInterval(interval);  // Got media, stop polling
            }
        } catch (e) {
            console.warn('[Media] Poll error:', e);
        }
        if (attempt >= maxAttempts) clearInterval(interval);
    }, 10000);  // Every 10 seconds
}

/**
 * Poll for recently generated non-turn media (portraits, models, locations).
 * These are NOT injected into chat — portraits use the chip system,
 * models go to sidebar/gallery. This function is retained for future use
 * but no longer injects into the chat DOM.
 */
function pollForLatestMedia(campaignId, maxAttempts = 6) {
    // No-op: portraits handled by portrait_maps, models by sidebar.
    // Retained function signature for API compatibility.
}

/**
 * Reload all media for an existing session (called on page refresh/resume).
 * Fetches turn-based media for turns 0..turnCount and latest non-turn media.
 */
async function reloadAllMedia(campaignMediaUuid, turnCount) {
    console.log(`[Media] Reloading media for ${turnCount + 1} turns...`);

    // Only these cutscene_type values should appear as inline media in chat.
    // (Uses module-level CHAT_MEDIA_TYPES constant)

    // Fetch turn-based media (cutscenes, location reveals) for each turn
    for (let turn = 0; turn <= turnCount; turn++) {
        try {
            const resp = await fetch(`/api/game/turn/${campaignMediaUuid}/${turn}/media`);
            console.log(`[Media] Turn ${turn}: status=${resp.status}`);
            if (!resp.ok) continue;
            const data = await resp.json();
            const allAssets = data.assets || [];
            const filtered = allAssets.filter(a => CHAT_MEDIA_TYPES.has(a.cutscene_type));
            console.log(`[Media] Turn ${turn}: ${allAssets.length} assets, ${filtered.length} pass filter`,
                allAssets.map(a => `${a.cutscene_type}(${a.status})`));
            filtered.forEach(asset => injectCutsceneInline(asset, turn));
        } catch (e) {
            console.warn(`[Media] Turn ${turn}: fetch error`, e);
        }
    }

    console.log('[Media] Reload complete.');
}

/**
 * Inject a cutscene inline in the narrative display.
 * If afterTurn is provided, inserts after the last narrative entry for that turn.
 * Otherwise appends at the bottom (live gameplay behavior).
 */
function injectCutsceneInline(asset, afterTurn) {
    const display = document.getElementById('narrative-display');
    if (!display) return;

    // Unique key: afterTurn + cutscene_type (guaranteed unique per asset)
    const uniqueKey = `${afterTurn ?? 'live'}-${asset.cutscene_type || 'scene'}-${asset.file_url?.split('/').pop() || ''}`;
    const elementId = `cutscene-${uniqueKey}`;
    if (document.getElementById(elementId)) return;  // Already injected

    console.log(`[Media] Injecting ${asset.cutscene_type} at turn ${afterTurn}`);

    const container = document.createElement('div');
    container.className = 'cutscene-container';
    container.id = elementId;

    if (asset.asset_type === 'video' && asset.file_url) {
        const autoplay = document.getElementById('media-autoplay-toggle')?.checked ?? true;
        container.innerHTML = `
            <video
                src="${asset.file_url}"
                ${autoplay ? 'autoplay' : ''}
                loop muted playsinline
                style="width: 100%; height: 100%; object-fit: cover;"
                onclick="openCutsceneFullscreen(this.src)"
            ></video>
            <div class="cutscene-badge">${formatCutsceneType(asset.cutscene_type)}</div>
        `;
    } else if (asset.file_url) {
        container.innerHTML = `
            <img
                src="${asset.file_url}"
                alt="Cutscene: ${asset.cutscene_type || 'scene'}"
                style="width: 100%; height: 100%; object-fit: cover; cursor: pointer;"
                onclick="openCutsceneFullscreen(this.src)"
            />
            <div class="cutscene-badge">${formatCutsceneType(asset.cutscene_type)}</div>
        `;
    }

    // Thread into correct position if turn info provided
    if (afterTurn != null) {
        // Find the last narrative entry for this turn (or the closest earlier turn)
        let anchor = null;
        for (let t = afterTurn; t >= 0 && !anchor; t--) {
            const entries = display.querySelectorAll(`.narrative-entry[data-turn='${t}']`);
            if (entries.length > 0) {
                anchor = entries[entries.length - 1];
            }
        }
        if (anchor && anchor.nextSibling) {
            display.insertBefore(container, anchor.nextSibling);
        } else {
            display.appendChild(container);
        }
    } else {
        display.appendChild(container);
    }
    display.scrollTop = display.scrollHeight;
}

/**
 * Format cutscene type for display badge.
 */
function formatCutsceneType(type) {
    if (!type) return 'SCENE';
    return type.replace(/_/g, ' ').toUpperCase();
}

/**
 * Open a cutscene in fullscreen viewer.
 */
function openCutsceneFullscreen(src) {
    // Remove existing viewer if any
    const existing = document.querySelector('.cutscene-fullscreen');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'cutscene-fullscreen';
    overlay.onclick = (e) => {
        if (e.target === overlay) overlay.remove();
    };

    const isVideo = src.endsWith('.mp4') || src.endsWith('.webm');
    if (isVideo) {
        overlay.innerHTML = `
            <video src="${src}" controls autoplay loop
                style="max-width: 95vw; max-height: 90vh; border-radius: 12px;"
            ></video>
        `;
    } else {
        overlay.innerHTML = `
            <img src="${src}"
                style="max-width: 95vw; max-height: 90vh; border-radius: 12px;"
            />
        `;
    }

    document.body.appendChild(overlay);

    // Close on Escape key
    const handleEsc = (e) => {
        if (e.key === 'Escape') {
            overlay.remove();
            document.removeEventListener('keydown', handleEsc);
        }
    };
    document.addEventListener('keydown', handleEsc);
}
