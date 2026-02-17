"""Research routes with SSE progress streaming."""

import asyncio
import json
from typing import Optional
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from src.agents.progress import ProgressTracker, ProgressPhase, ProgressEvent
from src.agents.anime_research import AnimeResearchAgent, research_anime_with_search


import logging

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/research", tags=["research"])


class ResearchRequest(BaseModel):
    """Request to start anime research."""
    anime_name: str


class ResearchResponse(BaseModel):
    """Response from research initiation."""
    task_id: str
    message: str


# Store for active research tasks
_active_tasks: dict[str, asyncio.Task] = {}


@router.post("/start", response_model=ResearchResponse)
async def start_research(request: ResearchRequest):
    """Start an anime research task and return a task ID for progress tracking."""
    
    # Create progress tracker
    tracker = ProgressTracker(total_steps=10)
    task_id = tracker.task_id
    
    # Start research in background
    async def run_research():
        try:
            agent = AnimeResearchAgent()
            result = await agent.research_anime(
                request.anime_name,
                progress_tracker=tracker
            )
            return result
        except Exception as e:
            await tracker.error(str(e))
            raise
    
    # Launch as background task
    task = asyncio.create_task(run_research())
    _active_tasks[task_id] = task
    
    return ResearchResponse(
        task_id=task_id,
        message=f"Research started for '{request.anime_name}'"
    )


@router.get("/progress/{task_id}")
async def stream_progress(task_id: str):
    """Stream progress events for a research task via SSE."""
    
    tracker = ProgressTracker.get(task_id)
    if not tracker:
        logger.warning(f"Tracker not found for task_id: {task_id}")
        raise HTTPException(status_code=404, detail="Task not found or already completed")
    
    logger.info(f"Client connected for task: {task_id}, existing events: {len(tracker.events)}")
    
    async def event_generator():
        """Generate SSE events from progress updates."""
        # Force immediate connection confirmation to client
        yield ": connected\n\n"
        
        queue: asyncio.Queue[ProgressEvent] = asyncio.Queue()
        
        # Register callback to push events to queue
        async def on_event(event: ProgressEvent):
            logger.info(f"Queueing event: {event.phase.value} {event.percent}%")
            await queue.put(event)
        
        tracker.on_progress_async(on_event)
        
        # Send any existing events first
        logger.info(f"Sending {len(tracker.events)} existing events")
        for event in tracker.events:
            logger.info(f"Replaying: {event.phase.value} {event.percent}%")
            yield f"event: progress\ndata: {json.dumps(event.to_dict())}\n\n"
        
        # Stream new events as they arrive
        while True:
            try:
                # Wait for next event with timeout
                event = await asyncio.wait_for(queue.get(), timeout=60.0)
                logger.info(f"Streaming: {event.phase.value} {event.percent}%")
                yield f"event: progress\ndata: {json.dumps(event.to_dict())}\n\n"
                
                # Stop streaming on completion or error
                if event.phase in (ProgressPhase.COMPLETE, ProgressPhase.ERROR):
                    break
                    
            except asyncio.TimeoutError:
                # Send keepalive
                yield f": keepalive\n\n"
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


@router.get("/status/{task_id}")
async def get_task_status(task_id: str):
    """Get current status of a research task."""
    
    tracker = ProgressTracker.get(task_id)
    if not tracker:
        # Check if task exists but completed
        if task_id in _active_tasks:
            task = _active_tasks[task_id]
            if task.done():
                del _active_tasks[task_id]
                return {"status": "completed", "task_id": task_id}
        raise HTTPException(status_code=404, detail="Task not found")
    
    latest = tracker.events[-1] if tracker.events else None
    return {
        "status": "running",
        "task_id": task_id,
        "latest_event": latest.to_dict() if latest else None,
        "event_count": len(tracker.events)
    }
