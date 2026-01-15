/**
 * AIDM v3 API Client
 */

const API_BASE = '/api';

/**
 * Generic fetch wrapper with error handling
 */
async function apiRequest(endpoint, options = {}) {
    const url = `${API_BASE}${endpoint}`;

    const defaultOptions = {
        headers: {
            'Content-Type': 'application/json',
        },
    };

    const response = await fetch(url, { ...defaultOptions, ...options });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
        throw new Error(error.detail || `HTTP ${response.status}`);
    }

    return response.json();
}

/**
 * Settings API
 */
const SettingsAPI = {
    /**
     * Get current settings
     */
    async get() {
        return apiRequest('/settings');
    },

    /**
     * Update all settings
     */
    async update(settings) {
        return apiRequest('/settings', {
            method: 'PUT',
            body: JSON.stringify(settings),
        });
    },

    /**
     * Update a single agent's model
     */
    async updateAgent(agentName, config) {
        return apiRequest(`/settings/agent/${agentName}`, {
            method: 'PUT',
            body: JSON.stringify(config),
        });
    },

    /**
     * Reset to defaults
     */
    async reset() {
        return apiRequest('/settings/reset', { method: 'POST' });
    },

    /**
     * Get available models
     */
    async getModels(provider = null) {
        const query = provider ? `?provider=${provider}` : '';
        return apiRequest(`/settings/models${query}`);
    },

    /**
     * Get API key status (masked)
     */
    async getKeys() {
        return apiRequest('/settings/keys');
    },

    /**
     * Set an API key for a provider
     */
    async setKey(provider, key) {
        return apiRequest(`/settings/keys/${provider}`, {
            method: 'PUT',
            body: JSON.stringify({ key }),
        });
    },

    /**
     * Delete an API key
     */
    async deleteKey(provider) {
        return apiRequest(`/settings/keys/${provider}`, { method: 'DELETE' });
    },
};

/**
 * Game API
 */
const GameAPI = {
    // Current session ID (set after starting session)
    currentSessionId: null,

    /**
     * Start a new Session Zero
     */
    async startSession() {
        const result = await apiRequest('/game/start-session', { method: 'POST' });
        this.currentSessionId = result.session_id;
        return result;
    },

    /**
     * Process a turn during Session Zero
     */
    async sessionTurn(playerInput) {
        if (!this.currentSessionId) {
            throw new Error('No active session. Call startSession() first.');
        }
        return apiRequest(`/game/session/${this.currentSessionId}/turn`, {
            method: 'POST',
            body: JSON.stringify({ player_input: playerInput }),
        });
    },

    /**
     * Get session status
     */
    async getSessionStatus() {
        if (!this.currentSessionId) {
            return null;
        }
        return apiRequest(`/game/session/${this.currentSessionId}/status`);
    },

    /**
     * Check if we're in Session Zero
     */
    isInSessionZero() {
        return this.currentSessionId !== null;
    },

    /**
     * Process a gameplay turn (after Session Zero)
     */
    async processTurn(playerInput) {
        const body = { player_input: playerInput };
        // Include session_id for handoff scene retrieval and conversation persistence
        if (this.currentSessionId) {
            body.session_id = this.currentSessionId;
        }
        return apiRequest('/game/turn', {
            method: 'POST',
            body: JSON.stringify(body),
        });
    },

    /**
     * Get current context
     */
    async getContext() {
        return apiRequest('/game/context');
    },

    /**
     * Reset the game
     */
    async reset() {
        this.currentSessionId = null;
        return apiRequest('/game/reset', { method: 'POST' });
    },

    /**
     * Resume an existing session from storage
     */
    async resumeSession(sessionId) {
        try {
            const result = await apiRequest(`/game/session/${sessionId}/resume`);
            this.currentSessionId = result.session_id;
            return result;
        } catch (e) {
            // Session not found - clear stored ID
            localStorage.removeItem('aidm_session_id');
            return null;
        }
    },

    /**
     * Delete a session (for reset)
     */
    async deleteSession(sessionId = null) {
        const id = sessionId || this.currentSessionId;
        if (!id) return { deleted: false };

        const result = await apiRequest(`/game/session/${id}`, { method: 'DELETE' });

        // Clear stored session
        localStorage.removeItem('aidm_session_id');
        this.currentSessionId = null;

        return result;
    },

    /**
     * Export current session to downloadable .aidm file
     */
    async exportSession() {
        const response = await fetch(`${API_BASE}/game/export`);
        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: 'Export failed' }));
            throw new Error(error.detail || `HTTP ${response.status}`);
        }

        // Get filename from Content-Disposition header
        const disposition = response.headers.get('Content-Disposition');
        let filename = 'session_export.aidm';
        if (disposition) {
            const match = disposition.match(/filename=(.+)/);
            if (match) filename = match[1];
        }

        // Download the file
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);

        return { status: 'ok', filename };
    },

    /**
     * Import session from .aidm file
     * @param {File} file - The .aidm file to import
     */
    async importSession(file) {
        // Read file as ArrayBuffer
        const buffer = await file.arrayBuffer();

        // Send raw bytes to import endpoint
        const response = await fetch(`${API_BASE}/game/import-bytes`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
            },
            body: buffer,
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: 'Import failed' }));
            throw new Error(error.detail || `HTTP ${response.status}`);
        }

        const result = await response.json();

        // Clear session ID since we've reset
        this.currentSessionId = null;

        return result;
    },

    /**
     * Change profile
     */
    async changeProfile(profileId) {
        return apiRequest(`/game/profile/${profileId}`, { method: 'PUT' });
    },
};

/**
 * Health check
 */
async function checkHealth() {
    return apiRequest('/health');
}

/**
 * Get available providers
 */
async function getProviders() {
    return apiRequest('/providers');
}

// Export for use
window.API = {
    Settings: SettingsAPI,
    Game: GameAPI,
    checkHealth,
    getProviders,
};
