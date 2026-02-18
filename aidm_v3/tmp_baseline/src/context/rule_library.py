"""
Rule Library for AIDM v3.

Manages the RAG system for narrative guidance chunks extracted from 
Module 12 (Narrative Scaling) and Module 13 (Narrative Calibration).

Chunks are stored as YAML files in aidm_v3/rule_library/ and indexed
in ChromaDB for semantic retrieval.
"""

import chromadb
import yaml
import os
from pathlib import Path
from typing import List, Dict, Any, Optional
from pydantic import BaseModel


class RuleChunk(BaseModel):
    """A single retrievable rule/guidance chunk."""
    id: str
    category: str  # scale, archetype, ceremony, dna, genre, example
    source_module: str  # module_12 or module_13
    tags: List[str]
    retrieve_conditions: List[str] = []
    content: str


class RuleLibrary:
    """
    Manages the RAG system for narrative guidance chunks.
    
    Loads YAML chunks from rule_library/ directory and indexes them
    in ChromaDB for semantic retrieval.
    """
    
    def __init__(
        self, 
        persist_dir: str = "./data/chroma",
        library_dir: Optional[str] = None
    ):
        self.client = chromadb.PersistentClient(path=persist_dir)
        
        # Find library directory
        if library_dir:
            self.library_dir = Path(library_dir)
        else:
            # Try relative to this file
            self.library_dir = Path(__file__).parent.parent.parent / "rule_library"
        
        # Collection for rule chunks
        self.collection = self.client.get_or_create_collection(
            name="rule_library_v2",
            metadata={"hnsw:space": "cosine"}
        )
        
        # Track loaded chunks
        self._chunks: Dict[str, RuleChunk] = {}
        
        # Initialize if empty
        if self.collection.count() == 0:
            self.initialize()
    
    def initialize(self):
        """Load all YAML chunks from library directory and index them."""
        if not self.library_dir.exists():
            print(f"Warning: Rule library directory not found at {self.library_dir}")
            return
        
        print(f"Initializing Rule Library from {self.library_dir}...")
        
        chunks_loaded = 0
        
        # Load all YAML files
        for yaml_file in self.library_dir.glob("**/*.yaml"):
            try:
                chunks = self._load_yaml_file(yaml_file)
                chunks_loaded += len(chunks)
            except Exception as e:
                print(f"Error loading {yaml_file}: {e}")
        
        print(f"Loaded {chunks_loaded} chunks into Rule Library.")
    
    def _load_yaml_file(self, file_path: Path) -> List[RuleChunk]:
        """Load chunks from a YAML file."""
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # YAML files contain multiple documents separated by ---
        chunks = []
        for doc in yaml.safe_load_all(content):
            if doc is None:
                continue
            
            # Handle both single chunk and list of chunks
            if isinstance(doc, list):
                for item in doc:
                    chunk = self._parse_chunk(item)
                    if chunk:
                        chunks.append(chunk)
                        self._index_chunk(chunk)
            elif isinstance(doc, dict):
                chunk = self._parse_chunk(doc)
                if chunk:
                    chunks.append(chunk)
                    self._index_chunk(chunk)
        
        return chunks
    
    def _parse_chunk(self, data: Dict) -> Optional[RuleChunk]:
        """Parse a dict into a RuleChunk."""
        if not data or 'id' not in data or 'content' not in data:
            return None
        
        return RuleChunk(
            id=data['id'],
            category=data.get('category', 'unknown'),
            source_module=data.get('source_module', 'unknown'),
            tags=data.get('tags', []),
            retrieve_conditions=data.get('retrieve_conditions', []),
            content=data['content']
        )
    
    def _index_chunk(self, chunk: RuleChunk):
        """Index a chunk in ChromaDB."""
        self._chunks[chunk.id] = chunk
        
        # Prepare metadata
        metadata = {
            "category": chunk.category,
            "source_module": chunk.source_module,
            "tags": ",".join(chunk.tags),
            "conditions": ",".join(chunk.retrieve_conditions)
        }
        
        # Add to collection
        self.collection.upsert(
            ids=[chunk.id],
            documents=[chunk.content],
            metadatas=[metadata]
        )
    
    def retrieve(
        self, 
        query: str, 
        limit: int = 5,
        category: Optional[str] = None,
        tags: Optional[List[str]] = None
    ) -> List[Dict[str, Any]]:
        """
        Retrieve relevant chunks based on semantic search.
        
        Args:
            query: Search query (e.g., "how to narrate tactical combat")
            limit: Maximum results to return
            category: Filter by category (scale, archetype, ceremony, dna, genre)
            tags: Filter by tags (must have at least one)
            
        Returns:
            List of dicts with chunk content and metadata
        """
        # Build where clause for filtering
        where = None
        if category:
            where = {"category": category}
        
        results = self.collection.query(
            query_texts=[query],
            n_results=limit,
            where=where
        )
        
        chunks = []
        if results["ids"]:
            ids = results["ids"][0]
            documents = results["documents"][0]
            metadatas = results["metadatas"][0]
            distances = results["distances"][0] if results.get("distances") else [0] * len(ids)
            
            for i, chunk_id in enumerate(ids):
                # Optional tag filtering (post-query)
                if tags:
                    chunk_tags = metadatas[i].get("tags", "").split(",")
                    if not any(t in chunk_tags for t in tags):
                        continue
                
                chunks.append({
                    "id": chunk_id,
                    "content": documents[i],
                    "category": metadatas[i].get("category"),
                    "tags": metadatas[i].get("tags", "").split(","),
                    "score": 1.0 - distances[i]
                })
        
        return chunks
    
    def get_relevant_rules(self, query: str, limit: int = 5) -> str:
        """
        Retrieve relevant rules as a formatted string context.
        (Backwards compatible with old interface)
        """
        chunks = self.retrieve(query, limit=limit)
        
        context_parts = []
        for chunk in chunks:
            category = chunk.get("category", "unknown")
            context_parts.append(
                f"--- {category.upper()} Guidance ---\n{chunk['content']}"
            )
        
        return "\n\n".join(context_parts)
    
    def get_by_category(self, category: str, limit: int = 10) -> List[Dict[str, Any]]:
        """Get all chunks of a specific category."""
        return self.retrieve(
            query=f"{category} guidance",
            limit=limit,
            category=category
        )
    
    def get_scale_guidance(self, scale_name: str) -> Optional[str]:
        """Get guidance for a specific narrative scale."""
        chunks = self.retrieve(
            query=f"{scale_name} narrative scale",
            limit=1,
            category="scale"
        )
        return chunks[0]["content"] if chunks else None
    
    def get_archetype_guidance(self, archetype: str) -> Optional[str]:
        """Get guidance for a specific OP archetype (legacy - use get_op_axis_guidance for 3-axis)."""
        chunks = self.retrieve(
            query=f"{archetype} archetype techniques",
            limit=1,
            category="archetype"
        )
        return chunks[0]["content"] if chunks else None
    
    def get_op_axis_guidance(self, axis: str, value: str) -> Optional[str]:
        """
        Get guidance for a specific OP mode axis value.
        
        Args:
            axis: Which axis (tension, expression, focus)
            value: The value (e.g., "existential", "instantaneous", "faction")
            
        Returns:
            Guidance content for that axis value
        """
        if not value:
            return None
            
        # Map axis to category
        category_map = {
            "tension": "op_tension",
            "expression": "op_expression", 
            "focus": "op_focus"
        }
        
        category = category_map.get(axis)
        if not category:
            return None
        
        chunks = self.retrieve(
            query=f"{value} {axis} OP protagonist mode",
            limit=1,
            category=category
        )
        return chunks[0]["content"] if chunks else None
    
    def get_by_id(self, doc_id: str) -> Optional[str]:
        """
        Get a document by its exact ID.
        
        Args:
            doc_id: The document ID (e.g., "ceremony_t8_t7", "archetype_saitama")
            
        Returns:
            Document content or None if not found
        """
        try:
            results = self.collection.get(ids=[doc_id])
            if results["documents"] and results["documents"][0]:
                return results["documents"][0]
        except Exception:
            pass
        return None
    
    def get_ceremony_text(self, old_tier: int, new_tier: int) -> Optional[str]:
        """
        Get tier transition ceremony text by exact ID lookup.
        
        Args:
            old_tier: Previous tier number (e.g., 8 for T8)
            new_tier: New tier number (e.g., 7 for T7)
        """
        # Direct ID lookup - ceremonies use format "ceremony_t8_t7"
        doc_id = f"ceremony_t{old_tier}_t{new_tier}"
        return self.get_by_id(doc_id)
    
    def get_compatibility_guidance(self, tier: int, scale: str) -> Optional[str]:
        """
        Get Director guidance for tier×scale combinations.
        
        Args:
            tier: Character's power tier (0-11)
            scale: Story scale (personal, local, continental, planetary, cosmic, ensemble, mythic)
            
        Returns:
            Guidance for handling this combination, including:
            - Compatibility assessment
            - Recommended archetypes
            - Narrative techniques
            - Examples
        """
        # Determine tier range label for better matching
        if tier <= 3:
            tier_label = "low tier"
        elif tier <= 7:
            tier_label = "mid tier"
        else:
            tier_label = "high tier"
            
        chunks = self.retrieve(
            query=f"{tier_label} tier {tier} {scale} scale compatibility guidance",
            limit=1,
            category="compatibility"
        )
        return chunks[0]["content"] if chunks else None
    
    def get_power_tier_guidance(self, tier: int) -> Optional[str]:
        """
        Get full power tier definition + narrative guidance.
        
        Args:
            tier: Power tier (0-11)
            
        Returns:
            Full tier guidance including:
            - VS Battles definition
            - Scale compatibility
            - Combat/Focus/Challenges guidance
            - Examples
        """
        chunks = self.retrieve(
            query=f"power tier T{tier} narrative guidance scale compatibility",
            limit=1,
            category="power_tier"
        )
        return chunks[0]["content"] if chunks else None
    
    def get_genre_guidance(self, genre: str, topic: str = "") -> Optional[str]:
        """
        Get structural guidance for a genre.
        
        Args:
            genre: Genre name (shonen, mystery, seinen, isekai, comedy, horror, slice_of_life)
            topic: Optional specific topic (e.g., "training arc", "investigation")
            
        Returns:
            Genre guidance with core elements and techniques
        """
        query = f"{genre} genre"
        if topic:
            query += f" {topic}"
        
        chunks = self.retrieve(
            query=query,
            limit=1,
            category="genre"
        )
        return chunks[0]["content"] if chunks else None
    
    def get_dna_guidance(self, scale_name: str, value: int) -> Optional[str]:
        """Get narration guidance for a DNA scale value."""
        # Determine if low (0-3), mid (4-6), or high (7-10)
        if value <= 3:
            level = "low"
        elif value >= 7:
            level = "high"
        else:
            level = "mid"
        
        chunks = self.retrieve(
            query=f"{scale_name} {level} DNA narration style",
            limit=1,
            category="dna"
        )
        return chunks[0]["content"] if chunks else None
    
    def get_tension_guidance(self, archetype: str, power_imbalance: float) -> Optional[str]:
        """
        Get appropriate tension guidance based on archetype and power imbalance.
        
        For high power imbalance (>10), returns non-combat tension types.
        
        Args:
            archetype: OP archetype (saitama, mob, overlord, etc.)
            power_imbalance: PC power ÷ threat power
            
        Returns:
            Tension guidance string or None
        """
        if power_imbalance <= 3:
            return None  # Standard combat is fine
        
        # Select tension type based on archetype
        tension_type = "structural"  # Default
        
        archetype_tensions = {
            "saitama": "existential",
            "mob": "existential",
            "overlord": "social",
            "saiki_k": "social",
            "wang_ling": "social",
            "disguised_god": "social",
            "vampire_d": "existential",
            "rimuru": "ensemble",
            "mashle": "structural"
        }
        
        if archetype and archetype.lower() in archetype_tensions:
            tension_type = archetype_tensions[archetype.lower()]
        
        # Retrieve from RAG
        chunks = self.retrieve(
            query=f"{tension_type} tension OP protagonist",
            limit=1,
            category="tension"
        )
        
        return chunks[0]["content"] if chunks else None
    
    def count(self) -> int:
        """Get total number of indexed chunks."""
        return self.collection.count()
    
    def close(self):
        """Cleanup if needed."""
        pass


# Convenience function
def get_rule_library(persist_dir: str = "./data/chroma") -> RuleLibrary:
    """Get a RuleLibrary instance."""
    return RuleLibrary(persist_dir=persist_dir)
