Replaces `old_string` with `new_string` in `file_path`.

- `old_string` must match the file exactly, including whitespace.
- One match is replaced unless `expected_replacements` names a higher count; the call fails when the file holds a different number of matches.
