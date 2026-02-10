"""Find all Belial/wife/Panacea references in transcript with context."""
import re

with open("transcript_dump.txt", "r", encoding="utf-8") as f:
    text = f.read()

# Split into messages
msgs = re.split(r'--- \[(\d+)\] (USER|ASSISTANT) ---', text)

# Rebuild as (msg_num, role, content) tuples  
messages = []
i = 1
while i < len(msgs) - 2:
    msg_num = int(msgs[i])
    role = msgs[i+1]
    content = msgs[i+2].strip()
    messages.append((msg_num, role, content))
    i += 3

print(f"Parsed {len(messages)} messages\n")

# Search terms
terms = ['belial', 'wife', 'panacea', 'gate-rot', 'gate rot', 'sick', 'holo', 'wish me luck', 'treatment', 'medicine', 'meds', 'entropy', 'facility', 'dose']

with open("belial_analysis.txt", "w", encoding="utf-8") as out:
    out.write("BELIAL/WIFE CONTINUITY ANALYSIS\n")
    out.write("=" * 80 + "\n\n")
    
    for msg_num, role, content in messages:
        content_lower = content.lower()
        found_terms = [t for t in terms if t in content_lower]
        
        if found_terms:
            out.write(f"\n{'='*60}\n")
            out.write(f"MSG [{msg_num}] {role} — Terms: {found_terms}\n")
            out.write(f"{'='*60}\n")
            
            # Extract relevant paragraphs (ones containing the terms)
            paragraphs = content.split('\n\n')
            for para in paragraphs:
                para_lower = para.lower()
                if any(t in para_lower for t in terms):
                    out.write(para.strip() + "\n\n")

print("Analysis written to belial_analysis.txt")
