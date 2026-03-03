"""Progress event system for long-running operations.

Provides a standardized way to emit and consume progress events
for operations like profile generation, research, etc.
"""

import logging
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

logger = logging.getLogger(__name__)

class ProgressPhase(str, Enum):
    """Phases of profile generation."""
    INITIALIZING = "initializing"
    SCOPE = "scope"
    RESEARCH = "research"
    PARSING = "parsing"
    SAVING = "saving"
    COMPLETE = "complete"
    ERROR = "error"


@dataclass
class ProgressEvent:
    """A single progress update event."""
    phase: ProgressPhase
    message: str
    percent: int  # 0-100
    detail: dict[str, Any] = field(default_factory=dict)
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "phase": self.phase.value,
            "message": self.message,
            "percent": self.percent,
            "detail": self.detail,
            "timestamp": self.timestamp
        }


class ProgressTracker:
    """Tracks progress for a long-running operation.
    
    Usage:
        tracker = ProgressTracker(task_id="abc123", total_steps=10)
        tracker.on_progress(callback_fn)
        
        await tracker.emit(ProgressPhase.SCOPE, "Classifying series...", 10)
        await tracker.emit(ProgressPhase.RESEARCH, "power_system (1/7)", 20)
    """

    # Class-level registry of active trackers
    _active_trackers: dict[str, "ProgressTracker"] = {}

    def __init__(self, task_id: str | None = None, total_steps: int = 10):
        self.task_id = task_id or str(uuid.uuid4())
        self.total_steps = total_steps
        self.current_step = 0
        self.events: list[ProgressEvent] = []
        self._callbacks: list[Callable[[ProgressEvent], None]] = []
        self._async_callbacks: list[Callable[[ProgressEvent], Any]] = []

        # Register this tracker
        ProgressTracker._active_trackers[self.task_id] = self

    @classmethod
    def get(cls, task_id: str) -> Optional["ProgressTracker"]:
        """Get an active tracker by ID."""
        return cls._active_trackers.get(task_id)

    def on_progress(self, callback: Callable[[ProgressEvent], None]):
        """Register a synchronous callback for progress events."""
        self._callbacks.append(callback)

    def on_progress_async(self, callback: Callable[[ProgressEvent], Any]):
        """Register an async callback for progress events."""
        self._async_callbacks.append(callback)

    async def emit(
        self,
        phase: ProgressPhase,
        message: str,
        percent: int | None = None,
        detail: dict[str, Any] | None = None
    ):
        """Emit a progress event to all registered callbacks."""
        # Auto-calculate percent if not provided
        if percent is None:
            self.current_step += 1
            percent = min(100, int((self.current_step / self.total_steps) * 100))

        event = ProgressEvent(
            phase=phase,
            message=message,
            percent=percent,
            detail=detail or {}
        )

        self.events.append(event)

        # Notify sync callbacks
        for callback in self._callbacks:
            try:
                callback(event)
            except Exception as e:
                logger.error(f"Callback error: {e}")

        # Notify async callbacks
        for callback in self._async_callbacks:
            try:
                await callback(event)
            except Exception as e:
                logger.error(f"Async callback error: {e}")

    async def complete(self, message: str = "Complete"):
        """Mark the operation as complete."""
        await self.emit(ProgressPhase.COMPLETE, message, 100)
        self._cleanup()

    async def error(self, message: str):
        """Mark the operation as failed."""
        await self.emit(ProgressPhase.ERROR, message, self.events[-1].percent if self.events else 0)
        self._cleanup()

    def _cleanup(self):
        """Remove this tracker from the registry."""
        if self.task_id in ProgressTracker._active_trackers:
            del ProgressTracker._active_trackers[self.task_id]


def create_progress_tracker(task_id: str | None = None) -> ProgressTracker:
    """Factory function to create a new progress tracker."""
    return ProgressTracker(task_id=task_id)



class WeightedProgressGroup:
    """
    Manages a group of progress trackers that contribute to a single parent progress bar.
    Each child tracker has a weight (e.g., 0.5).
    Global Progress = Sum(Child_Percent * Child_Weight)
    
    This ensures monotonic progress regardless of which child updates first.
    """
    def __init__(self, parent_tracker: ProgressTracker):
        self.parent = parent_tracker
        self.children: dict[str, dict] = {} # {id: {'weight': 0.5, 'percent': 0}}

    def create_sub_tracker(self, weight: float, name: str | None = None) -> ProgressTracker:
        """
        Create a child tracker with a specific weight and optional name.
        The child behaves like a normal 0-100% tracker.
        """
        sub = ProgressTracker() # Standard independent tracker

        # Link update event to parent recalculation
        async def on_update(event):
             await self._update_child_progress(sub.task_id, event.percent, event.message)

        sub.on_progress_async(on_update)

        self.children[sub.task_id] = {'weight': weight, 'percent': 0, 'name': name}
        return sub

    async def _update_child_progress(self, child_id, percent, message):
        # 1. Update local state
        if percent is None: percent = 0
        self.children[child_id]['percent'] = percent
        self.children[child_id]['message'] = message # Store latest message

        # 2. Calculate Weighted Sum
        total_progress = 0
        total_weight = sum(c['weight'] for c in self.children.values())

        for child in self.children.values():
            total_progress += child['percent'] * child['weight']

        # Normalize
        if total_weight > 0:
            final_percent = total_progress / total_weight
        else:
            final_percent = 0

        # 3. Determine Display Message & Title (The "50% Switch" Rule)
        # User wants to see Title A until 50%, then Title B.
        child_ids = list(self.children.keys())
        display_message = message # Fallback
        display_title = None

        if child_ids:
            # If 2 tasks: Switch at 50%
            if len(child_ids) > 1:
                target_idx = 0 if final_percent < 50 else 1
                # Clamp index
                if target_idx >= len(child_ids): target_idx = len(child_ids) - 1

                target_id = child_ids[target_idx]
                # Use cached message from that child, or fallback to current if empty
                display_message = self.children[target_id].get('message') or message
                display_title = self.children[target_id].get('name')
            else:
                # 1 task: Just use its data
                target_id = child_ids[0]
                display_message = self.children[target_id].get('message') or message
                display_title = self.children[target_id].get('name')

        # 4. Emit to Parent
        detail = {}
        if display_title:
            detail["current_title"] = display_title

        await self.parent.emit(
            ProgressPhase.RESEARCH,
            display_message,
            int(final_percent),
            detail=detail
        )

