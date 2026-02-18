"""Test alias matching fixes."""
import os
import sys

sys.path.append(os.getcwd())

from src.agents.profile_generator import load_existing_profile
from src.profiles.loader import find_profile_by_title, reload_alias_index

# Force rebuild alias index
print("Rebuilding alias index...")
reload_alias_index()

print("\n" + "="*60)
print("ALIAS MATCHING TESTS")
print("="*60 + "\n")

# Test 1: Full title should find demon_slayer
print("Test 1: Full title 'Demon Slayer: Kimetsu no Yaiba'")
r1 = find_profile_by_title('Demon Slayer: Kimetsu no Yaiba')
print(f"  Result: {r1}")
test1_pass = r1 is not None and r1[0] == 'demon_slayer'

# Test 2: Short title
print("\nTest 2: Short title 'demon slayer'")
r2 = find_profile_by_title('demon slayer')
print(f"  Result: {r2}")
test2_pass = r2 is not None and r2[0] == 'demon_slayer'

# Test 3: load_existing_profile with full title
print("\nTest 3: load_existing_profile('Demon Slayer: Kimetsu no Yaiba')")
r3 = load_existing_profile('Demon Slayer: Kimetsu no Yaiba')
profile_id = r3.get('id') if r3 else None
print(f"  Result: found={r3 is not None}, id={profile_id}")
test3_pass = profile_id == 'demon_slayer'

# Test 4: load_existing_profile with short title
print("\nTest 4: load_existing_profile('demon slayer')")
r4 = load_existing_profile('demon slayer')
profile_id = r4.get('id') if r4 else None
print(f"  Result: found={r4 is not None}, id={profile_id}")
test4_pass = profile_id == 'demon_slayer'

# Test 5: Token subset matching - movie title should match base profile
print("\nTest 5: Token subset 'Demon Slayer Mugen Train Movie'")
r5 = find_profile_by_title('Demon Slayer Mugen Train Movie')
print(f"  Result: {r5}")
test5_pass = r5 is not None and r5[0] == 'demon_slayer'

# ====== FALSE POSITIVE PREVENTION TESTS ======
print("\n" + "="*60)
print("FALSE POSITIVE PREVENTION TESTS")
print("="*60 + "\n")

# Test 6: Arifureta should NOT match Re:Zero (the original bug)
print("Test 6: 'Arifureta From Commonplace to Worlds Strongest' should NOT match Re:Zero")
r6 = find_profile_by_title('Arifureta From Commonplace to Worlds Strongest')
print(f"  Result: {r6}")
test6_pass = r6 is None or r6[0] != 're_zero'
if not test6_pass:
    print(f"  FAIL: Incorrectly matched to '{r6[0]}' instead of None")

# Test 7: Attack on Titan should not match a hypothetical "Titan" (if it existed)
print("\nTest 7: 'Attack on Titan' tokens should match exactly, not partial substring")
r7 = find_profile_by_title('Attack on Titan')
print(f"  Result: {r7}")
test7_pass = r7 is None or r7[0] == 'attack_on_titan'

# ====== TOKEN SUBSET TESTS ======
print("\n" + "="*60)
print("TOKEN SUBSET MATCHING TESTS")
print("="*60 + "\n")

# Test 8: Dragon Ball Z should match dragon_ball_z if exists, or dragon_ball via token subset
print("Test 8: 'Dragon Ball Z' token matching")
r8 = find_profile_by_title('Dragon Ball Z')
print(f"  Result: {r8}")
test8_pass = r8 is not None and 'dragon_ball' in r8[0]

# Test 9: Re:Zero should still match correctly
print("\nTest 9: 'Re:Zero' should match re_zero profile")
r9 = find_profile_by_title('Re:Zero')
print(f"  Result: {r9}")
test9_pass = r9 is not None and r9[0] == 're_zero'

# Test 10: Short single-word query shouldn't cause false matches
print("\nTest 10: 'Zero' alone should NOT match re_zero (too ambiguous)")
r10 = find_profile_by_title('Zero')
print(f"  Result: {r10}")
# "Zero" alone might match if there's an explicit alias, otherwise None is expected
test10_pass = r10 is None or (r10 is not None and r10[1] == "exact")

print("\n" + "="*60)
print("RESULTS")
print("="*60)
print(f"  Test 1 (full title):           {'PASS' if test1_pass else 'FAIL'}")
print(f"  Test 2 (short title):          {'PASS' if test2_pass else 'FAIL'}")
print(f"  Test 3 (load existing):        {'PASS' if test3_pass else 'FAIL'}")
print(f"  Test 4 (load short):           {'PASS' if test4_pass else 'FAIL'}")
print(f"  Test 5 (token subset movie):   {'PASS' if test5_pass else 'FAIL'}")
print(f"  Test 6 (Arifureta≠Re:Zero):    {'PASS' if test6_pass else 'FAIL'}")
print(f"  Test 7 (Attack on Titan):      {'PASS' if test7_pass else 'FAIL'}")
print(f"  Test 8 (Dragon Ball Z):        {'PASS' if test8_pass else 'FAIL'}")
print(f"  Test 9 (Re:Zero self):         {'PASS' if test9_pass else 'FAIL'}")
print(f"  Test 10 (Zero alone):          {'PASS' if test10_pass else 'FAIL'}")

all_pass = all([test1_pass, test2_pass, test3_pass, test4_pass, test5_pass,
                test6_pass, test7_pass, test8_pass, test9_pass, test10_pass])
print("\n" + ("ALL TESTS PASSED!" if all_pass else "SOME TESTS FAILED!"))

