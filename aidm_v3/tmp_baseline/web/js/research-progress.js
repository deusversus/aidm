/**
 * Research Progress Component - Inline Version
 * 
 * Replaces the input area with a progress bar during profile generation.
 * Sends chat messages for start/complete instead of detailed log.
 */

class ResearchProgress {
    constructor() {
        this.eventSource = null;
        this.taskId = null;
        this.animeName = '';
        this.isActive = false;
    }

    /**
     * Show the progress bar by replacing the input area
     */
    show(animeName) {
        this.animeName = animeName;
        this.isActive = true;

        const inputArea = document.querySelector('.input-area');
        if (!inputArea) return;

        // Store original input content
        this.originalInputContent = inputArea.innerHTML;

        // Replace with progress bar (using IDs for reliable selection)
        inputArea.innerHTML = `
            <div class="research-progress-inline">
                <div class="rp-header">
                    <span class="rp-icon">🔬</span>
                    <span class="rp-title">Generating Profile: "<span id="rp-title-text">${this.escapeHtml(animeName)}</span>" <small style="opacity:0.5; font-size:0.8em">(v3.2)</small></span>
                </div>
                <div class="rp-bar-container">
                    <div class="rp-bar">
                        <div id="rp-bar-fill" class="rp-bar-fill" style="width: 0%"></div>
                    </div>
                    <span id="rp-percent" class="rp-percent">0%</span>
                </div>
                <div id="rp-subtitle" class="rp-subtitle">This may take 2-3 minutes...</div>
            </div>
        `;

        // Add starting message to chat
        this.addChatMessage(`🔬 **Profile generation started for "${animeName}"**\n\n*Researching lore, power systems, characters, and tone. This typically takes 2-3 minutes...*`, false);
    }

    /**
     * Connect to the SSE progress stream
     */
    connectToStream() {
        if (!this.taskId) {
            console.error('[ResearchProgress] No task ID set');
            return;
        }

        if (this.eventSource) {
            this.eventSource.close();
        }

        console.log('[ResearchProgress] Connecting to SSE stream:', this.taskId);
        this.eventSource = new EventSource(`/api/research/progress/${this.taskId}`);

        // Connection timeout watchdog
        const connectionTimeout = setTimeout(() => {
            if (this.eventSource && this.eventSource.readyState === 0) { // CONNECTING
                console.warn('[ResearchProgress] Connection timed out (socket blocked?)');
                this.updateDisplay({
                    percent: 0,
                    message: "⚠️ Connection waiting... (Close other tabs?)"
                });
            }
        }, 4000);

        this.eventSource.onopen = () => {
            clearTimeout(connectionTimeout);
            console.log('[ResearchProgress] SSE connection opened successfully');
        };

        this.eventSource.addEventListener('progress', (e) => {
            try {
                console.log('[ResearchProgress] Raw SSE data:', e.data);
                const event = JSON.parse(e.data);
                this.handleProgressEvent(event);
            } catch (err) {
                console.error('[ResearchProgress] Parse error:', err);
            }
        });

        this.eventSource.onerror = (error) => {
            console.error('[ResearchProgress] SSE connection error:', error);
            // Don't immediately close - could be temporary
        };
    }

    /**
     * Handle incoming progress event
     */
    handleProgressEvent(event) {
        console.log('[ResearchProgress] Event:', event.phase, event.percent, event.message);
        this.updateDisplay(event);

        // Auto-hide on completion
        if (event.phase === 'complete' || event.phase === 'error') {
            this.complete(event.phase === 'error' ? event.message : null);
        }
    }

    /**
     * Update the progress bar display
     */
    updateDisplay(event) {
        // Use IDs for reliable selection
        const bar = document.getElementById('rp-bar-fill');
        const percent = document.getElementById('rp-percent');
        const subtitle = document.getElementById('rp-subtitle');
        const titleText = document.getElementById('rp-title-text');

        // Use requestAnimationFrame to ensure visual update happens in next paint frame
        window.requestAnimationFrame(() => {
            if (bar) {
                // FALLBACK: Use simple width to ensure visibility if CSS transform is cached/broken
                // This is less performant but 100% reliable
                bar.style.width = `${Math.max(0, Math.min(100, event.percent))}%`;
                bar.style.transform = 'none'; // precise override
            }
            if (percent) {
                percent.textContent = `${event.percent}%`;
            }
            if (subtitle && event.message) {
                subtitle.textContent = event.message;
            }
            // Update title text if backend sends a new current_title (e.g. for hybrid switching)
            if (titleText && event.detail && event.detail.current_title) {
                if (titleText.textContent !== event.detail.current_title) {
                    titleText.textContent = event.detail.current_title;
                }
            }
        });
    }

    /**
     * Complete and restore input area
     */
    complete(errorMessage = null) {
        if (!this.isActive) return;
        this.isActive = false;

        // Close SSE
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }

        // Restore input area
        const inputArea = document.querySelector('.input-area');
        if (inputArea && this.originalInputContent) {
            inputArea.innerHTML = this.originalInputContent;
            // Re-attach event listeners
            this.reattachInputListeners();
        }

        // Add completion message to chat
        if (errorMessage) {
            this.addChatMessage(`❌ **Profile generation failed:** ${errorMessage}`, false);
        } else {
            this.addChatMessage(`✅ **Profile generation complete!**\n\n*The ${this.animeName} world is now loaded. Let's continue building your character...*`, false);

            // Update sidebar profile display directly (loadContext doesn't work during Session Zero)
            const profileEl = document.getElementById('ctx-profile');
            if (profileEl) {
                profileEl.textContent = this.animeName;
            }
        }

        this.taskId = null;
    }

    /**
     * Re-attach input event listeners after restoring
     */
    reattachInputListeners() {
        const input = document.getElementById('player-input');
        const submitBtn = document.getElementById('submit-action');

        if (submitBtn) {
            // Reset button loading state
            const btnText = submitBtn.querySelector('.btn-text');
            const btnLoading = submitBtn.querySelector('.btn-loading');
            if (btnText) btnText.style.display = '';
            if (btnLoading) btnLoading.style.display = 'none';
            submitBtn.disabled = false;

            submitBtn.addEventListener('click', () => handlePlayerAction());
        }

        if (input) {
            // CRITICAL: Enable the input (it may have been disabled during processing)
            input.disabled = false;
            input.readOnly = false;
            input.style.pointerEvents = 'auto';

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handlePlayerAction();
                }
            });

            // Focus after a brief delay to ensure DOM is ready
            setTimeout(() => input.focus(), 100);
        }
    }

    /**
     * Add a message to the chat display
     */
    addChatMessage(text, isPlayer) {
        // Use the global function from app.js
        if (typeof addNarrativeEntry === 'function') {
            addNarrativeEntry(text, isPlayer);
        }
    }

    /**
     * Hide without completion message (cleanup)
     */
    hide() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }

        // Restore input if still showing progress
        const progressEl = document.querySelector('.research-progress-inline');
        if (progressEl && this.originalInputContent) {
            const inputArea = document.querySelector('.input-area');
            if (inputArea) {
                inputArea.innerHTML = this.originalInputContent;
                this.reattachInputListeners();
            }
        }

        this.isActive = false;
        this.taskId = null;
    }

    /**
     * Escape HTML
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Global instance
const researchProgress = new ResearchProgress();

// Export for use in other scripts
window.researchProgress = researchProgress;
