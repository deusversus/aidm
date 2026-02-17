"""
Custom Profile Library for AIDM v3.

Manages RAG storage for custom/original profiles.
Uses a SEPARATE ChromaDB instance from canonical profiles for easy cleanup.
"""

import chromadb
import uuid
import shutil
from typing import List, Optional
from pathlib import Path


import logging

logger = logging.getLogger(__name__)

class CustomProfileLibrary:
    """
    Manages the RAG system for custom (original) profiles.
    
    Key differences from ProfileLibrary:
    - Separate ChromaDB instance at data/chroma_custom/
    - Profiles keyed by session_id (not anime name)
    - Supports full cleanup when session is reset
    """
    
    def __init__(self, persist_dir: str = "./data/chroma_custom"):
        Path(persist_dir).mkdir(parents=True, exist_ok=True)
        self.persist_dir = persist_dir
        self.client = chromadb.PersistentClient(path=persist_dir)
        
        # Collection for custom profile lore
        self.collection = self.client.get_or_create_collection(
            name="custom_profiles_lore",
            metadata={"hnsw:space": "cosine"}
        )
    
    def add_custom_lore(
        self, 
        session_id: str, 
        content: str, 
        source: str = "generated"
    ) -> int:
        """
        Ingest lore content for a custom profile.
        
        Args:
            session_id: The session this profile belongs to
            content: Raw text content to chunk and index
            source: Source type (e.g., "generated", "user_input")
            
        Returns:
            Number of chunks indexed
        """
        chunks = self._chunk_text(content)
        
        if not chunks:
            return 0
        
        ids = [f"{session_id}_{uuid.uuid4()}" for _ in chunks]
        metadatas = [{
            "session_id": session_id,
            "source": source,
            "chunk_index": i
        } for i in range(len(chunks))]
        
        self.collection.add(
            ids=ids,
            documents=chunks,
            metadatas=metadatas
        )
        
        logger.info(f"Indexed {len(chunks)} lore chunks for session {session_id[:8]}...")
        return len(chunks)
    
    def search_lore(
        self, 
        session_id: str, 
        query: str, 
        limit: int = 5
    ) -> List[str]:
        """
        Search for lore relevant to the query, filtered by session_id.
        
        Args:
            session_id: The session to search within
            query: Search query
            limit: Max results to return
            
        Returns:
            List of matching lore chunks
        """
        results = self.collection.query(
            query_texts=[query],
            n_results=limit,
            where={"session_id": session_id}
        )
        
        if results["documents"]:
            return results["documents"][0]
        return []
    
    def delete_session_lore(self, session_id: str) -> int:
        """
        Delete all lore chunks for a session.
        
        Called when session is reset/deleted.
        
        Args:
            session_id: The session to clean up
            
        Returns:
            Number of chunks deleted
        """
        # Get all chunk IDs for this session
        results = self.collection.get(
            where={"session_id": session_id}
        )
        
        if results["ids"]:
            self.collection.delete(ids=results["ids"])
            logger.info(f"Deleted {len(results['ids'])} lore chunks for session {session_id[:8]}...")
            return len(results["ids"])
        
        return 0
    
    def has_session_profile(self, session_id: str, profiles_base: str = "./data/custom_profiles") -> bool:
        """
        Check if a session has a custom/hybrid profile stored.
        
        Used during handoff to verify hybrid profiles exist before using them.
        
        Args:
            session_id: The session to check
            profiles_base: Base directory for custom profiles
            
        Returns:
            True if session has a stored profile, False otherwise
        """
        from pathlib import Path
        session_dir = Path(profiles_base) / session_id
        return session_dir.exists() and any(session_dir.glob("*.yaml"))
    
    def _chunk_text(self, text: str, chunk_size: int = 1000, overlap: int = 100) -> List[str]:
        """Simple chunking by paragraphs."""
        if not text:
            return []
        
        paragraphs = text.split("\n\n")
        chunks = []
        current_chunk = ""
        
        for para in paragraphs:
            if len(current_chunk) + len(para) < chunk_size:
                current_chunk += "\n\n" + para
            else:
                if current_chunk:
                    chunks.append(current_chunk.strip())
                current_chunk = para
        
        if current_chunk:
            chunks.append(current_chunk.strip())
        
        return chunks
    
    def clear_all(self):
        """Delete all custom profile data (lore + files).
        
        Called during full reset to clear hybrid/original profiles.
        """
        # Clear ChromaDB collection by deleting and recreating
        try:
            self.client.delete_collection("custom_profiles_lore")
        except Exception:
            pass  # Collection may not exist
        
        self.collection = self.client.get_or_create_collection(
            name="custom_profiles_lore",
            metadata={"hnsw:space": "cosine"}
        )
        
        # Delete all custom profile folders
        import shutil
        custom_dir = Path("./data/custom_profiles")
        if custom_dir.exists():
            shutil.rmtree(custom_dir)
            custom_dir.mkdir(parents=True)
        
        logger.info("Cleared all custom profiles")


def save_custom_profile(
    session_id: str,
    world_data: dict,
    lore_content: str,
    profiles_base: str = "./data/custom_profiles"
) -> Path:
    """
    Save a custom profile to disk.
    
    Args:
        session_id: Session ID for folder naming
        world_data: World configuration dict
        lore_content: Generated lore text
        profiles_base: Base directory for custom profiles
        
    Returns:
        Path to the created profile folder
    """
    import yaml
    
    profile_dir = Path(profiles_base) / session_id
    profile_dir.mkdir(parents=True, exist_ok=True)
    
    # Save world config
    world_path = profile_dir / "world.yaml"
    with open(world_path, 'w', encoding='utf-8') as f:
        yaml.dump(world_data, f, default_flow_style=False, allow_unicode=True)
    
    # Save lore text
    lore_path = profile_dir / "world_lore.txt"
    with open(lore_path, 'w', encoding='utf-8') as f:
        f.write(lore_content)
    
    logger.info(f"Saved custom profile to {profile_dir}")
    return profile_dir


def delete_custom_profile(
    session_id: str,
    profiles_base: str = "./data/custom_profiles"
) -> bool:
    """
    Delete a custom profile folder from disk.
    
    Args:
        session_id: Session ID
        profiles_base: Base directory
        
    Returns:
        True if deleted, False if not found
    """
    profile_dir = Path(profiles_base) / session_id
    
    if profile_dir.exists():
        shutil.rmtree(profile_dir)
        logger.info(f"Deleted custom profile folder for session {session_id[:8]}...")
        return True
    
    return False


# Singleton instance
_custom_profile_library: Optional[CustomProfileLibrary] = None


def get_custom_profile_library() -> CustomProfileLibrary:
    """Get the global custom profile library instance."""
    global _custom_profile_library
    if _custom_profile_library is None:
        _custom_profile_library = CustomProfileLibrary()
    return _custom_profile_library
