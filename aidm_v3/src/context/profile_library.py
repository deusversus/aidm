import chromadb
import uuid
from typing import List, Dict, Any, Optional
from pathlib import Path

class ProfileLibrary:
    """
    Manages the RAG system for narrative profiles (Lore).
    Ingests raw research text (Pass 1) or V2 markdown profiles.
    Used by Director and Key Animator to ground their generation in specific series facts.
    """
    
    def __init__(self, persist_dir: str = "./data/chroma"):
        Path(persist_dir).mkdir(parents=True, exist_ok=True)
        self.client = chromadb.PersistentClient(path=persist_dir)
        
        # Collection for profile lore
        # We use a single collection with 'profile_id' in metadata to filter
        self.collection = self.client.get_or_create_collection(
            name="narrative_profiles_lore",
            metadata={"hnsw:space": "cosine"}
        )
        
    def add_profile_lore(self, profile_id: str, content: str, source: str = "research"):
        """
        Ingest narrative content for a profile.
        Chunks the content and adds it to the vector store.
        """
        # Simple chunking by paragraph/section
        # In a production system, we'd use a smarter tiktoken text splitter
        chunks = self._chunk_text(content)
        
        # Prepare batch data
        ids = [f"{profile_id}_{uuid.uuid4()}" for _ in chunks]
        metadatas = [{
            "profile_id": profile_id,
            "source": source,
            "chunk_index": i
        } for i in range(len(chunks))]
        
        if chunks:
            self.collection.add(
                ids=ids,
                documents=chunks,
                metadatas=metadatas
            )
            print(f"[ProfileLibrary] Ingested {len(chunks)} lore chunks for {profile_id}")
            
    def _chunk_text(self, text: str, chunk_size: int = 1000, overlap: int = 100) -> List[str]:
        """Simple chunking strategy."""
        if not text:
            return []
            
        # Split by double newlines first to preserve paragraph structure
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
        
    def search_lore(self, profile_id: str, query: str, limit: int = 5) -> List[str]:
        """
        Search for lore relevant to the query, filtered by profile_id.
        """
        results = self.collection.query(
            query_texts=[query],
            n_results=limit,
            where={"profile_id": profile_id}
        )
        
        if results["documents"]:
            return results["documents"][0]
        return []

# Singleton instance
_profile_library: Optional[ProfileLibrary] = None

def get_profile_library() -> ProfileLibrary:
    global _profile_library
    if _profile_library is None:
        _profile_library = ProfileLibrary()
    return _profile_library
