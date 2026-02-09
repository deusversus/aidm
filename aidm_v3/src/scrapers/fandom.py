"""
Fandom MediaWiki API Client for AIDM v3.

Fetches detailed lore content from Fandom wikis using the MediaWiki API's
parsed HTML endpoint (action=parse) to avoid raw wikitext template complexity.

Key design decisions (validated in Phase 0 feasibility spike):
- Uses action=parse (parsed HTML) instead of raw wikitext
- Strips HTML to clean markdown-like text
- Follows redirects automatically (redirects=true)
- Strips navboxes, infoboxes, references, galleries
- Category discovery delegated to wiki_normalize module

Rate limiting: Fandom doesn't document explicit rate limits but
we implement 200ms delays between requests as a courtesy.
"""

import asyncio
import html as html_module
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Optional

import requests

from .wiki_normalize import CategoryMapping, discover_categories
from .wiki_scout import WikiScrapePlan, plan_wiki_scrape

logger = logging.getLogger(__name__)


# ─── Config ──────────────────────────────────────────────────────────────────

REQUEST_DELAY = 0.2  # seconds between requests (rate limiting courtesy)
REQUEST_TIMEOUT = 15  # seconds
MAX_RETRIES = 3

# MediaWiki namespaces that are NOT real articles — skip these when scraping
NON_ARTICLE_PREFIXES = (
    "Template:", "User:", "Category:", "File:", "MediaWiki:",
    "Module:", "Draft:", "Help:", "Talk:", "User talk:",
    "Template talk:", "Forum:", "Thread:", "Message Wall:",
    "Board:", "Blog:",
)


# ─── Data Classes ────────────────────────────────────────────────────────────

@dataclass
class WikiPage:
    """A single parsed wiki page."""
    title: str
    clean_text: str
    sections: list[str] = field(default_factory=list)
    categories: list[str] = field(default_factory=list)
    page_type: Optional[str] = None  # canonical type: "characters", "techniques", etc.
    raw_html_length: int = 0
    clean_text_length: int = 0
    quotes: list[str] = field(default_factory=list)


@dataclass
class FandomResult:
    """Complete structured result from a Fandom wiki scrape."""
    wiki_url: str
    wiki_name: str  # e.g., "naruto", "jujutsu-kaisen"
    
    # Wiki stats
    article_count: int = 0
    total_categories: int = 0
    
    # Category discovery results
    category_mapping: Optional[CategoryMapping] = None
    
    # Scraped pages by canonical type
    pages: dict[str, list[WikiPage]] = field(default_factory=dict)
    
    # All raw text (for RAG ingestion)
    all_content: str = ""
    
    # Errors encountered
    errors: list[str] = field(default_factory=list)
    
    def get_pages_by_type(self, page_type: str) -> list[WikiPage]:
        """Get all scraped pages for a canonical type."""
        return self.pages.get(page_type, [])
    
    def get_all_character_names(self) -> list[str]:
        """Get all character page titles."""
        return [p.title for p in self.pages.get("characters", [])]
    
    def get_total_page_count(self) -> int:
        """Total number of scraped pages across all types."""
        return sum(len(pages) for pages in self.pages.values())


# ─── Wiki URL Discovery ─────────────────────────────────────────────────────

# Common Fandom wiki URL patterns for anime series
# Format: search_term → wiki subdomain
# Most anime wikis follow patterns like: {series-name}.fandom.com
WIKI_URL_OVERRIDES = {
    # Cases where the wiki name doesn't match the obvious title
    "attack on titan": "https://attackontitan.fandom.com",
    "shingeki no kyojin": "https://attackontitan.fandom.com",
    "my hero academia": "https://myheroacademia.fandom.com",
    "boku no hero academia": "https://myheroacademia.fandom.com",
    "hunter x hunter": "https://hunterxhunter.fandom.com",
    "jujutsu kaisen": "https://jujutsu-kaisen.fandom.com",
    "demon slayer": "https://kimetsu-no-yaiba.fandom.com",
    "kimetsu no yaiba": "https://kimetsu-no-yaiba.fandom.com",
    "fullmetal alchemist": "https://fma.fandom.com",
    "fullmetal alchemist brotherhood": "https://fma.fandom.com",
    "dragon ball": "https://dragonball.fandom.com",
    "dragon ball z": "https://dragonball.fandom.com",
    "dragon ball super": "https://dragonball.fandom.com",
    "one piece": "https://onepiece.fandom.com",
    "naruto": "https://naruto.fandom.com",
    "naruto shippuden": "https://naruto.fandom.com",
    "bleach": "https://bleach.fandom.com",
    "black clover": "https://blackclover.fandom.com",
    "fairy tail": "https://fairytail.fandom.com",
    "sword art online": "https://swordartonline.fandom.com",
    "re:zero": "https://rezero.fandom.com",
    "death note": "https://deathnote.fandom.com",
    "code geass": "https://codegeass.fandom.com",
    "chainsaw man": "https://chainsaw-man.fandom.com",
    "spy x family": "https://spy-x-family.fandom.com",
    "mob psycho 100": "https://mob-psycho-100.fandom.com",
    "one punch man": "https://onepunchman.fandom.com",
    "tokyo ghoul": "https://tokyoghoul.fandom.com",
    "solo leveling": "https://solo-leveling.fandom.com",
    "overlord": "https://overlordmaruyama.fandom.com",
    "konosuba": "https://konosuba.fandom.com",
    # Titles where romaji/English slug doesn't match the wiki
    "frieren": "https://frieren.fandom.com",
    "frieren beyond journey's end": "https://frieren.fandom.com",
    "sousou no frieren": "https://frieren.fandom.com",
    "that time i got reincarnated as a slime": "https://tensura.fandom.com",
    "tensei shitara slime datta ken": "https://tensura.fandom.com",
    "mushoku tensei": "https://mushokutensei.fandom.com",
    "the rising of the shield hero": "https://shield-hero.fandom.com",
    "tate no yuusha no nariagari": "https://shield-hero.fandom.com",
    "is it wrong to try to pick up girls in a dungeon": "https://danmachi.fandom.com",
    "danmachi": "https://danmachi.fandom.com",
    "neon genesis evangelion": "https://evangelion.fandom.com",
    "cowboy bebop": "https://cowboybebop.fandom.com",
    "ghost in the shell": "https://ghostintheshell.fandom.com",
    "vinland saga": "https://vinlandsaga.fandom.com",
    "jojo's bizarre adventure": "https://jojo.fandom.com",
    "jojos bizarre adventure": "https://jojo.fandom.com",
    "fire force": "https://fire-force.fandom.com",
    "enen no shouboutai": "https://fire-force.fandom.com",
    "hell's paradise": "https://hells-paradise.fandom.com",
    "jigokuraku": "https://hells-paradise.fandom.com",
    "kaiju no. 8": "https://kaiju-no-8.fandom.com",
    "dandadan": "https://dandadan.fandom.com",
    "berserk": "https://berserk.fandom.com",
    "princess mononoke": "https://ghibli.fandom.com",
    "akira": "https://akira.fandom.com",
}


def guess_wiki_url(title: str) -> str:
    """
    Guess the Fandom wiki URL for an anime title (primary guess only).
    Returns the best single guess — the override or slug from the full title.
    """
    candidates = guess_wiki_url_candidates(title)
    return candidates[0] if candidates else f"https://{_title_to_slug(title)}.fandom.com"


def _title_to_slug(title: str) -> str:
    """Convert a title string to a Fandom URL slug."""
    slug = re.sub(r'[^a-z0-9\s-]', '', title.lower().strip())
    slug = re.sub(r'[\s]+', '-', slug).strip('-')
    return slug


def guess_wiki_url_candidates(title: str) -> list:
    """
    Generate multiple candidate Fandom wiki URLs for an anime title.
    
    Strategy (ordered by likelihood):
    1. Check known overrides
    2. Full title slug (e.g., "jujutsu-kaisen")
    3. First significant word (e.g., "frieren" from "Frieren: Beyond Journey's End")
    4. Text before colon/dash subtitle (e.g., "frieren" from "Frieren: Beyond...")
    """
    title_lower = title.lower().strip()
    
    # Check overrides first
    if title_lower in WIKI_URL_OVERRIDES:
        return [WIKI_URL_OVERRIDES[title_lower]]
    
    seen = set()
    candidates = []
    
    def _add(url: str):
        if url not in seen:
            seen.add(url)
            candidates.append(url)
    
    # Full title slug
    full_slug = _title_to_slug(title_lower)
    if full_slug:
        _add(f"https://{full_slug}.fandom.com")
    
    # First significant word (skip articles/particles)
    SKIP_WORDS = {'the', 'a', 'an', 'no', 'na', 'ni', 'wa', 'ga', 'wo', 'de', 'to', 'ka'}
    words = re.sub(r'[^a-z0-9\s]', '', title_lower).split()
    significant = [w for w in words if w not in SKIP_WORDS and len(w) > 2]
    if significant:
        _add(f"https://{significant[0]}.fandom.com")
    
    # Text before colon or dash as subtitle separator
    for sep in [':', ' - ', ' – ']:
        if sep in title:
            prefix = title.split(sep)[0].strip()
            prefix_slug = _title_to_slug(prefix)
            if prefix_slug and len(prefix_slug) > 2:
                _add(f"https://{prefix_slug}.fandom.com")
    
    # Hyphenated full slug if not already (e.g., "kaiju-no-8")
    hyphenated = title_lower.replace(' ', '-')
    hyphenated = re.sub(r'[^a-z0-9-]', '', hyphenated).strip('-')
    if hyphenated:
        _add(f"https://{hyphenated}.fandom.com")
    
    return candidates


# ─── HTML Cleaning ───────────────────────────────────────────────────────────

def strip_html_to_text(html_content: str) -> str:
    """
    Strip HTML from parsed MediaWiki output to get clean, readable text.
    
    Handles Fandom-specific junk: navboxes, portable infoboxes, edit section
    links, references, galleries, and table-of-contents elements.
    """
    text = html_content
    
    # Remove portable infoboxes (Fandom's modern infobox format)
    text = re.sub(
        r'<aside[^>]*class="[^"]*portable-infobox[^"]*"[^>]*>.*?</aside>',
        '', text, flags=re.DOTALL | re.IGNORECASE
    )
    
    # Remove table-based infoboxes
    text = re.sub(
        r'<table[^>]*class="[^"]*infobox[^"]*"[^>]*>.*?</table>',
        '', text, flags=re.DOTALL | re.IGNORECASE
    )
    
    # Remove navbox tables
    text = re.sub(
        r'<table[^>]*class="[^"]*navbox[^"]*"[^>]*>.*?</table>',
        '', text, flags=re.DOTALL | re.IGNORECASE
    )
    
    # Remove table of contents
    text = re.sub(r'<div[^>]*id="toc"[^>]*>.*?</div>', '', text, flags=re.DOTALL)
    
    # Remove edit section links
    text = re.sub(r'<span class="mw-editsection">.*?</span>', '', text, flags=re.DOTALL)
    
    # Remove reference superscripts
    text = re.sub(r'<sup[^>]*class="[^"]*reference[^"]*"[^>]*>.*?</sup>', '', text, flags=re.DOTALL)
    
    # Remove reference lists
    text = re.sub(r'<ol class="references">.*?</ol>', '', text, flags=re.DOTALL)
    
    # Remove figure/gallery elements
    text = re.sub(r'<figure[^>]*>.*?</figure>', '', text, flags=re.DOTALL)
    text = re.sub(r'<div[^>]*class="[^"]*gallery[^"]*"[^>]*>.*?</div>', '', text, flags=re.DOTALL)
    
    # Remove script and style tags
    text = re.sub(r'<script[^>]*>.*?</script>', '', text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL | re.IGNORECASE)
    
    # Convert headers to markdown
    for i in range(6, 0, -1):
        text = re.sub(
            rf'<h{i}[^>]*>(.*?)</h{i}>',
            lambda m: f"\n{'#' * i} {m.group(1).strip()}\n",
            text, flags=re.DOTALL
        )
    
    # Convert paragraphs
    text = re.sub(r'<p[^>]*>(.*?)</p>', r'\1\n\n', text, flags=re.DOTALL)
    
    # Convert list items
    text = re.sub(r'<li[^>]*>(.*?)</li>', r'- \1\n', text, flags=re.DOTALL)
    
    # Convert line breaks
    text = re.sub(r'<br\s*/?>', '\n', text, flags=re.IGNORECASE)
    
    # Convert bold/italic
    text = re.sub(r'<b>(.*?)</b>', r'**\1**', text, flags=re.DOTALL)
    text = re.sub(r'<strong>(.*?)</strong>', r'**\1**', text, flags=re.DOTALL)
    text = re.sub(r'<i>(.*?)</i>', r'*\1*', text, flags=re.DOTALL)
    text = re.sub(r'<em>(.*?)</em>', r'*\1*', text, flags=re.DOTALL)
    
    # Strip all remaining HTML tags
    text = re.sub(r'<[^>]+>', '', text)
    
    # Decode HTML entities
    text = html_module.unescape(text)
    
    # Second pass: catch <br> tags that were HTML-encoded entities decoded by unescape
    text = re.sub(r'<br\s*/?>',  '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'<[^>]+>', '', text)  # catch any other decoded tags
    
    # Clean up whitespace
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = re.sub(r' +', ' ', text)
    text = text.strip()
    
    return text


# ─── Noise Section Filtering ─────────────────────────────────────────────────

# Sections that add no narrative value and pollute RAG retrieval
SECTIONS_TO_STRIP = {
    "manga appearance", "anime appearance",
    "references", "notes", "site navigation",
    "navigation", "gallery", "image gallery",
    "external links",
}


def _strip_noise_sections(text: str) -> str:
    """
    Remove wiki-structural sections that add no narrative value.
    
    Strips entire sections like 'Manga Appearance' (chapter tracking lists),
    'Anime Appearance' (episode lists), 'References', 'Site Navigation', etc.
    Sections are identified by heading markers (## Heading]) and stripped
    until the next heading at the same or higher level.
    """
    lines = text.split('\n')
    output = []
    skipping = False
    skip_depth = 0
    
    for line in lines:
        # Check if this line is a markdown heading
        stripped = line.lstrip()
        if stripped.startswith('#'):
            # Count heading depth
            depth = len(stripped) - len(stripped.lstrip('#'))
            # Extract heading text, strip trailing ] and whitespace
            heading_text = stripped.lstrip('#').strip().rstrip(']').strip().lower()
            
            if any(noise in heading_text for noise in SECTIONS_TO_STRIP):
                skipping = True
                skip_depth = depth
                continue
            elif skipping and depth <= skip_depth:
                # New section at same or higher level — stop skipping
                skipping = False
        
        if not skipping:
            output.append(line)
    
    return '\n'.join(output)


def extract_quotes(text: str) -> list[str]:
    """Extract dialogue quotes from cleaned wiki text."""
    quotes = []
    # Standard double-quoted (20+ chars to filter noise)
    quotes.extend(re.findall(r'"([^"]{20,300})"', text))
    # Japanese-style quotes
    quotes.extend(re.findall(r'「([^」]{10,300})」', text))
    # Deduplicate while preserving order
    seen = set()
    unique = []
    for q in quotes:
        if q not in seen:
            seen.add(q)
            unique.append(q)
    return unique[:20]


# ─── Client ──────────────────────────────────────────────────────────────────

class FandomClient:
    """Async-compatible Fandom MediaWiki API client."""
    
    def __init__(self):
        self._session = requests.Session()
        self._session.headers.update({
            "User-Agent": "AIDM-v3/1.0 (Anime RPG Research; contact@example.com)",
        })
        self._last_request_time = 0.0
    
    def _rate_limit(self):
        """Enforce minimum delay between requests."""
        now = time.time()
        elapsed = now - self._last_request_time
        if elapsed < REQUEST_DELAY:
            time.sleep(REQUEST_DELAY - elapsed)
        self._last_request_time = time.time()
    
    def _api_query(self, base_url: str, params: dict) -> dict:
        """Make a MediaWiki API query with error handling and retries."""
        api_url = f"{base_url}/api.php"
        params["format"] = "json"
        
        for attempt in range(MAX_RETRIES):
            self._rate_limit()
            try:
                resp = self._session.get(api_url, params=params, timeout=REQUEST_TIMEOUT)
                resp.raise_for_status()
                return resp.json()
            except requests.RequestException as e:
                logger.warning(f"Fandom API error (attempt {attempt+1}): {e}")
                if attempt < MAX_RETRIES - 1:
                    time.sleep(2 ** attempt)
        
        return {"error": "max retries exceeded"}
    
    def _get_site_stats(self, base_url: str) -> dict:
        """Get wiki article count and other stats."""
        result = self._api_query(base_url, {
            "action": "query",
            "meta": "siteinfo",
            "siprop": "statistics",
        })
        return result.get("query", {}).get("statistics", {})
    
    def _get_all_categories(self, base_url: str, limit: int = 500) -> list[str]:
        """Fetch all category names from the wiki."""
        result = self._api_query(base_url, {
            "action": "query",
            "list": "allcategories",
            "aclimit": str(limit),
        })
        return [c["*"] for c in result.get("query", {}).get("allcategories", [])]
    
    def _get_category_members(
        self, base_url: str, category: str, limit: int = 50
    ) -> list[str]:
        """Get page titles belonging to a category."""
        result = self._api_query(base_url, {
            "action": "query",
            "list": "categorymembers",
            "cmtitle": f"Category:{category}",
            "cmlimit": str(limit),
            "cmtype": "page",
        })
        return [m["title"] for m in result.get("query", {}).get("categorymembers", [])]
    
    def _get_page_parsed(self, base_url: str, title: str) -> dict:
        """
        Get page via action=parse (parsed HTML).
        Automatically follows redirects.
        """
        result = self._api_query(base_url, {
            "action": "parse",
            "page": title,
            "prop": "text|sections|categories",
            "redirects": "true",
            "disabletoc": "true",
        })
        return result.get("parse", {})
    
    def _parse_page(
        self, base_url: str, title: str, page_type: Optional[str] = None
    ) -> Optional[WikiPage]:
        """Fetch and parse a single wiki page into clean text."""
        parsed = self._get_page_parsed(base_url, title)
        
        if not parsed or "error" in parsed:
            return None
        
        raw_html = parsed.get("text", {}).get("*", "")
        if not raw_html:
            return None
        
        clean_text = strip_html_to_text(raw_html)
        clean_text = _strip_noise_sections(clean_text)
        
        # Skip very short pages (likely stubs or disambig)
        if len(clean_text) < 50:
            logger.debug(f"Skipping stub page: {title} ({len(clean_text)} chars)")
            return None
        
        sections = [s["line"] for s in parsed.get("sections", [])]
        categories = [c["*"] for c in parsed.get("categories", [])]
        quotes = extract_quotes(clean_text) if page_type == "characters" else []
        
        return WikiPage(
            title=title,
            clean_text=clean_text,
            sections=sections,
            categories=categories,
            page_type=page_type,
            raw_html_length=len(raw_html),
            clean_text_length=len(clean_text),
            quotes=quotes,
        )
    
    # ─── Main Scrape Method ──────────────────────────────────────────────
    
    async def scrape_wiki(
        self,
        wiki_url: str,
        max_pages_per_type: int = 25,
        character_limit: int = 15,
        anime_title: str = "",
    ) -> FandomResult:
        """
        Scrape a Fandom wiki: discover categories, fetch pages, extract text.
        
        Uses WikiScout (LLM) to classify categories, with legacy fallback.
        Runs blocking HTTP in a thread pool to stay async-compatible.
        
        Args:
            wiki_url: Base URL of the Fandom wiki (e.g., "https://naruto.fandom.com")
            max_pages_per_type: Max pages to scrape per canonical type
            character_limit: Max character pages to scrape (usually fewer needed)
            anime_title: The anime/manga title (used by WikiScout for context)
            
        Returns:
            FandomResult with all scraped content
        """
        # Step 1: Get categories (sync HTTP, run in executor)
        loop = asyncio.get_event_loop()
        all_cats = await loop.run_in_executor(
            None, self._get_all_categories, wiki_url
        )
        
        # Step 2: WikiScout classification (async LLM call)
        scrape_plan = None
        if anime_title and all_cats:
            scrape_plan = await plan_wiki_scrape(wiki_url, anime_title, all_cats)
            if not scrape_plan.categories:
                logger.warning("[Fandom] WikiScout returned empty plan, falling back to legacy")
                scrape_plan = None
        
        # Step 3: Execute scraping (sync HTTP, run in executor)
        return await loop.run_in_executor(
            None,
            self._scrape_wiki_sync,
            wiki_url,
            max_pages_per_type,
            character_limit,
            all_cats,
            scrape_plan,
        )
    
    def _scrape_wiki_sync(
        self,
        wiki_url: str,
        max_pages_per_type: int,
        character_limit: int,
        all_cats: list[str] | None = None,
        scrape_plan: WikiScrapePlan | None = None,
    ) -> FandomResult:
        """Synchronous wiki scraping implementation.
        
        Args:
            wiki_url: Base URL of the Fandom wiki
            max_pages_per_type: Max pages to scrape per canonical type
            character_limit: Max character pages to scrape
            all_cats: Pre-fetched category list (from async wrapper)
            scrape_plan: WikiScout LLM plan (None = use legacy normalizer)
        """
        
        # Extract wiki name from URL
        wiki_name = wiki_url.replace("https://", "").replace("http://", "").split(".")[0]
        
        result = FandomResult(
            wiki_url=wiki_url,
            wiki_name=wiki_name,
        )
        
        # Step 1: Get wiki stats
        logger.info(f"[Fandom] Fetching stats for {wiki_url}...")
        stats = self._get_site_stats(wiki_url)
        result.article_count = stats.get("articles", 0)
        
        if result.article_count == 0:
            result.errors.append("Wiki appears to be empty or inaccessible")
            return result
        
        logger.info(f"[Fandom] {wiki_name}: {result.article_count} articles")
        
        # Step 2: Category discovery
        if all_cats is None:
            all_cats = self._get_all_categories(wiki_url)
        result.total_categories = len(all_cats)
        
        # Use WikiScout plan if available, otherwise fall back to legacy
        if scrape_plan and scrape_plan.categories:
            logger.info(f"[Fandom] Using WikiScout plan ({len(scrape_plan.categories)} categories)")
            return self._execute_scout_plan(wiki_url, result, scrape_plan, max_pages_per_type, character_limit)
        else:
            logger.info(f"[Fandom] Using legacy category discovery")
            mapping = discover_categories(all_cats, wiki_url)
            result.category_mapping = mapping
            logger.info(f"[Fandom] Category discovery: {mapping.discovery_rate}")
            return self._execute_legacy_scrape(wiki_url, result, mapping, max_pages_per_type, character_limit)
    
    def _execute_scout_plan(
        self,
        wiki_url: str,
        result: FandomResult,
        plan: WikiScrapePlan,
        max_pages_per_type: int,
        character_limit: int,
    ) -> FandomResult:
        """Execute a WikiScout scraping plan."""
        all_text_sections = []
        
        # Group categories by canonical type, sorted by priority
        type_categories: dict[str, list] = {}
        for sel in sorted(plan.categories, key=lambda s: s.priority):
            if sel.priority > 2:  # Skip "nice-to-have" in default mode
                continue
            if sel.canonical_type not in type_categories:
                type_categories[sel.canonical_type] = []
            type_categories[sel.canonical_type].append(sel)
        
        for canonical_type, selections in type_categories.items():
            # Determine page limit for this type
            page_limit = character_limit if canonical_type == "characters" else max_pages_per_type
            
            type_pages = []
            pages_remaining = page_limit
            
            for sel in selections:
                if pages_remaining <= 0:
                    break
                
                members = self._get_category_members(wiki_url, sel.wiki_category, limit=pages_remaining)
                logger.info(
                    f"[Fandom] Scraping {len(members)} '{canonical_type}' pages "
                    f"(from '{sel.wiki_category}', priority={sel.priority})..."
                )
                
                # Filter non-article namespace pages
                members = [t for t in members if not t.startswith(NON_ARTICLE_PREFIXES)]
                
                for title in members:
                    if pages_remaining <= 0:
                        break
                    page = self._parse_page(wiki_url, title, page_type=canonical_type)
                    if page:
                        type_pages.append(page)
                        all_text_sections.append(
                            f"\n## [{canonical_type.upper()}] {page.title}\n{page.clean_text}"
                        )
                        pages_remaining -= 1
            
            if type_pages:
                result.pages[canonical_type] = type_pages
                logger.info(f"[Fandom]   → {len(type_pages)} '{canonical_type}' pages extracted")
        
        # Combine all text for RAG
        result.all_content = "\n\n".join(all_text_sections)
        
        total_pages = result.get_total_page_count()
        total_chars = len(result.all_content)
        logger.info(
            f"[Fandom] Scrape complete: {total_pages} pages, "
            f"{total_chars:,} chars total content"
        )
        
        return result
    
    def _execute_legacy_scrape(
        self,
        wiki_url: str,
        result: FandomResult,
        mapping: CategoryMapping,
        max_pages_per_type: int,
        character_limit: int,
    ) -> FandomResult:
        """Execute scraping using legacy discover_categories mapping."""
        all_text_sections = []
        
        for canonical_type in mapping.types_found:
            primary_cat = mapping.primary[canonical_type]
            if not primary_cat:
                continue
            
            # Determine page limit for this type
            page_limit = character_limit if canonical_type == "characters" else max_pages_per_type
            
            # Get category members
            members = self._get_category_members(wiki_url, primary_cat, limit=page_limit)
            logger.info(
                f"[Fandom] Scraping {len(members)} '{canonical_type}' pages "
                f"(from category '{primary_cat}')..."
            )
            
            # Filter out non-article namespace pages (Template:, User:, etc.)
            members = [t for t in members if not t.startswith(NON_ARTICLE_PREFIXES)]
            
            # Scrape each page
            type_pages = []
            for title in members:
                page = self._parse_page(wiki_url, title, page_type=canonical_type)
                if page:
                    type_pages.append(page)
                    # Add to combined text with type header
                    all_text_sections.append(
                        f"\n## [{canonical_type.upper()}] {page.title}\n{page.clean_text}"
                    )
            
            result.pages[canonical_type] = type_pages
            logger.info(f"[Fandom]   → {len(type_pages)} pages extracted")
        
        # Combine all text for RAG
        result.all_content = "\n\n".join(all_text_sections)
        
        total_pages = result.get_total_page_count()
        total_chars = len(result.all_content)
        logger.info(
            f"[Fandom] Scrape complete: {total_pages} pages, "
            f"{total_chars:,} chars total content"
        )
        
        return result
    
    async def check_wiki_exists(self, wiki_url: str) -> bool:
        """Quick check if a Fandom wiki exists and has content."""
        loop = asyncio.get_event_loop()
        
        def _check():
            stats = self._get_site_stats(wiki_url)
            return stats.get("articles", 0) > 0
        
        try:
            return await loop.run_in_executor(None, _check)
        except Exception:
            return False
    
    async def find_wiki_url(self, title: str, alt_titles: list = None) -> Optional[str]:
        """
        Try to find the Fandom wiki URL for an anime title.
        
        Generates multiple candidate URLs from the title (and alt_titles),
        then checks each until one exists.
        
        Args:
            title: Primary title to search for
            alt_titles: Optional list of alternative titles (e.g., romaji, English)
        """
        # Build all candidate URLs from all titles
        seen_urls = set()
        candidates = []
        
        all_titles = [title] + (alt_titles or [])
        for t in all_titles:
            for url in guess_wiki_url_candidates(t):
                if url not in seen_urls:
                    seen_urls.add(url)
                    candidates.append(url)
        
        # Also add variations: strip suffixes, strip "the"
        for t in all_titles:
            t_lower = t.lower()
            variants = [
                re.sub(r'\s*(season \d+|part \d+|the movie|shippuden)$', '', t_lower, flags=re.IGNORECASE),
                re.sub(r'^the\s+', '', t_lower),
            ]
            for v in variants:
                if v != t_lower:
                    for url in guess_wiki_url_candidates(v):
                        if url not in seen_urls:
                            seen_urls.add(url)
                            candidates.append(url)
        
        # Try each candidate
        for url in candidates:
            if await self.check_wiki_exists(url):
                print(f"[Fandom] Found wiki: {url}")
                return url
        
        print(f"[Fandom] No wiki found after trying {len(candidates)} URLs for '{title}'")
        return None  # No wiki found
