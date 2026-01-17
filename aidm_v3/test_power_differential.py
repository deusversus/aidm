"""Test power differential system."""
from src.utils.power_utils import tier_to_number, calculate_power_differential, get_narrative_mode
from src.profiles.loader import get_effective_composition

# Test tier utilities
print("=== Tier Utilities ===")
print(f"T10 = {tier_to_number('T10')}")
print(f"T4 = {tier_to_number('T4')}")
print(f"T1 = {tier_to_number('T1')}")

# Test differential calculation
print("\n=== Power Differential ===")
print(f"T4 char in T8 world = {calculate_power_differential('T8', 'T4')} (expect 4)")
print(f"T8 char in T8 world = {calculate_power_differential('T8', 'T8')} (expect 0)")
print(f"T6 char in T8 world = {calculate_power_differential('T8', 'T6')} (expect 2)")

# Test narrative mode
print("\n=== Narrative Mode ===")
print(f"Diff 0 -> {get_narrative_mode(0)} (expect standard)")
print(f"Diff 2 -> {get_narrative_mode(2)} (expect blended)")
print(f"Diff 4 -> {get_narrative_mode(4)} (expect op_dominant)")

# Test get_effective_composition
print("\n=== Effective Composition ===")
profile_comp = {"tension_source": "consequence", "power_expression": "flashy", "narrative_focus": "ensemble"}

# Standard mode
result = get_effective_composition(profile_comp, "T8", "T8", False)
print(f"T8 in T8 (no OP): {result['mode']} | tension={result['tension_source']}")

# Blended mode
result = get_effective_composition(profile_comp, "T8", "T6", True, "existential", "sealed")
print(f"T6 in T8 (OP): {result['mode']} | tension={result['tension_source']}")

# OP Dominant
result = get_effective_composition(profile_comp, "T8", "T4", True, "burden", "hidden", "internal")
print(f"T4 in T8 (OP): {result['mode']} | tension={result['tension_source']} | focus={result['narrative_focus']}")

print("\n=== Tests Complete ===")
