"""Canonicality context block — shared utility for narrative agents.

Formats Session Zero canonicality preferences (timeline_mode, canon_cast_mode,
event_fidelity) into actionable narrative directives. Called by Director,
KeyAnimator, and Pacing Agent prompt builders.

Returns empty string when all fields are None (custom/original worlds).
"""


# ---------------------------------------------------------------------------
# Directive tables
# ---------------------------------------------------------------------------

_TIMELINE_DIRECTIVES: dict[str, str] = {
    "canon_adjacent": (
        "The player exists in the SAME timeline as the source material. "
        "Canon events happen around them — reference the IP's world naturally. "
        "The player's story weaves alongside, not over, the original."
    ),
    "alternate": (
        "This is an ALTERNATE timeline — same world, different history. "
        "Canon events may have diverged. Use the IP's setting and rules, "
        "but don't assume canon played out identically."
    ),
    "inspired": (
        "This is an ORIGINAL story INSPIRED by the IP's world. "
        "No canon timeline constraints. Use the world's rules, "
        "aesthetics, and feel — but the story is entirely the player's."
    ),
}

_CAST_DIRECTIVES: dict[str, str] = {
    "full_cast": (
        "All canon characters EXIST and are active in this world. "
        "Reference them when narratively appropriate — they are part of this world."
    ),
    "replaced_protagonist": (
        "Canon characters exist EXCEPT the original protagonist — "
        "the PLAYER is the main character. Canon supporting cast may appear."
    ),
    "npcs_only": (
        "Canon characters are BACKGROUND NPCs only. "
        "They should NOT drive the plot or steal focus from the player's story."
    ),
}

_FIDELITY_DIRECTIVES: dict[str, str] = {
    "observable": (
        "Major canon events HAPPEN as in the source material. "
        "The player can witness them but CANNOT change their outcome."
    ),
    "influenceable": (
        "Major canon events happen, but the player CAN alter their outcome. "
        "Be prepared for divergence — the player's choices may rewrite history."
    ),
    "background": (
        "Canon events are distant background noise. "
        "Don't center them in the narrative — the player's story is independent."
    ),
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def format_canonicality_block(
    timeline_mode: str | None,
    canon_cast_mode: str | None,
    event_fidelity: str | None,
) -> str:
    """Format canonicality as a directive block for narrative agents.

    Returns empty string when all fields are None (custom/original worlds
    with no canonicality constraints).
    """
    if not any([timeline_mode, canon_cast_mode, event_fidelity]):
        return ""

    lines = ["## 📜 Canonicality Constraints"]
    lines.append(
        "These are the player's Session Zero choices about how this story "
        "relates to the source material. **Respect them.**"
    )

    if timeline_mode:
        directive = _TIMELINE_DIRECTIVES.get(timeline_mode, f"Timeline: {timeline_mode}")
        lines.append(f"\n**Timeline Mode — {timeline_mode}**")
        lines.append(directive)

    if canon_cast_mode:
        directive = _CAST_DIRECTIVES.get(canon_cast_mode, f"Cast: {canon_cast_mode}")
        lines.append(f"\n**Canon Cast — {canon_cast_mode}**")
        lines.append(directive)

    if event_fidelity:
        directive = _FIDELITY_DIRECTIVES.get(event_fidelity, f"Events: {event_fidelity}")
        lines.append(f"\n**Event Fidelity — {event_fidelity}**")
        lines.append(directive)

    return "\n".join(lines)
