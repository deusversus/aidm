"""AIDM v3 CLI entry point."""

import asyncio
import sys

from rich.console import Console
from rich.panel import Panel
from rich.text import Text

from .config import Config
from .core.orchestrator import Orchestrator
from .db.session import init_db
from .llm import get_llm_manager

console = Console()


def print_banner():
    """Print the AIDM banner."""
    banner = Text()
    banner.append("AIDM v3", style="bold cyan")
    banner.append(" - Anime Interactive Dungeon Master\n", style="cyan")
    banner.append("Phase 1 MVP - Core Loop", style="dim")

    console.print(Panel(
        banner,
        border_style="cyan",
        padding=(0, 2)
    ))


def print_provider_info():
    """Print LLM provider information."""
    try:
        manager = get_llm_manager()
        provider = manager.primary_provider
        fast_model = manager.get_fast_model()
        creative_model = manager.get_creative_model()

        console.print(f"[dim]LLM Provider: [green]{provider}[/green][/dim]")
        console.print(f"[dim]Fast Model: {fast_model}[/dim]")
        console.print(f"[dim]Creative Model: {creative_model}[/dim]")

        # Show other available providers
        available = manager.list_available_providers()
        others = [p for p in available if p != provider]
        if others:
            console.print(f"[dim]Also available: {', '.join(others)}[/dim]")
    except Exception as e:
        console.print(f"[red]LLM Error: {e}[/red]")
        return False
    return True


def print_help():
    """Print available commands."""
    console.print("\n[dim]Commands:[/dim]")
    console.print("  [yellow]quit[/yellow]     - Exit the game")
    console.print("  [yellow]debug[/yellow]    - Toggle debug mode")
    console.print("  [yellow]context[/yellow]  - Show current game context")
    console.print("  [yellow]help[/yellow]     - Show this help\n")


async def game_loop(orchestrator: Orchestrator, debug_mode: bool = False):
    """Main game loop."""

    console.print(f"\n[green]Profile loaded: {orchestrator.profile.name}[/green]")
    console.print("[dim]Type 'help' for commands, 'quit' to exit[/dim]\n")

    # Print initial context
    console.print(Panel(
        orchestrator.get_context_summary(),
        title="[dim]Current Situation[/dim]",
        border_style="dim"
    ))
    console.print()

    current_debug = debug_mode

    while True:
        try:
            # Get player input
            player_input = console.input("[bold yellow]> [/bold yellow]")

            # Handle commands
            if player_input.lower() == "quit":
                break

            if player_input.lower() == "debug":
                current_debug = not current_debug
                console.print(f"[dim]Debug mode: {'ON' if current_debug else 'OFF'}[/dim]")
                continue

            if player_input.lower() == "help":
                print_help()
                continue

            if player_input.lower() == "context":
                console.print(Panel(
                    orchestrator.get_context_summary(),
                    title="[dim]Current Situation[/dim]",
                    border_style="dim"
                ))
                continue

            if not player_input.strip():
                continue

            # Process turn
            console.print("[dim]Processing...[/dim]")

            result = await orchestrator.process_turn(player_input)

            # Show debug info if enabled
            if current_debug:
                debug_text = (
                    f"[dim]Intent: {result.intent.intent} | "
                    f"Epicness: {result.intent.declared_epicness:.1f} | "
                    f"Outcome: {result.outcome.success_level} | "
                    f"Weight: {result.outcome.narrative_weight} | "
                    f"Latency: {result.latency_ms}ms[/dim]"
                )
                console.print(Panel(
                    debug_text,
                    title="[dim]Agent Decisions[/dim]",
                    border_style="dim"
                ))

            # Show narrative
            console.print(f"\n{result.narrative}\n")

        except KeyboardInterrupt:
            break
        except Exception as e:
            console.print(f"[red]Error: {e}[/red]")
            if current_debug:
                console.print_exception()


async def async_main():
    """Async main function."""

    print_banner()

    # Validate configuration
    issues = Config.validate()
    if issues:
        console.print("[red]Configuration issues:[/red]")
        for issue in issues:
            console.print(f"  [red]• {issue}[/red]")
        console.print("\n[dim]Copy .env.example to .env and configure your API keys.[/dim]")
        sys.exit(1)

    # Show provider info
    console.print()
    if not print_provider_info():
        sys.exit(1)
    console.print()

    # Initialize database
    console.print("[dim]Initializing database...[/dim]")
    init_db()

    # Create orchestrator with default campaign and profile
    # For MVP: hardcode campaign ID and profile
    orchestrator = Orchestrator(campaign_id=1, profile_id="hunterxhunter")

    try:
        await game_loop(orchestrator, debug_mode=Config.DEBUG)
    finally:
        orchestrator.close()

    console.print("\n[cyan]Session ended. Thanks for playing![/cyan]")


def main():
    """Entry point for the CLI."""
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
