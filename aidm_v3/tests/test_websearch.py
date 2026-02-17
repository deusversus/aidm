"""Test Anthropic web search directly."""
import asyncio
import os
import anthropic

async def test():
    client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    
    print("Testing web search with correct format...")
    print("=" * 60)
    
    try:
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=2048,
            messages=[{"role": "user", "content": "Research the anime Hellsing. What is the power system?"}],
            tools=[{
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": 5
            }]
        )
        print(f"Response type: {type(response)}")
        print(f"Content blocks: {len(response.content)}")
        for i, block in enumerate(response.content):
            print(f"  Block {i}: {block.type}")
            if hasattr(block, 'text'):
                print(f"    Text preview: {block.text[:200]}...")
    except Exception as e:
        print(f"ERROR: {type(e).__name__}: {e}")

if __name__ == "__main__":
    asyncio.run(test())
