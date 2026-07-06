## Output contract

You must return **exactly one JSON object** matching the schema you were given. No prose before or after. No markdown code fences. No explanation.

### Rules
- Every required field must be present and typed correctly.
- Optional fields may be omitted or set to `null`.
- Enum fields: use one of the enumerated values verbatim. Do not invent new values.
- Number fields have explicit ranges (usually `0–1` or `0–10`). Clamp to range.
- String fields that describe reasoning should be concise — one to three sentences unless the schema says otherwise. Long rambling rationales waste tokens and hide the decision.
- If you genuinely cannot decide, return your best guess with lower `confidence` (if the schema has it). Never return a schema-invalid response to signal uncertainty.

### When in doubt
- Re-read the schema.
- Re-read the input.
- Return a valid response with your best judgment.
