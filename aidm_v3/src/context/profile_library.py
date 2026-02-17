import chromadb
import re
import uuid
from typing import List, Dict, Any, Optional
from pathlib import Path


import logging

logger = logging.getLogger(__name__)

class ProfileLibrary:
    """
    Manages the RAG system for narrative profiles (Lore).
    Ingests raw research text (Pass 1) or V2 markdown profiles.
    Used by Director and Key Animator to ground their generation in specific series facts.
    
    Phase 3 enhancement: section-aware chunking with page_type metadata
    for filtered retrieval (e.g., only technique pages for ABILITY intents).
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
    
    # ─── Section-Aware Header Pattern ────────────────────────────────────
    # Matches headers produced by the API pipeline's FandomResult.all_content:
    #   ## [TECHNIQUES] Rasengan
    #   ## [CHARACTERS] Gojo Satoru
    _SECTION_HEADER_RE = re.compile(
        r'^##\s*\[([A-Z_]+)\]\s+(.+)$', re.MULTILINE
    )
        
    def add_profile_lore(self, profile_id: str, content: str, source: str = "research"):
        """
        Ingest narrative content for a profile.
        
        Uses section-aware chunking when content contains page-type headers
        (from the API-first pipeline). Falls back to paragraph-based chunking
        for legacy content without headers.
        """
        # Detect if content has page-type headers from the API pipeline
        if self._SECTION_HEADER_RE.search(content):
            chunks = self._chunk_by_section(content)
        else:
            chunks = self._chunk_by_paragraph(content)
        
        if not chunks:
            return
        
        # Prepare batch data
        ids = [f"{profile_id}_{uuid.uuid4()}" for _ in chunks]
        metadatas = [{
            "profile_id": profile_id,
            "source": source,
            "chunk_index": i,
            "page_type": chunk.get("page_type", "general"),
            "page_title": chunk.get("page_title", ""),
        } for i, chunk in enumerate(chunks)]
        documents = [chunk["text"] for chunk in chunks]
        
        self.collection.add(
            ids=ids,
            documents=documents,
            metadatas=metadatas
        )
        
        # Log summary
        type_counts = {}
        for chunk in chunks:
            pt = chunk.get("page_type", "general")
            type_counts[pt] = type_counts.get(pt, 0) + 1
        type_summary = ", ".join(f"{t}:{c}" for t, c in sorted(type_counts.items()))
        logger.info(f"Ingested {len(chunks)} lore chunks for {profile_id} ({type_summary})")
    
    def _chunk_by_section(self, content: str, max_chunk_size: int = 1500) -> List[Dict[str, Any]]:
        """
        Section-aware chunking for API pipeline content.
        
        Splits on `## [TYPE] Title` headers, preserving page_type and page_title
        as metadata. Long sections are sub-chunked to stay within size limits.
        """
        chunks = []
        
        # Find all section headers and their positions
        headers = list(self._SECTION_HEADER_RE.finditer(content))
        
        if not headers:
            # No headers found, fall back to paragraph chunking
            return self._chunk_by_paragraph(content)
        
        # Handle any content before the first header (e.g., synopsis)
        pre_header = content[:headers[0].start()].strip()
        if pre_header and len(pre_header) >= 50:
            for sub_chunk in self._sub_chunk(pre_header, max_chunk_size):
                chunks.append({
                    "text": sub_chunk,
                    "page_type": "general",
                    "page_title": "",
                })
        
        # Process each section
        for i, header_match in enumerate(headers):
            page_type = header_match.group(1).lower()  # e.g., "techniques"
            page_title = header_match.group(2).strip()   # e.g., "Rasengan"
            
            # Section text is from end of this header to start of next header (or EOF)
            section_start = header_match.end()
            section_end = headers[i + 1].start() if i + 1 < len(headers) else len(content)
            section_text = content[section_start:section_end].strip()
            
            if not section_text or len(section_text) < 30:
                continue  # Skip very short/empty sections
            
            # Prepend title for context in embedding
            full_text = f"{page_title}\n{section_text}"
            
            for sub_chunk in self._sub_chunk(full_text, max_chunk_size):
                chunks.append({
                    "text": sub_chunk,
                    "page_type": page_type,
                    "page_title": page_title,
                })
        
        return chunks
    
    def _sub_chunk(self, text: str, max_size: int = 1500) -> List[str]:
        """Split text into sub-chunks if it exceeds max_size, breaking on paragraphs."""
        if len(text) <= max_size:
            return [text]
        
        paragraphs = text.split("\n\n")
        sub_chunks = []
        current = ""
        
        for para in paragraphs:
            if len(current) + len(para) + 2 <= max_size:
                current = f"{current}\n\n{para}" if current else para
            else:
                if current:
                    sub_chunks.append(current.strip())
                current = para
        
        if current:
            sub_chunks.append(current.strip())
        
        return sub_chunks
    
    def _chunk_by_paragraph(self, text: str, chunk_size: int = 1000) -> List[Dict[str, Any]]:
        """
        Legacy paragraph-based chunking (for content without page-type headers).
        Returns dicts with 'text' and 'page_type' keys for consistency.
        """
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
                    chunks.append({
                        "text": current_chunk.strip(),
                        "page_type": "general",
                        "page_title": "",
                    })
                current_chunk = para
                
        if current_chunk:
            chunks.append({
                "text": current_chunk.strip(),
                "page_type": "general",
                "page_title": "",
            })
            
        return chunks
        
    def search_lore(self, profile_id: str, query: str, limit: int = 5,
                    page_type: Optional[str] = None) -> List[str]:
        """
        Search for lore relevant to the query, filtered by profile_id.
        
        Args:
            profile_id: Profile to search within
            query: Semantic search query
            limit: Max results to return
            page_type: Optional filter for page type (e.g., "techniques", "characters")
        """
        # Build where clause
        if page_type:
            where = {"$and": [
                {"profile_id": profile_id},
                {"page_type": page_type},
            ]}
        else:
            where = {"profile_id": profile_id}
        
        results = self.collection.query(
            query_texts=[query],
            n_results=limit,
            where=where
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
